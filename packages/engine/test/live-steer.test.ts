import { afterEach, expect, test } from "bun:test";
import {
  BRAIN_PROTOCOL,
  brainTopic,
  createMemoryPubSub,
  MACHINE_PROTOCOL_VERSION,
  type MachineRequest,
  STEER_PROTOCOL,
} from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  type Brain,
  type BrainEvent,
  type BrainIO,
  type BrainTurn,
  createClaudeCodeBrain,
  createJobHandlers,
  drainOutbox,
  listMessages,
  type MachineStatus,
  postPersonMessage,
  type SteerMessage,
  type SteerReply,
} from "../src";
import { deliverLive } from "../src/live-steer";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * Live steering: a person's message reaches a computer brain's turn in
 * progress (read at its next tool boundary), with "received" then "read"
 * receipts; what the turn never confirms is read with its next turn; a turn
 * that can't take messages leaves them for its end, as before.
 */

let f: Fixture | undefined;
afterEach(async () => {
  const current = f;
  f = undefined;
  await current?.close();
});

const statusOf = (machineId: string): MachineStatus => ({
  id: machineId,
  orgId: "org",
  name: "MacBook",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: STEER_PROTOCOL,
  executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
});

async function computerAgent(fx: Fixture) {
  const deps = { db: fx.db, pubsub: fx.pubsub, publicUrl: "https://agentes.chat" };
  const paired = await pairMachine(deps, fx.owner.id, fx.org.id, {
    name: "MacBook",
    hostname: "mac",
    os: "darwin",
    arch: "arm64",
    version: "0.9.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/Users/w/agentes",
    exec: true,
  });
  await fx.db
    .update(schema.agents)
    .set({ machineId: paired.machineId, brain: "claude_code" })
    .where(eq(schema.agents.id, fx.agent.id));
  return paired.machineId;
}

/** A promise with its resolve outside. */
function gate<T = void>() {
  let open!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    open = r;
  });
  return { promise, open };
}

const waitUntil = async (cond: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

/**
 * A Claude Code stand-in: its first turn hands the engine `steer` (answering
 * with `reply`), says it started, and ends when `finish` opens, yielding what
 * the test asks for first; later turns answer at once. Keeps every turn.
 */
function steerableBrain(reply: (messages: SteerMessage[]) => SteerReply) {
  const seen: BrainTurn[] = [];
  const handed: SteerMessage[][] = [];
  const started = gate();
  const finish = gate<BrainEvent[]>();
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn: BrainTurn, io: BrainIO) {
      const n = seen.length;
      seen.push({ ...turn, system: "", messages: [] });
      if (n > 0) {
        yield { type: "done", text: `Turn ${n + 1}.` };
        return;
      }
      io.steerable?.(async (messages) => {
        handed.push(messages);
        return reply(messages);
      });
      try {
        started.open();
        const events = await finish.promise;
        yield* events;
        yield { type: "done", text: "Feito." };
      } finally {
        io.steerable?.(null);
      }
    },
  };
  return { brain, seen, handed, started, finish };
}

const post = (fx: Fixture, body: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body });

