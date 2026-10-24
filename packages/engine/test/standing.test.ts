import { afterEach, describe, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, orgTopic, type ServerFrame } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  acceptInvitation,
  assertCanWork,
  createFakeJudge,
  createInvitation,
  createInviteLink,
  createOrganization,
  drainOutbox,
  type MachineHub,
  OrgPausedError,
  postPersonMessage,
  type RouterStrategy,
  requirePermission,
  resendInvitation,
  routeMessage,
  runErrorDetail,
  setOrgStanding,
  standingJudge,
} from "../src";
import { addUser, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";
import { channelRoutine, fire, routineRow } from "./routine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const REASON = "Unpaid invoice";
const standing = (state: "active" | "hold" | "suspended", notice: "shown" | "silent" = "shown") =>
  setOrgStanding({ db: f.db, pubsub: f.pubsub }, f.org.id, { state, reason: REASON, note: "card declined", notice });
const post = (body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
const runs = () => f.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);
const audits = () =>
  f.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "organization.standing_changed"));
const standingNotices = () =>
  f.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "org_standing"));

describe("hold", () => {
  test("a run fails before the model is called and says why; back to active the agent answers", async () => {
    f = await setup({ reply: () => ({ chunks: ["On it."] }) });
    const events = f.listen(f.general.id);
    await standing("hold");

    await post("@dev can you check the build?");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(0);
    const [failed] = await runs();
    expect(failed).toMatchObject({ status: "failed", error: `This workspace is on hold: ${REASON}` });
    expect(runErrorDetail(failed?.error)).toEqual({ errorCode: "run.org_paused", errorParams: { reason: REASON } });
    expect(events.find((e) => e.type === "run.finished")).toMatchObject({
      status: "failed",
      errorCode: "run.org_paused",
    });

    // Any other way to the model is refused too.
    const call = { orgId: f.org.id, system: "x", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 50 };
    await expect(f.gateway.stream({ ...call, agentId: f.agent.id, onDelta: () => {} })).rejects.toBeInstanceOf(
      OrgPausedError,
    );
    await expect(f.gateway.complete({ ...call, kind: "summary", model: "claude-haiku-5-5" })).rejects.toMatchObject({
      code: "org.paused",
      params: { reason: REASON },
    });
    expect(f.provider.calls).toHaveLength(0);
    // People still work there.
    expect(await requirePermission(f.db, f.owner.id, f.org.id, "manage_agents")).toMatchObject({ role: "owner" });

    await standing("active");
    await post("@dev and now?");
    await drainOutbox(f.db, f.handlers);
    expect(f.provider.calls).toHaveLength(1);
    expect((await runs()).map((r) => r.status)).toEqual(["failed", "done"]);
  });

  test("a routine's slot is skipped, the routine stays on its schedule", async () => {
    f = await setup();
    const routine = await channelRoutine(f);
    await standing("hold", "silent");
    expect(await fire(f, routine.id, new Date())).toMatchObject({
      status: "skipped",
      code: "org_paused",
      agentRunId: null,
    });
    expect(await routineRow(f, routine.id)).toMatchObject({ active: true, pausedReason: null });
    expect(await runs()).toHaveLength(0);

    await standing("active");
    expect((await fire(f, routine.id, new Date())).agentRunId).not.toBeNull();
  });

  test("the router and the judge ask nothing (they bill the server)", async () => {
    f = await setup();
    const message = await post("anyone around?");
    const decided: string[] = [];
    const strategy: RouterStrategy = {
      name: "spy",
      decide: async (input) => {
        decided.push(input.message.body);
        return { agents: [] };
      },
    };
    const judge = createFakeJudge(() => 1);
    const guarded = standingJudge(f.db, judge);
    const ask = () =>
      guarded.ask({
        orgId: f.org.id,
        kind: "stop_request",
        state: { message: "para" },
        questions: { stop: { type: "noul", instructions: "Stop?", criteria: { true: "yes", false: "no" } } },
      });
    await standing("hold");

    const routed = await routeMessage(
      { db: f.db, strategy, policy: { minScore: 0.5, maxAgents: 2, maxHops: 3 } },
      { orgId: f.org.id, messageId: message.id },
    );
    expect(routed).toEqual({ runs: [], skipped: "org_paused" });
    expect(decided).toEqual([]);
    await expect(ask()).rejects.toBeInstanceOf(OrgPausedError);
    expect(judge.calls).toHaveLength(0);

    await standing("active");
    expect((await ask()).stop?.noul).toBe(1);
  });

  test("computers: new work and bridge calls are refused, following running work goes on", async () => {
    f = await setup({ machines: true });
    const hub = f.machineHub as MachineHub;
    const paired = await pairMachine({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, {
      name: "MacBook",
      ...RUNNER,
    });
    const runner = fakeRunner(hub);
    await runner.hello(paired.token);
    const ls = () => hub.call(paired.machineId, { op: "exec", command: "ls", timeoutSeconds: 5, stream: false });
    await standing("hold", "silent");

    await expect(ls()).rejects.toMatchObject({
      code: "org.paused",
      message: "Agents in this workspace are paused for now.",
    });
    expect(runner.requests().some((r) => r.op === "exec")).toBe(false);
    expect(await hub.call(paired.machineId, { op: "task.output", taskId: crypto.randomUUID(), tail: 10 })).toEqual({
      lines: [],
      truncated: false,
    });
    await runner.send({ type: "mcp.call", callId: "call-1", taskId: "task-1", tool: "post_message", args: {} });
    const answer = await runner.answer("call-1");
    expect(answer).toMatchObject({ type: "mcp.result", ok: false, error: { code: "org.paused" } });

    await standing("active");
    expect(await ls()).toMatchObject({ exitCode: 0 });
  });
});

describe("suspended", () => {
  test("every permission check refuses with org.suspended; back to active it works", async () => {
    f = await setup();
    await standing("suspended");
    const refused = requirePermission(f.db, f.owner.id, f.org.id, "read");
    await expect(refused).rejects.toBeInstanceOf(OrgPausedError);
    await expect(refused).rejects.toMatchObject({ code: "org.suspended", params: { reason: REASON } });
    await expect(post("hello?")).rejects.toMatchObject({ code: "org.suspended" });
    await expect(assertCanWork(f.db, f.org.id)).rejects.toMatchObject({ code: "org.suspended" });

    await standing("suspended", "silent");
    await expect(requirePermission(f.db, f.owner.id, f.org.id, "read")).rejects.toMatchObject({
      code: "org.suspended",
      message: "This workspace is unavailable for now.",
      params: undefined,
    });

    await standing("active");
    expect(await requirePermission(f.db, f.owner.id, f.org.id, "read")).toMatchObject({ role: "owner" });
    expect(await post("hello again")).toMatchObject({ body: "hello again" });
  });

  test("invitations: none go out, are resent or accepted; its people start no other workspace", async () => {
    f = await setup();
    const bia = await addUser(f.db, "bia");
    const sent = await createInvitation(f.db, f.owner.id, f.org.id, { email: bia.email, role: "member" });
    await standing("hold");

    for (const refused of [
      () => createInvitation(f.db, f.owner.id, f.org.id, { email: "carl@example.com", role: "member" }),
      () => createInviteLink(f.db, f.owner.id, f.org.id),
      () => resendInvitation(f.db, f.owner.id, f.org.id, sent.invitation.id),
      () => acceptInvitation(f.db, bia, sent.token),
    ]) {
      await expect(refused()).rejects.toMatchObject({ code: "org.paused" });
    }
    await expect(createOrganization(f.db, f.owner.id, { name: "Acme 2" })).rejects.toMatchObject({
      code: "org.create_refused",
    });
    // Someone who isn't in it still can.
    expect((await createOrganization(f.db, bia.id, { name: "Bia's" })).organization.name).toBe("Bia's");

    await standing("active");
    expect(await acceptInvitation(f.db, bia, sent.token)).toEqual({ orgId: f.org.id });
    expect((await createOrganization(f.db, f.owner.id, { name: "Acme 2" })).organization.name).toBe("Acme 2");
  });
});

describe("notice", () => {
  test("shown: audit row (actor system), notification to owners and admins, members hear the reason", async () => {
    f = await setup();
    const events: unknown[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => events.push(e));
    const set = await standing("hold");
    expect(set).toMatchObject({ state: "hold", reason: REASON, note: "card declined", notice: "shown" });
    expect(set?.changedAt).toBeInstanceOf(Date);

    expect(await audits()).toMatchObject([
      {
        actorType: "system",
        actorId: null,
        targetId: f.org.id,
        details: { from: "active", to: "hold", reason: REASON },
      },
    ]);
    expect(await standingNotices()).toMatchObject([{ userId: f.owner.id, latest: { statusTo: "hold", text: REASON } }]);
    expect(events).toEqual([
      {
        type: "org.broadcast",
        orgId: f.org.id,
        event: { type: "org.standing", orgId: f.org.id, state: "hold", reason: REASON },
      },
    ]);

    // The same again tells nobody anything new.
    await standing("hold");
    expect(await audits()).toHaveLength(1);
    expect(await standingNotices()).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  test("silent: generic text, no audit row, no notification, no reason, not the note", async () => {
    f = await setup();
    const events: unknown[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => events.push(e));
    await standing("hold", "silent");

    const error = await assertCanWork(f.db, f.org.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OrgPausedError);
    expect(error).toMatchObject({ code: "org.paused", message: "Agents in this workspace are paused for now." });
    expect((error as OrgPausedError).params).toBeUndefined();
    expect(runErrorDetail((error as OrgPausedError).message)).toEqual({ errorCode: "run.org_paused" });
    expect(await audits()).toHaveLength(0);
    expect(await standingNotices()).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain(REASON);
    expect(JSON.stringify(events)).not.toContain("card declined");
    expect(events).toEqual([
      {
        type: "org.broadcast",
        orgId: f.org.id,
        event: { type: "org.standing", orgId: f.org.id, state: "hold", reason: null },
      },
    ]);

    expect(
      await setOrgStanding({ db: f.db }, crypto.randomUUID(), { state: "hold", reason: REASON, notice: "silent" }),
    ).toBeNull();
  });
});

const RUNNER = {
  hostname: "mac",
  os: "darwin",
  arch: "arm64",
  version: "0.9.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/ana/agentes",
  exec: true,
};

type Request = Extract<ServerFrame, { type: "request" }>;

/** A runner over an in-memory socket that answers every request with a harmless success. */
function fakeRunner(hub: MachineHub) {
  const sent: ServerFrame[] = [];
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const data = (req: Request) =>
    req.op === "exec"
      ? { exitCode: 0, stdout: "ok", stderr: "", timedOut: false }
      : req.op === "task.output"
        ? { lines: [], truncated: false }
        : {};
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      sent.push(frame);
      if (frame.type === "request")
        setTimeout(() => void reply({ type: "result", id: frame.id, ok: true, data: data(frame) }), 1);
    },
    close() {
      void hub.close(conn);
    },
  });
  return {
    requests: () => sent.filter((s): s is Request => s.type === "request"),
    send: (frame: Record<string, unknown>) => reply(frame),
    hello: (token: string) => reply({ type: "hello", token, ...RUNNER }),
    /** The server's answer to a bridge call, once it is sent. */
    async answer(callId: string) {
      for (let i = 0; i < 100; i++) {
        const found = sent.find((s) => "callId" in s && s.callId === callId);
        if (found) return found;
        await Bun.sleep(5);
      }
      return null;
    },
  };
}
