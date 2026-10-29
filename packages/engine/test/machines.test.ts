import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MACHINE_PROTOCOL_VERSION, orgTopic, type ServerFrame, sealSecret, secretAad } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  authenticateMachine,
  createAgent,
  createMachineHub,
  declineSecret,
  deleteMachine,
  deliverSecret,
  drainOutbox,
  expireSecretRequests,
  ForbiddenError,
  getAgentComputer,
  grantScopes,
  listAgentSecrets,
  listMachines,
  MachineDroppedError,
  type MachineHub,
  MachineOfflineError,
  MachineRequestError,
  NotFoundError,
  postPersonMessage,
  receiveMachineUpload,
  removeAgentSecret,
  renameMachine,
  SERVER_STOP_TASK_GRACE_MS,
  type SecretRequestView,
  secretSite,
  setAgentComputerTarget,
  TASK_OFFLINE_GRACE_MS,
  type ToolContext,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { fakeRunner, pairMachine, RUNNER } from "./machine-fixtures";
import { until } from "./stream-fixtures";

let f: Fixture;
const hubs: MachineHub[] = [];
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.stop();
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub, publicUrl: "https://agentes.chat" });

function pair(actorId = f.owner.id, name = "Build box", exec = true) {
  return pairMachine(deps(), actorId, f.org.id, { name, ...RUNNER, exec });
}

type Request = Extract<ServerFrame, { type: "request" }>;

/** A `brain.turn` request (the fake runner never answers it by itself). */
const brainTurn = (runId = crypto.randomUUID()) => ({
  op: "brain.turn" as const,
  runId,
  kind: "claude_code" as const,
  session: { id: crypto.randomUUID(), resume: true },
  cwd: "",
  system: "",
  prompt: "oi",
  mcp: { token: `agr_${"x".repeat(32)}` },
});

/** Settles to "pending" when the promise is still open after `ms`. */
const within = <T>(p: Promise<T>, ms = 200) =>
  Promise.race([
    p.then(
      () => "resolved" as const,
      (e: unknown) => e,
    ),
    Bun.sleep(ms).then(() => "pending" as const),
  ]);