test("a message during a computer turn is handed to it live; read ones join it, unconfirmed ones go to the next turn", async () => {
  f = await setup();
  const fx = f;
  await computerAgent(fx);
  const events = fx.listen(fx.general.id);
  const { brain, seen, handed, started, finish } = steerableBrain((messages) => ({
    status: "accepted",
    accepted: messages.map((m) => m.uuid),
  }));
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(fx, "@dev roda os testes");
  const drained = drainOutbox(fx.db, handlers);
  await started.promise;

  const first = await post(fx, "@dev e atualiza a doc");
  const second = await post(fx, "@dev e o changelog");
  // Each one went to the turn as it arrived, rendered like messages read between turns.
  expect(handed).toHaveLength(2);
  expect(handed[0]).toEqual([
    { uuid: expect.any(String), text: expect.stringContaining("while you were working]: @dev e atualiza a doc") },
  ]);
  expect(handed[1]?.[0]?.text).toContain("@dev e o changelog");
  const delivered = events.filter((e) => e.type === "agent.run.delivered");
  expect(delivered.map((e) => e.messageIds)).toEqual([[first.id], [second.id]]);
  // Nothing waits in the inbox while the turn has them.
  const [running] = await fx.db.select().from(schema.agentRuns);
  expect(running?.pendingMessageIds).toEqual([]);

  // The turn read only the first before it ended.
  finish.open([{ type: "steer_read", uuids: [handed[0]?.[0]?.uuid ?? ""] }]);
  await drained;
  await drainOutbox(fx.db, handlers);

  const read = events.filter((e) => e.type === "agent.run.read");
  expect(read[0]?.messageIds).toEqual([first.id]);
  // The unconfirmed one goes to the next turn's prompt (once), and is read then.
  expect(seen).toHaveLength(2);
  expect(seen[1]?.trigger).toContain("@dev e o changelog");
  expect(seen[1]?.trigger).not.toContain("@dev e atualiza a doc");
  expect(read.at(-1)?.messageIds).toEqual([second.id]);
  const [run] = await fx.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("done");
  expect(run?.pendingMessageIds).toEqual([]);
  const steps = await fx.db
    .select()
    .from(schema.agentRunSteps)
    .where(eq(schema.agentRunSteps.runId, run?.id ?? ""));
  expect(steps.some((s) => (s.data as { live?: boolean }).live === true)).toBe(true);
  // The answer before the next turn, then the next turn's: one run, nothing lost.
  const main = await listMessages(fx.db, fx.owner.id, fx.org.id, fx.general.id);
  expect(main.map((m) => m.body)).toEqual([
    "@dev roda os testes",
    "@dev e atualiza a doc",
    "@dev e o changelog",
    "Feito.",
    "Turn 2.",
  ]);
});

test("a turn that can't take messages: not live, the message waits for the turn's end (asked once per turn)", async () => {
  f = await setup();
  const fx = f;
  await computerAgent(fx);
  const events = fx.listen(fx.general.id);
  const { brain, seen, handed, started, finish } = steerableBrain(() => ({
    status: "unsupported",
    reason: "Claude Code 2.1.100 reads messages only between turns",
  }));
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
  });
  await post(fx, "@dev roda os testes");
  const drained = drainOutbox(fx.db, handlers);
  await started.promise;
  const msg = await post(fx, "@dev e a doc");
  await post(fx, "@dev e o changelog");
  expect(handed).toHaveLength(1);
  expect(events.some((e) => e.type === "agent.run.delivered")).toBe(false);
  const [running] = await fx.db.select().from(schema.agentRuns);
  expect(running?.pendingMessageIds).toContain(msg.id);
  expect(running?.pendingMessageIds).toHaveLength(2);
  finish.open([]);
  await drained;
  await drainOutbox(fx.db, handlers);
  expect(seen).toHaveLength(2);
  expect(seen[1]?.trigger).toContain("@dev e a doc");
  expect(seen[1]?.trigger).toContain("@dev e o changelog");
});

test("deliverLive: false at once for a run that isn't running, and after a short wait when nobody executes it", async () => {
  f = await setup();
  const fx = f;
  const pubsub = createMemoryPubSub();
  const run = { id: "0193bbbb-0000-7000-8000-000000000009", status: "queued" } as never;
  expect(await deliverLive({ db: fx.db, pubsub }, run, { messageId: "m", urgent: false })).toBe(false);
  const started = Date.now();
  const running = { id: "0193bbbb-0000-7000-8000-000000000009", status: "running" } as never;
  expect(await deliverLive({ db: fx.db, pubsub, waitMs: 50 }, running, { messageId: "m", urgent: true })).toBe(false);
  expect(Date.now() - started).toBeLessThan(1000);
});