describe("a runner that dies mid-request (brain turns never stay working)", () => {
  test("a new socket for the same machine fails the old one's requests at once, even if its close never comes", async () => {
    f = await setup({ machines: true });
    const hub = f.machineHub as MachineHub;
    const paired = await pair();
    const old = fakeRunner(hub, { dead: true });
    await old.hello(paired.token);
    const turn = hub.call(paired.machineId, brainTurn());
    await Bun.sleep(5);
    expect(old.sent.some((s) => s.type === "request" && s.op === "brain.turn")).toBe(true);

    // The desktop app was reinstalled: the runner was killed mid-turn and a new one says hello.
    const fresh = fakeRunner(hub);
    await fresh.hello(paired.token);
    expect(await within(turn)).toBeInstanceOf(MachineOfflineError);
    expect(old.closed()).toMatchObject({ code: 4409 });
    expect((await hub.status(paired.machineId))?.online).toBe(true);
  });

  test("the caller on another replica learns it too: same replica replaced, or the runner back on another replica", async () => {
    f = await setup({ machines: true });
    const hubA = f.machineHub as MachineHub;
    const hubB = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-b", rpcPollMs: 10 });
    hubs.push(hubB);
    const paired = await pair();

    // Socket on A, turn asked from B (machine_rpc); the runner comes back on A.
    const first = fakeRunner(hubA, { dead: true });
    await first.hello(paired.token);
    const viaRpc = hubB.call(paired.machineId, brainTurn());
    await Bun.sleep(40);
    expect(first.sent.some((s) => s.type === "request" && s.op === "brain.turn")).toBe(true);
    const second = fakeRunner(hubA, { dead: true });
    await second.hello(paired.token);
    expect(await within(viaRpc, 300)).toBeInstanceOf(MachineOfflineError);

    // Socket on A, turn asked from B; the runner comes back on B: A drops its stale socket.
    const turn2 = hubB.call(paired.machineId, brainTurn());
    await Bun.sleep(40);
    expect(second.sent.some((s) => s.type === "request" && s.op === "brain.turn")).toBe(true);
    const third = fakeRunner(hubB);
    await third.hello(paired.token);
    expect(await within(turn2, 300)).toBeInstanceOf(MachineOfflineError);
    expect(second.closed()).toMatchObject({ code: 4409 });
    expect(hubA.isLocal(paired.machineId)).toBe(false);
    expect(hubB.isLocal(paired.machineId)).toBe(true);
  });

  test("a replica that holds the socket and dies: the caller stops waiting once the row says so", async () => {
    f = await setup({ machines: true });
    const hubB = createMachineHub({
      db: f.db,
      pubsub: f.pubsub,
      replicaId: "replica-b",
      rpcPollMs: 10,
      rpcLivenessMs: 20,
    });
    hubs.push(hubB);
    const paired = await pair();
    // A replica that never serves its machine_rpc rows (it is gone), still on the row.
    await f.db
      .update(schema.machines)
      .set({ online: true, connectedReplica: "gone", lastSeenAt: new Date(), protocol: MACHINE_PROTOCOL_VERSION })
      .where(eq(schema.machines.id, paired.machineId));
    const turn = hubB.call(paired.machineId, brainTurn());
    await Bun.sleep(40);
    expect(await within(turn, 20)).toBe("pending");
    // The runner reconnected to another replica.
    await f.db
      .update(schema.machines)
      .set({ connectedReplica: "replica-c" })
      .where(eq(schema.machines.id, paired.machineId));
    expect(await within(turn, 300)).toBeInstanceOf(MachineOfflineError);
    const [rpc] = await f.db.select().from(schema.machineRpc);
    expect(rpc?.status).toBe("failed");
  });

  test("no pong: the socket's requests fail and the machine goes offline even if its close never comes", async () => {
    f = await setup({ machines: true });
    const hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-p", heartbeatMs: 20 });
    hubs.push(hub);
    const paired = await pair();
    const runner = fakeRunner(hub, { dead: true });
    await runner.hello(paired.token);
    const turn = hub.call(paired.machineId, brainTurn());
    expect(await within(turn, 400)).toBeInstanceOf(MachineOfflineError);
    expect(runner.closed()).toMatchObject({ code: 4408 });
    const [row] = await f.db.select().from(schema.machines);
    expect(row).toMatchObject({ online: false, connectedReplica: null });
  });

  test("a silent runner is dropped two heartbeats after its last pong, as the runner drops a silent server", async () => {
    f = await setup({ machines: true });
    const hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-s", heartbeatMs: 100 });
    hubs.push(hub);
    const paired = await pair();
    const runner = fakeRunner(hub, { dead: true });
    await runner.hello(paired.token);
    const turn = hub.call(paired.machineId, brainTurn());
    // Gone at the second heartbeat (200 ms), not the fourth.
    expect(await within(turn, 300)).toBeInstanceOf(MachineDroppedError);
    expect(runner.closed()).toMatchObject({ code: 4408 });
  });

  test("a request cut by its socket closing fails as dropped (it may have run); our own stop says it is ours", async () => {
    f = await setup({ machines: true });
    const hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-d" });
    hubs.push(hub);
    const paired = await pair();
    const exec = { op: "exec" as const, command: "make deploy", timeoutSeconds: 60, stream: false };
    const runner = fakeRunner(hub, { exec: () => "hang" });
    await runner.hello(paired.token);
    const cut = hub.call(paired.machineId, exec);
    await Bun.sleep(5);
    await runner.disconnect();
    const error = await within(cut);
    expect(error).toBeInstanceOf(MachineDroppedError);
    expect(error).toMatchObject({ serverStop: false });
    expect((error as Error).message).toContain("may have had effects");
    // Nothing is sent to a computer that is away: offline, in the plain words.
    const away = await hub.call(paired.machineId, exec).catch((e: unknown) => e);
    expect(away).toBeInstanceOf(MachineOfflineError);
    expect(away).not.toBeInstanceOf(MachineDroppedError);

    // Our own stop: the same, marked as ours; its tasks get a long backstop instead of the usual grace.
    const again = fakeRunner(hub, { exec: () => "hang" });
    await again.hello(paired.token);
    const stopped = hub.call(paired.machineId, exec);
    await Bun.sleep(5);
    await hub.stop();
    expect(await within(stopped)).toMatchObject({ serverStop: true });
    const jobs = () => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "machine.tasks_offline"));
    await until(async () => (await jobs()).length === 2, "the stop's offline job");
    const graces = (await jobs()).map((j) => j.nextAttemptAt.getTime() - j.createdAt.getTime()).sort((a, b) => a - b);
    expect(graces[0]).toBeLessThan(TASK_OFFLINE_GRACE_MS + 5000);
    expect(graces[1]).toBeGreaterThan(SERVER_STOP_TASK_GRACE_MS - 5000);
  });

  test("the agent's process gone mid-request (`dropped` from the runner) is a drop, in the runner's words", async () => {
    f = await setup({ machines: true });
    const hub = f.machineHub as MachineHub;
    const paired = await pair();
    const runner = fakeRunner(hub);
    await runner.hello(paired.token);
    const turn = hub.call(paired.machineId, brainTurn());
    await Bun.sleep(5);
    const req = runner.sent.find((s) => s.type === "request" && s.op === "brain.turn") as Request;
    const message = "The agent's worker on this computer stopped while this ran.";
    await runner.frame({ type: "result", id: req.id, ok: false, error: { code: "dropped", message } });
    const error = await within(turn);
    expect(error).toBeInstanceOf(MachineDroppedError);
    expect((error as Error).message).toBe(message);
  });

  test("a hello that fails on our side closes the socket without a refusal, so the runner dials again", async () => {
    f = await setup({ machines: true });
    const hub = f.machineHub as MachineHub;
    const paired = await pair();
    const runner = fakeRunner(hub);
    // The database is away for a moment while the runner says hello.
    const db = f.db as unknown as Record<string, unknown>;
    db.select = () => {
      throw new Error("database away");
    };
    try {
      await runner.hello(paired.token);
    } finally {
      delete db.select;
    }
    expect(runner.sent).toEqual([]);
    expect(runner.closed()).toMatchObject({ code: 1011 });
    const back = fakeRunner(hub);
    await back.hello(paired.token);
    expect(back.sent[0]).toMatchObject({ type: "welcome", machineId: paired.machineId });
  });

  test("an mcp.call sent again under its callId runs once: the copy waits for the first answer", async () => {
    f = await setup({ machines: true });
    const hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-m", rpcPollMs: 10 });
    hubs.push(hub);
    let runs = 0;
    let finish = () => {};
    hub.setMissionHooks({
      mcp: async (_machineId, frame) => {
        runs++;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { ok: true, text: `posted: ${String(frame.args.text)}` };
      },
    });
    const paired = await pair();
    const call = { type: "mcp.call", callId: "call-1", taskId: "t", tool: "post_message", args: { text: "oi" } };
    const first = fakeRunner(hub);
    await first.hello(paired.token);
    await first.frame(call);
    await until(() => runs === 1, "the first run");
    // The link drops while it runs; the runner sends the call again on its new socket.
    const second = fakeRunner(hub);
    await second.hello(paired.token);
    await second.frame(call);
    await Bun.sleep(30);
    finish();
    await until(() => second.sent.some((s) => s.type === "mcp.result"), "the copy's answer");
    expect(runs).toBe(1);
    expect(second.sent.find((s) => s.type === "mcp.result")).toEqual({
      type: "mcp.result",
      callId: "call-1",
      ok: true,
      text: "posted: oi",
    });
    // Later copies get the same answer at once.
    await second.frame(call);
    await until(() => second.sent.filter((s) => s.type === "mcp.result").length === 2, "a later copy's answer");
    expect(runs).toBe(1);
  });

  test("a pong's browser traffic is stored with when it came, with or without a load (protocol 23)", async () => {
    f = await setup({ machines: true });
    const hub = f.machineHub as MachineHub;
    const paired = await pair();
    const runner = fakeRunner(hub);
    await runner.hello(paired.token);
    const row = async () =>
      (await f.db.select().from(schema.machines).where(eq(schema.machines.id, paired.machineId)))[0];
    const browserTraffic = { up: 4096, down: 1_250_000, hours: 0.2 };
    const before = Date.now();
    await runner.frame({ type: "pong", at: 1, browserTraffic });
    const stored = await row();
    expect(stored?.browserTraffic).toEqual({ ...browserTraffic, at: expect.any(String) });
    expect(Date.parse(stored?.browserTraffic?.at ?? "")).toBeGreaterThanOrEqual(before - 1000);
    expect(stored?.load).toBeNull();

    const load = { loadAvg: 0.1, loadPeak: 0.5, memoryAvg: 0.3, memoryPeak: 0.4, hours: 0.2 };
    const more = { up: 8192, down: 2_000_000, hours: 0.3 };
    await runner.frame({ type: "pong", at: 2, load, browserTraffic: more });
    expect(await row()).toMatchObject({ load: { ...load, at: expect.any(String) }, browserTraffic: more });
    // A pong without either keeps what the last one said; one out of bounds says nothing.
    await runner.frame({ type: "pong", at: 3, browserTraffic: { ...more, up: -5 } });
    expect((await row())?.browserTraffic).toMatchObject(more);
  });

  test("a tool switched on the machine holds now (exec on the row) and wakes what waited for it", async () => {
    f = await setup({ machines: true });
    const hub = f.machineHub as MachineHub;
    const woke: string[] = [];
    hub.setMissionHooks({ online: async (id) => void woke.push(id) });
    const paired = await pair();
    const runner = fakeRunner(hub, { execAllowed: false });
    await runner.hello(paired.token);
    await Bun.sleep(5);
    woke.length = 0;
    expect((await hub.status(paired.machineId))?.execAllowed).toBe(false);
    await runner.frame({
      type: "access.changed",
      access: { folders: [], tools: { claude: true, codex: false, commands: true } },
    });
    await Bun.sleep(5);
    expect(await hub.status(paired.machineId)).toMatchObject({
      execAllowed: true,
      access: { tools: { claude: true, commands: true } },
    });
    expect(woke).toEqual([paired.machineId]);
  });

  test("a brain turn that goes quiet fails; its own events and bridge calls keep a long one alive", async () => {
    f = await setup({ machines: true });
    const hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-i", brainIdleMs: 60 });
    hubs.push(hub);
    const paired = await pair();
    const runner = fakeRunner(hub);
    await runner.hello(paired.token);

    const quiet = hub.call(paired.machineId, brainTurn());
    const error = await within(quiet, 400);
    expect(error).toBeInstanceOf(MachineRequestError);
    expect((error as MachineRequestError).code).toBe("timeout");
    expect(runner.sent.some((s) => s.type === "cancel")).toBe(true);

    const runId = crypto.randomUUID();
    const alive = hub.call(paired.machineId, brainTurn(runId));
    await Bun.sleep(5);
    const req = [...runner.sent].reverse().find((s) => s.type === "request" && s.op === "brain.turn") as Request;
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(30);
      await runner.frame({ type: "brain.event", runId, event: { type: "text_delta", text: "." } });
      await Bun.sleep(30);
      // A permission prompt waiting for a person polls the bridge with the turn's token.
      await runner.frame({
        type: "mcp.call",
        callId: `c${i}`,
        taskId: "t",
        tool: "x",
        args: {},
        token: req.op === "brain.turn" ? req.mcp.token : "",
      });
    }
    await runner.frame({
      type: "result",
      id: req.id,
      ok: true,
      data: { runId, final: { type: "done", text: "ok" } },
    });
    expect(await alive).toMatchObject({ final: { type: "done" } });
  });
});

// Connecting a computer (the device-code flow) is covered in desktop.test.ts.
describe("pairing", () => {
  test("authenticateMachine: valid token only; deleting the machine revokes it", async () => {
    f = await setup();
    const paired = await pair();
    expect((await authenticateMachine(f.db, paired.token))?.id).toBe(paired.machineId);
    expect(await authenticateMachine(f.db, `${paired.token}x`)).toBeNull();
    expect(await authenticateMachine(f.db, "not-a-token")).toBeNull();
    await deleteMachine(deps(), f.owner.id, f.org.id, paired.machineId);
    expect(await authenticateMachine(f.db, paired.token)).toBeNull();
  });
});

describe("machines and targets", () => {
  test("a computer lists its agents in the order they came, as the agents' own list does", async () => {
    f = await setup();
    const qa = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "QA", handle: "qa" },
      { model: "claude-sonnet-5-5" },
    );
    const box = await pair();
    // The newer agent moves there first: the order its rows were written in isn't the one people see.
    await setAgentComputerTarget(deps(), f.owner.id, f.org.id, qa.id, box.machineId);
    await setAgentComputerTarget(deps(), f.owner.id, f.org.id, f.agent.id, box.machineId);
    const [machine] = await listMachines(f.db, f.owner.id, f.org.id);
    expect(machine?.agents.map((a) => a.handle)).toEqual(["dev", "qa"]);
  });

  test("list, rename and delete: every member sees them, only the pairer or an admin changes them", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const carl = await addMember(f.db, f.org.id, "member", "carl");
    const mine = await pair(bia.id, "Bia's laptop");
    await setAgentComputerTarget(deps(), f.owner.id, f.org.id, f.agent.id, mine.machineId);
    const seenByCarl = await listMachines(f.db, carl.id, f.org.id);
    expect(seenByCarl).toHaveLength(1);
    expect(seenByCarl[0]).toMatchObject({
      name: "Bia's laptop",
      online: false,
      os: "linux",
      execAllowed: true,
      pairedBy: { id: bia.id, name: "bia" },
      agents: [{ id: f.agent.id, handle: "dev" }],
      workspace: null,
      canManage: false,
      mode: "single",
    });
    expect((await listMachines(f.db, bia.id, f.org.id))[0]).toMatchObject({
      workspace: RUNNER.workspace,
      canManage: true,
    });
    // A runner in system mode (ADR 0057) says so at hello: each agent its own user, not the pairing folder.
    await f.db
      .update(schema.machines)
      .set({ executors: { mode: "system" } })
      .where(eq(schema.machines.id, mine.machineId));
    expect((await listMachines(f.db, carl.id, f.org.id))[0]?.mode).toBe("system");

    await expect(renameMachine(deps(), carl.id, f.org.id, mine.machineId, { name: "x" })).rejects.toThrow(
      ForbiddenError,
    );
    expect(await renameMachine(deps(), bia.id, f.org.id, mine.machineId, { name: "Laptop" })).toMatchObject({
      name: "Laptop",
    });
    await expect(deleteMachine(deps(), carl.id, f.org.id, mine.machineId)).rejects.toThrow(ForbiddenError);
    await deleteMachine(deps(), f.owner.id, f.org.id, mine.machineId);
    expect(await listMachines(f.db, bia.id, f.org.id)).toEqual([]);
    const [agent] = await f.db.select().from(schema.agents).where(eq(schema.agents.id, f.agent.id));
    expect(agent?.machineId).toBeNull();
    await expect(deleteMachine(deps(), f.owner.id, f.org.id, mine.machineId)).rejects.toThrow(NotFoundError);
  });

  test("target: admins, or the agent's owner with a machine they paired; announced as agent.computer", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const carl = await addMember(f.db, f.org.id, "member", "carl");
    await f.db.update(schema.agents).set({ ownerUserId: bia.id }).where(eq(schema.agents.id, f.agent.id));
    const biaBox = await pair(bia.id, "Bia's box");
    const anaBox = await pair(f.owner.id, "Ana's box");
    const events: Record<string, unknown>[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => events.push((e as { event?: Record<string, unknown> }).event ?? {}));

    await expect(setAgentComputerTarget(deps(), carl.id, f.org.id, f.agent.id, biaBox.machineId)).rejects.toThrow(
      ForbiddenError,
    );
    await expect(setAgentComputerTarget(deps(), bia.id, f.org.id, f.agent.id, anaBox.machineId)).rejects.toThrow(
      ForbiddenError,
    );
    expect(await setAgentComputerTarget(deps(), bia.id, f.org.id, f.agent.id, biaBox.machineId)).toEqual({
      kind: "machine",
      machineId: biaBox.machineId,
      name: "Bia's box",
      online: false,
    });
    expect(events.at(-1)).toMatchObject({ type: "agent.computer", agentId: f.agent.id, target: { kind: "machine" } });
    expect(await setAgentComputerTarget(deps(), bia.id, f.org.id, f.agent.id, null)).toEqual({ kind: "none" });
    expect(await setAgentComputerTarget(deps(), f.owner.id, f.org.id, f.agent.id, anaBox.machineId)).toMatchObject({
      kind: "machine",
    });
    await expect(setAgentComputerTarget(deps(), f.owner.id, f.org.id, f.agent.id, crypto.randomUUID())).rejects.toThrow(
      NotFoundError,
    );
    const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "agent.computer_target"));
    expect(audit).toHaveLength(3);

    // The computer API says which.
    expect(await getAgentComputer(f.db, f.owner.id, f.org.id, f.agent.id)).toMatchObject({
      target: { kind: "machine", name: "Ana's box" },
    });
  });
});