test("a model-brain run answers false at once (it reads messages at each step anyway)", async () => {
  const hold = gate();
  let calls = 0;
  f = await setup({
    reply: () => {
      calls++;
      return { chunks: ["Pron", "to."], hold: hold.promise };
    },
  });
  const fx = f;
  await post(fx, "@dev oi");
  const drained = drainOutbox(fx.db, fx.handlers);
  await waitUntil(() => calls > 0);
  const [run] = await fx.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("running");
  const started = Date.now();
  expect(await deliverLive({ db: fx.db, pubsub: fx.pubsub }, run as never, { messageId: "m", urgent: false })).toBe(
    false,
  );
  // Answered by the instance executing it, not by the timeout.
  expect(Date.now() - started).toBeLessThan(500);
  hold.open();
  await drained;
});

test("Claude Code brain: a runner on protocol 15 takes brain.steer for the turn; an older one is never asked", async () => {
  const pubsub = createMemoryPubSub();
  const MACHINE = "0193cccc-0000-7000-8000-000000000001";
  const RUN = "0193bbbb-0000-7000-8000-000000000001";
  const SESSION = "0193aaaa-0000-7000-8000-000000000001";
  const calls: MachineRequest[] = [];
  const turnEnd = gate();
  const hubFor = (protocol: number) => ({
    status: async () => ({ ...statusOf(MACHINE), protocol }),
    call: async (_id: string, request: MachineRequest) => {
      calls.push(request);
      if (request.op === "brain.steer") return { status: "accepted", accepted: [request.messages[0]?.uuid] } as never;
      await turnEnd.promise;
      const final = { type: "done", text: "ok" };
      await pubsub.publish(brainTopic(RUN), {
        type: "brain.event",
        machineId: MACHINE,
        event: { type: "steer_read", uuids: ["u1"] },
      });
      await pubsub.publish(brainTopic(RUN), { type: "brain.event", machineId: MACHINE, event: final });
      return { runId: RUN, final } as never;
    },
  });
  const turn: BrainTurn = {
    runId: RUN,
    orgId: "org",
    agentId: "agent-1",
    channelId: "ch",
    threadRootId: null,
    system: "",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    session: { id: SESSION, resume: false, machineId: MACHINE, cwd: "" },
    trigger: "hi",
  };
  let steer: ((m: SteerMessage[]) => Promise<SteerReply>) | null = null;
  const handedOff: Array<boolean> = [];
  const io: BrainIO = {
    signal: new AbortController().signal,
    executeTool: async () => ({ content: "" }),
    steerable: (s) => {
      steer = s;
      handedOff.push(s !== null);
    },
  };
  const brain = createClaudeCodeBrain({
    hub: hubFor(STEER_PROTOCOL),
    pubsub,
    agentScope: async (t) => ({ id: t.agentId, handle: "dev" }),
    finalGraceMs: 20,
  });
  const out: BrainEvent[] = [];
  const running = (async () => {
    for await (const e of brain.run(turn, io)) out.push(e);
  })();
  await waitUntil(() => steer !== null);
  const reply = await (steer as unknown as (m: SteerMessage[]) => Promise<SteerReply>)([
    { uuid: "u1", text: "[New message from Ada]: hi", urgent: true },
  ]);
  expect(reply).toEqual({ status: "accepted", accepted: ["u1"] });
  expect(calls.find((c) => c.op === "brain.steer")).toEqual({
    op: "brain.steer",
    runId: RUN,
    session: SESSION,
    messages: [{ uuid: "u1", text: "[New message from Ada]: hi", urgent: true }],
    agent: { id: "agent-1", handle: "dev" },
  });
  turnEnd.open();
  await running;
  expect(out).toEqual([
    { type: "steer_read", uuids: ["u1"] },
    { type: "done", text: "ok" },
  ]);
  // Handed at the start, taken back at the end.
  expect(handedOff).toEqual([true, false]);

  // An older runner: the brain never offers steering.
  const old = createClaudeCodeBrain({
    hub: hubFor(BRAIN_PROTOCOL),
    pubsub,
    agentScope: async (t) => ({ id: t.agentId, handle: "dev" }),
    finalGraceMs: 20,
  });
  handedOff.length = 0;
  for await (const _ of old.run(turn, io)) {
    // drain
  }
  expect(handedOff).toEqual([]);
});