describe("hub", () => {
  test("no hello in time: the socket closes without a refusal, so the runner dials again", async () => {
    f = await setup({ machines: true });
    const hub = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-h", helloTimeoutMs: 20 });
    hubs.push(hub);
    const slow = fakeRunner(hub);
    await Bun.sleep(60);
    expect(slow.sent).toEqual([]);
    expect(slow.closed()).toMatchObject({ code: 4408 });
  });

  test("hello → welcome and online; bad token and outdated runners are refused", async () => {
    f = await setup({ machines: true });
    const hub = f.machineHub as MachineHub;
    const paired = await pair();
    const statuses: unknown[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => statuses.push((e as { event?: { type: string } }).event));

    const bad = fakeRunner(hub);
    await bad.hello("agm_wrong");
    expect(bad.sent).toEqual([{ type: "refused", reason: "invalid_token", message: expect.any(String) }]);
    expect(bad.closed()).toMatchObject({ code: 4401 });
    const old = fakeRunner(hub);
    await old.hello(paired.token, { protocol: 0 });
    expect(old.sent[0]).toMatchObject({ type: "refused", reason: "outdated" });

    const runner = fakeRunner(hub);
    await runner.hello(paired.token, { hostname: "new-host", exec: false });
    expect(runner.sent[0]).toEqual({
      type: "welcome",
      machineId: paired.machineId,
      name: "Build box",
      heartbeatMs: 25_000,
    });
    const [row] = await f.db.select().from(schema.machines);
    expect(row).toMatchObject({
      online: true,
      connectedReplica: "replica-a",
      hostname: "new-host",
      execAllowed: false,
    });
    expect(statuses).toContainEqual({ type: "machine.status", machineId: paired.machineId, online: true });
    expect(await hub.status(paired.machineId)).toMatchObject({ online: true, execAllowed: false });

    await runner.disconnect();
    const [after] = await f.db.select().from(schema.machines);
    expect(after).toMatchObject({ online: false, connectedReplica: null });
    expect(statuses).toContainEqual({ type: "machine.status", machineId: paired.machineId, online: false });
    await expect(hub.call(paired.machineId, { op: "list", path: "", depth: 1 })).rejects.toThrow(MachineOfflineError);
  });

  test("requests, live output, cancel, errors; a second runner replaces the first; delete closes it", async () => {
    f = await setup({ machines: true });
    const hub = f.machineHub as MachineHub;
    const paired = await pair();
    const runner = fakeRunner(hub, {
      exec(req, out) {
        if (req.command === "sleep") return "hang";
        out("stdout", "half ");
        out("stdout", "done");
        return { exitCode: 0, stdout: "half done", stderr: "" };
      },
    });
    await runner.hello(paired.token);
    const chunks: string[] = [];
    const r = await hub.call(
      paired.machineId,
      { op: "exec", command: "echo", timeoutSeconds: 5, stream: true },
      { onOutput: (_s, c) => chunks.push(c) },
    );
    expect(r).toMatchObject({ exitCode: 0, stdout: "half done" });
    expect(chunks.join("")).toBe("half done");

    const controller = new AbortController();
    const pending = hub.call(
      paired.machineId,
      { op: "exec", command: "sleep", timeoutSeconds: 60, stream: false },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 10);
    expect(await pending).toMatchObject({ exitCode: 130, canceled: { killed: true } });
    expect(runner.sent.some((s) => s.type === "cancel")).toBe(true);

    await expect(
      hub.call(paired.machineId, { op: "push", path: "nope", url: "u", uploadId: "x", maxBytes: 1 }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      hub.call(paired.machineId, { op: "exec", command: "sleep", timeoutSeconds: 1, stream: false }, { timeoutMs: 30 }),
    ).rejects.toThrow(MachineRequestError);

    const second = fakeRunner(hub);
    await second.hello(paired.token);
    expect(runner.sent.at(-1)).toMatchObject({ type: "refused", reason: "replaced" });
    expect(runner.closed()).toMatchObject({ code: 4409 });
    // The old socket closing doesn't mark it offline: the new one holds it.
    expect((await hub.status(paired.machineId))?.online).toBe(true);

    await deleteMachine(deps(), f.owner.id, f.org.id, paired.machineId);
    await Bun.sleep(5);
    expect(second.sent.at(-1)).toMatchObject({ type: "refused", reason: "revoked" });
    expect(second.closed()).toMatchObject({ code: 4403 });
  });

  test("another replica reaches the machine through machine_rpc and pub/sub", async () => {
    f = await setup({ machines: true });
    const hubA = f.machineHub as MachineHub;
    const hubB = createMachineHub({ db: f.db, pubsub: f.pubsub, replicaId: "replica-b", rpcPollMs: 20 });
    hubs.push(hubB);
    const paired = await pair();
    const runner = fakeRunner(hubA);
    await runner.hello(paired.token);
    runner.files.set("notes.txt", new TextEncoder().encode("hi"));

    expect(await hubB.status(paired.machineId)).toMatchObject({ online: true });
    const read = await hubB.call(paired.machineId, { op: "read", path: "notes.txt", maxBytes: 100 });
    expect(Buffer.from(read.base64 ?? "", "base64").toString()).toBe("hi");
    const exec = await hubB.call(paired.machineId, { op: "exec", command: "uname", timeoutSeconds: 5, stream: true });
    expect(exec).toMatchObject({ exitCode: 0, stdout: "ran: uname" });
    await expect(hubB.call(paired.machineId, { op: "read", path: "../x", maxBytes: 1 })).resolves.toMatchObject({
      base64: null,
    });
    const rows = await f.db.select().from(schema.machineRpc);
    expect(rows.every((r) => r.status === "done" && r.orgId === f.org.id)).toBe(true);
    expect(rows).toHaveLength(3);

    await runner.disconnect();
    await expect(hubB.call(paired.machineId, { op: "list", path: "", depth: 1 })).rejects.toThrow(MachineOfflineError);
  });

  test("a row left online by a replica that died is offline once stale", async () => {
    f = await setup({ machines: true });
    const hub = f.machineHub as MachineHub;
    const paired = await pair();
    await f.db
      .update(schema.machines)
      .set({ online: true, connectedReplica: "dead", lastSeenAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(schema.machines.id, paired.machineId));
    expect((await hub.status(paired.machineId))?.online).toBe(false);
    expect((await listMachines(f.db, f.owner.id, f.org.id))[0]?.online).toBe(false);
    await expect(hub.call(paired.machineId, { op: "list", path: "", depth: 1 })).rejects.toThrow(MachineOfflineError);
  });
});

describe("tools on a connected machine", () => {
  const SANDBOX = [{ connectionId: null, scope: "sandbox:run" }];

  async function runCtx(): Promise<ToolContext> {
    const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev oi",
    });
    await drainOutbox(f.db, f.handlers);
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, msg.id));
    if (!run) throw new Error("no run");
    return {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run.id,
      channelId: f.general.id,
      threadRootId: run.threadRootId,
      triggerMessageId: msg.id,
    };
  }
  const call = async (ctx: ToolContext, name: string, input: Record<string, unknown>) => {
    const outcome = await f.tools?.invoke(ctx, { toolUseId: crypto.randomUUID(), name, input });
    if (outcome?.type !== "result") throw new Error(`expected a result, got ${outcome?.type}`);
    return outcome.output;
  };

  test("run_code, files and upload_file go to the machine; offline is explained", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    const hub = f.machineHub as MachineHub;
    await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
    const paired = await pair();
    const commands: string[] = [];
    const runner = fakeRunner(hub, {
      exec(req) {
        commands.push(req.command);
        return { exitCode: 0, stdout: "42\n", stderr: "" };
      },
      async push(req, bytes, name) {
        await receiveMachineUpload(
          { db: f.db, artifacts: f.artifactDeps, pubsub: f.pubsub },
          {
            uploadId: req.uploadId,
            machineId: paired.machineId,
            name,
            contentType: "application/pdf",
            sha256: createHash("sha256").update(bytes).digest("hex"),
            body: bytes,
          },
        );
      },
    });
    await runner.hello(paired.token);
    const ctx = await runCtx();

    // Without a machine: a clear refusal.
    const none = await call(ctx, "run_code", { language: "python", code: "print(42)" });
    expect(none).toMatchObject({ isError: true });
    expect(none.content).toContain("You have no computer");

    await setAgentComputerTarget(deps(), f.owner.id, f.org.id, f.agent.id, paired.machineId);
    const listed = await f.tools?.list(ctx);
    const runCode = listed?.find((t) => t.name === "run_code");
    expect(runCode?.description).toContain('connected computer "Build box"');
    // Claude Code keeps one session per conversation, and connected computers allow an hour.
    expect(runCode?.description).toContain(`claude -p --session-id ${ctx.threadRootId}`);
    expect(runCode?.description).toContain(`claude -p --resume ${ctx.threadRootId}`);
    expect(runCode?.description).toContain("at most 3600 s");
    expect(runCode?.inputSchema).toMatchObject({ properties: { timeout_seconds: { maximum: 3600 } } });

    const out = await call(ctx, "run_code", { language: "python", code: "print(42)" });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("exit code 0");
    expect(commands.at(-1)).toMatch(/^python3 \.agentes\/run-\d+\.py$/);
    const audit = await f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "machine.exec"));
    expect(audit[0]?.details).toMatchObject({ command: "python: print(42)", exitCode: 0 });

    expect((await call(ctx, "write_file", { path: "out/r.pdf", content: "%PDF-1.4 fake" })).isError).toBeFalsy();
    expect((await call(ctx, "read_file", { path: "out/r.pdf" })).content).toContain("%PDF-1.4 fake");
    const up = await call(ctx, "upload_file", { path: "out/r.pdf", title: "Relatório" });
    expect(up.isError).toBeFalsy();
    expect(up.content).toContain('as "Relatório" (file');
    const [row] = await f.db.select().from(schema.artifactUploads);
    expect(row).toMatchObject({ status: "done", machineId: paired.machineId, computer: `machine:${paired.machineId}` });
    expect(runner.sent.find((s) => s.type === "request" && s.op === "push")).toMatchObject({
      url: `http://localhost:3000/api/machines/uploads/${row?.id}`,
    });
    // Every request says which agent it's for (the runner keeps each agent in its own folder) and its name (protocol 9).
    const requests = runner.sent.filter((s) => s.type === "request");
    expect(requests.length).toBeGreaterThan(3);
    for (const r of requests) expect(r.agent).toEqual({ id: f.agent.id, handle: "dev", name: "Dev" });

    const status = await call(ctx, "computer_status", {});
    expect(status.content).toContain('connected computer "Build box" (Linux), online');
    expect(status.content).not.toContain(RUNNER.workspace);
    // No tool turns a computer on or off (ADR 0077): only computer_status.
    expect(listed?.filter((t) => t.name.startsWith("computer_")).map((t) => t.name)).toEqual(["computer_status"]);

    // The workspace's own computer is always on.
    const kind = (k: "managed" | "connected") =>
      f.db.update(schema.machines).set({ kind: k }).where(eq(schema.machines.id, paired.machineId));
    await kind("managed");
    expect((await call(ctx, "computer_status", {})).content).toContain(
      `You are on "Build box", this workspace's own computer (Linux), always on: answering now.`,
    );
    const ownRunCode = (await f.tools?.list(ctx))?.find((t) => t.name === "run_code");
    expect(ownRunCode?.description).toContain(`Runs on "Build box" (Linux), this workspace's own computer, always on`);
    await kind("connected");

    await runner.disconnect();
    const offline = await call(ctx, "run_code", { language: "bash", code: "ls" });
    expect(offline).toMatchObject({ isError: true });
    expect(offline.content).toContain("The computer Build box is offline. Ask its owner to start the runner.");
    // The workspace's own computer has no runner for anyone to start: it comes back by itself.
    await kind("managed");
    const away = await call(ctx, "run_code", { language: "bash", code: "ls" });
    expect(away.content).toContain(
      "The computer Build box isn't answering right now; it usually comes back within minutes.",
    );
    expect(away.content).not.toContain("runner");
  });

  test("commands turned off on the machine are explained", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
    const paired = await pair(f.owner.id, "Files only", false);
    const runner = fakeRunner(f.machineHub as MachineHub, { execAllowed: false });
    await runner.hello(paired.token);
    await setAgentComputerTarget(deps(), f.owner.id, f.org.id, f.agent.id, paired.machineId);
    const ctx = await runCtx();
    const out = await call(ctx, "run_code", { language: "bash", code: "ls" });
    expect(out).toMatchObject({ isError: true });
    expect(out.content).toContain("Commands are turned off on the computer Files only");
    const listed = await f.tools?.list(ctx);
    expect(listed?.find((t) => t.name === "run_code")?.description).not.toContain("claude -p");
    // Files still work.
    expect((await call(ctx, "write_file", { path: "a.txt", content: "x" })).isError).toBeFalsy();
  });

  test("a runner too old for agent folders is refused instead of sharing one folder", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
    const paired = await pair();
    const runner = fakeRunner(f.machineHub as MachineHub);
    await runner.hello(paired.token, { protocol: 1 });
    await setAgentComputerTarget(deps(), f.owner.id, f.org.id, f.agent.id, paired.machineId);
    const ctx = await runCtx();
    const out = await call(ctx, "write_file", { path: "a.txt", content: "x" });
    expect(out).toMatchObject({ isError: true });
    expect(out.content).toContain("agentes-runner update");
    expect(runner.sent.filter((s) => s.type === "request")).toEqual([]);
  });
});

describe("secrets for a connected machine (ADR 0027)", () => {
  const SANDBOX = [{ connectionId: null, scope: "sandbox:run" }];
  const VALUE = "npm_s3cr3t_value_0123456789";

  /** An agent that asks for NPM_TOKEN when told "publica", then says what it got. */
  async function asking(
    target: ({ target: "env" } | { target: "file"; path: string }) & { site?: string } = { target: "env" },
  ) {
    f = await setup({
      machines: true,
      reply: (req) => {
        const last = JSON.stringify(req.messages.at(-1)?.content);
        if (last.includes("tool_result")) return { chunks: ["Pronto."] };
        if (last.includes("publica")) {
          return {
            chunks: ["Preciso do token do npm."],
            toolUses: [
              { name: "request_secret", input: { name: "NPM_TOKEN", purpose: "publicar o pacote no npm", ...target } },
            ],
          };
        }
        return { chunks: ["ok"] };
      },
    });
    await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
    const paired = await pair();
    const runner = fakeRunner(f.machineHub as MachineHub);
    await runner.hello(paired.token);
    await setAgentComputerTarget(deps(), f.owner.id, f.org.id, f.agent.id, paired.machineId);
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev publica o pacote",
    });
    await drainOutbox(f.db, f.handlers);
    const [row] = await f.db.select().from(schema.secretRequests);
    if (!row) throw new Error("no secret request");
    return { paired, runner, row };
  }

  const seal = async (view: {
    id: string;
    publicKey: string | null;
    name: string;
    target: SecretRequestView["target"];
  }) =>
    sealSecret(
      view.publicKey as string,
      VALUE,
      secretAad({ requestId: view.id, orgId: f.org.id, name: view.name, target: view.target }),
    );

  test("the run waits on a card; only the person asked delivers; the value reaches the machine and nothing else", async () => {
    const { runner, row, paired } = await asking();
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run?.status).toBe("waiting_input");
    expect(row).toMatchObject({
      status: "pending",
      name: "NPM_TOKEN",
      requestedForUserId: f.owner.id,
      machineId: paired.machineId,
    });
    // The key was made on the machine, for this agent.
    expect(runner.sent.find((x) => x.type === "request" && x.op === "secret")).toMatchObject({
      action: "keypair",
      requestId: row.id,
      agent: { id: f.agent.id, handle: "dev" },
    });
    const [card] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, row.messageId as string));
    expect((card?.meta as { secretRequest?: SecretRequestView } | undefined)?.secretRequest).toMatchObject({
      status: "pending",
      name: "NPM_TOKEN",
      purpose: "publicar o pacote no npm",
      publicKey: row.publicKey,
    });

    const view = { id: row.id, publicKey: row.publicKey, name: row.name, target: { kind: "env" as const } };
    const sandbox = { ...(f.sandboxDeps as NonNullable<typeof f.sandboxDeps>), pubsub: f.pubsub };
    // Someone else in the channel: the request doesn't exist for them.
    const bia = await addMember(f.db, f.org.id, "admin", "bia");
    await expect(deliverSecret(sandbox, bia.id, f.org.id, row.id, await seal(view))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    // A box sealed for another request doesn't open on the machine.
    const wrong = await sealSecret(row.publicKey, VALUE, "agentes-secret|v1|other|org|NPM_TOKEN|env");
    await expect(deliverSecret(sandbox, f.owner.id, f.org.id, row.id, wrong)).rejects.toThrow("couldn't be opened");

    const delivered = await deliverSecret(sandbox, f.owner.id, f.org.id, row.id, await seal(view));
    expect(delivered).toMatchObject({ status: "delivered", publicKey: null });
    expect(runner.secrets.get("NPM_TOKEN")).toBe(VALUE);
    await expect(deliverSecret(sandbox, f.owner.id, f.org.id, row.id, await seal(view))).rejects.toThrow(
      "already answered",
    );

    await drainOutbox(f.db, f.handlers);
    const [done] = await f.db.select().from(schema.agentRuns);
    expect(done?.status).toBe("done");
    const steps = await f.db.select().from(schema.agentRunSteps);
    const result = steps.find((x) => x.kind === "tool_result")?.data as { content: string };
    expect(result.content).toContain("NPM_TOKEN was delivered to your computer");

    // Nowhere in our database: messages, steps, transcript, audit, outbox.
    const everything = JSON.stringify([
      await f.db.select().from(schema.messages),
      steps,
      await f.db.select().from(schema.agentRuns),
      await f.db.select().from(schema.auditLog),
      await f.db.select().from(schema.outbox),
      await f.db.select().from(schema.secretRequests),
    ]);
    expect(everything).not.toContain(VALUE);
    const actions = (await f.db.select().from(schema.auditLog)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["secret.requested", "secret.delivered"]));

    // Listed by name for the owner; removed from the machine on request.
    expect(await listAgentSecrets(f.db, f.owner.id, f.org.id, f.agent.id)).toEqual([
      expect.objectContaining({ name: "NPM_TOKEN", target: { kind: "env" }, machineId: paired.machineId }),
    ]);
    await removeAgentSecret(
      f.sandboxDeps as NonNullable<typeof f.sandboxDeps>,
      f.owner.id,
      f.org.id,
      f.agent.id,
      "NPM_TOKEN",
      paired.machineId,
    );
    expect(runner.secrets.has("NPM_TOKEN")).toBe(false);
    expect(await listAgentSecrets(f.db, f.owner.id, f.org.id, f.agent.id)).toEqual([]);
  });

  test("declined or expired: the run goes on without it, and the machine drops the key", async () => {
    const { runner, row } = await asking();
    await declineSecret({ db: f.db, pubsub: f.pubsub, sandbox: f.sandboxDeps }, f.owner.id, f.org.id, row.id);
    expect(runner.keys.has(row.id)).toBe(false);
    await drainOutbox(f.db, f.handlers);
    const steps = await f.db.select().from(schema.agentRunSteps);
    expect((steps.find((x) => x.kind === "tool_result")?.data as { content: string } | undefined)?.content).toContain(
      "declined",
    );

    // A second request nobody answers: closed after 15 minutes.
    await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev publica de novo",
    });
    await drainOutbox(f.db, f.handlers);
    expect(await expireSecretRequests({ db: f.db, pubsub: f.pubsub }, new Date(Date.now() + 16 * 60_000))).toBe(1);
    await drainOutbox(f.db, f.handlers);
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs.every((r) => r.status === "done")).toBe(true);
  });

  test("a browser password names its site: kept as the origin, shown to the person in the purpose", async () => {
    const { row } = await asking({ target: "env", site: "dashboard.stripe.com/login" });
    expect(row.site).toBe("https://dashboard.stripe.com");
    expect(row.purpose).toBe("publicar o pacote no npm (dashboard.stripe.com)");
    expect(secretSite("https://a.example:8443/x")).toBe("https://a.example:8443");
    expect(secretSite("file:///etc/passwd")).toBeNull();
    expect(secretSite("not a site")).toBeNull();
  });

  test("a runner older than protocol 3 is told to update", async () => {
    f = await setup({ machines: true, reply: () => ({ chunks: ["ok"] }) });
    await grantScopes(f.db, f.org.id, f.agent.id, SANDBOX);
    const paired = await pair();
    const runner = fakeRunner(f.machineHub as MachineHub);
    await runner.hello(paired.token, { protocol: 2 });
    await setAgentComputerTarget(deps(), f.owner.id, f.org.id, f.agent.id, paired.machineId);
    const msg = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev oi",
    });
    await drainOutbox(f.db, f.handlers);
    const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, msg.id));
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: run?.id as string,
      channelId: f.general.id,
      threadRootId: run?.threadRootId as string,
      triggerMessageId: msg.id,
    };
    const ask = { name: "NPM_TOKEN", purpose: "publicar", target: "env" };
    const old = await f.tools?.invoke(ctx, { toolUseId: "t1", name: "request_secret", input: ask });
    expect(old).toMatchObject({ type: "result", output: { isError: true } });
    expect(old?.type === "result" && old.output.content).toContain("agentes-runner update");
  });
});
