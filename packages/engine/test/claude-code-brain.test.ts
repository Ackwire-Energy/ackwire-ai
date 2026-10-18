import { afterEach, expect, test } from "bun:test";
import {
  BRAIN_PROTOCOL,
  brainTopic,
  createMemoryPubSub,
  MACHINE_PROTOCOL_VERSION,
  type MachineRequest,
  type PubSub,
  type ServerFrame,
  type WireBrainEvent,
} from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  type BrainEvent,
  type BrainTurn,
  brainSessionId,
  claudeCodeAvailability,
  createClaudeCodeBrain,
  createJobHandlers,
  drainOutbox,
  listMessages,
  type MachineCallOptions,
  MachineOfflineError,
  MachineRequestError,
  type MachineStatus,
  postPersonMessage,
  recordPlanUsage,
  restatesReaction,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

let f: Fixture | undefined;
afterEach(async () => {
  await f?.machineHub?.stop();
  const current = f;
  f = undefined;
  await current?.close();
});

const MACHINE = "0193cccc-0000-7000-8000-000000000001";
const RUN = "0193bbbb-0000-7000-8000-000000000001";
const SESSION = "0193aaaa-0000-7000-8000-000000000001";

const status = (over: Partial<MachineStatus> = {}): MachineStatus => ({
  id: MACHINE,
  orgId: "org",
  name: "mac",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: BRAIN_PROTOCOL,
  executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
  ...over,
});

const turn = (over: Partial<BrainTurn> = {}): BrainTurn => ({
  runId: RUN,
  orgId: "org",
  agentId: "agent-1",
  channelId: "ch",
  threadRootId: null,
  system: "You are dev.",
  messages: [{ role: "user", content: "hi" }],
  tools: [],
  model: "opus",
  session: { id: SESSION, resume: false, machineId: MACHINE, cwd: "" },
  trigger: "hi",
  ...over,
});

const io = (signal = new AbortController().signal) => ({
  signal,
  executeTool: async () => ({ content: "never called" }),
});

async function collect(it: AsyncIterable<BrainEvent>) {
  const out: BrainEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

/**
 * A hub whose machine answers `brain.turn` like a runner: its events go out
 * on the run's topic (as the real hub publishes them) and the request
 * resolves with the final one.
 */
function fakeHub(
  pubsub: PubSub,
  opts: {
    status?: MachineStatus | null;
    events?: WireBrainEvent[];
    final?: WireBrainEvent;
    /** Don't publish the stream (lost events): only the reply ends the turn. */
    silent?: boolean;
    from?: string;
    fail?: Error;
  } = {},
) {
  const calls: { machineId: string; request: MachineRequest; options?: MachineCallOptions }[] = [];
  const hub = {
    status: async () => (opts.status === undefined ? status() : opts.status),
    call: async (machineId: string, request: MachineRequest, options?: MachineCallOptions) => {
      calls.push({ machineId, request, ...(options ? { options } : {}) });
      if (opts.fail) throw opts.fail;
      const runId = (request as { runId: string }).runId;
      const final = opts.final ?? { type: "done", text: "Hello world", session: { id: SESSION } };
      if (!opts.silent) {
        for (const event of [...(opts.events ?? []), final]) {
          await pubsub.publish(brainTopic(runId), { type: "brain.event", machineId: opts.from ?? machineId, event });
        }
        await pubsub.publish(brainTopic(runId), { type: "brain.done", machineId: opts.from ?? machineId });
      }
      return { runId, final } as never;
    },
  };
  return { hub, calls };
}

const brainWith = (pubsub: PubSub, hub: ReturnType<typeof fakeHub>["hub"]) =>
  createClaudeCodeBrain({
    hub,
    pubsub,
    agentScope: async (t) => ({ id: t.agentId, handle: "dev" }),
    finalGraceMs: 20,
  });

test("a turn goes to the agent's computer as brain.turn and streams its events back", async () => {
  const pubsub = createMemoryPubSub();
  const { hub, calls } = fakeHub(pubsub, {
    events: [
      { type: "text_delta", text: "Hello " },
      { type: "tool_call", id: "t1", name: "search_context", input: { query: "x" }, executed: { content: "found" } },
      { type: "text_delta", text: "world" },
      { type: "usage", input: 16, output: 7, source: "plan", model: "claude-opus-5-5" },
    ],
  });
  const events = await collect(brainWith(pubsub, hub).run(turn(), io()));
  expect(events).toEqual([
    { type: "text_delta", text: "Hello " },
    { type: "tool_call", id: "t1", name: "search_context", input: { query: "x" }, executed: { content: "found" } },
    { type: "text_delta", text: "world" },
    { type: "usage", input: 16, output: 7, source: "plan", model: "claude-opus-5-5" },
    { type: "done", text: "Hello world", session: { id: SESSION } },
  ]);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.machineId).toBe(MACHINE);
  expect(calls[0]?.request).toMatchObject({
    op: "brain.turn",
    runId: RUN,
    kind: "claude_code",
    agent: { id: "agent-1", handle: "dev" },
    session: { id: SESSION, resume: false },
    cwd: "",
    model: "opus",
    system: "You are dev.",
    prompt: "hi",
    keepAlive: true,
    personalMcp: false,
  });
  const sent = calls[0]?.request as { mcp?: { token?: string } } | undefined;
  expect(sent?.mcp?.token?.length ?? 0).toBeGreaterThan(20);
});

test("before a chat turn: the agent's checkouts set where it starts and add # Your code; a failure changes nothing", async () => {
  const pubsub = createMemoryPubSub();
  const { hub, calls } = fakeHub(pubsub);
  const seen: BrainTurn[] = [];
  const brain = (prepare: (t: BrainTurn) => Promise<{ cwd: string; prompt: string } | null>) =>
    createClaudeCodeBrain({
      hub,
      pubsub,
      agentScope: async (t) => ({ id: t.agentId, handle: "dev" }),
      finalGraceMs: 20,
      prepare: async (t) => {
        seen.push(t);
        return prepare(t);
      },
    });
  await collect(
    brain(async () => ({
      cwd: "repos/acme/app",
      prompt: "# Your code\nacme/app is checked out at /w/repos/acme/app",
    })).run(turn(), io()),
  );
  expect(seen).toHaveLength(1);
  expect(calls[0]?.request).toMatchObject({
    cwd: "repos/acme/app",
    system: "You are dev.\n\n# Your code\nacme/app is checked out at /w/repos/acme/app",
  });
  await collect(
    brain(async () => {
      throw new Error("offline");
    }).run(turn(), io()),
  );
  expect(calls[1]?.request).toMatchObject({ cwd: "", system: "You are dev." });
});

test("a new session reads the conversation so far, not only the message that called it", async () => {
  const pubsub = createMemoryPubSub();
  const { hub, calls } = fakeHub(pubsub, { events: [] });
  const messages = [
    { role: "user" as const, content: "[Atlas]: New Sentry error: VIAJOLO-BACKEND-2X" },
    { role: "user" as const, content: "what error is this? can you find it in the code?" },
  ];
  await collect(
    brainWith(pubsub, hub).run(turn({ messages, trigger: "what error is this? can you find it in the code?" }), io()),
  );
  expect((calls[0]?.request as { prompt?: string } | undefined)?.prompt).toBe(
    "The conversation so far:\n\nUser: [Atlas]: New Sentry error: VIAJOLO-BACKEND-2X\n\nNow answer this:\n\nwhat error is this? can you find it in the code?",
  );
});

test("events lost on the way: the reply's final event still ends the turn; another machine can't speak for the run", async () => {
  const pubsub = createMemoryPubSub();
  const silent = fakeHub(pubsub, { silent: true });
  expect(await collect(brainWith(pubsub, silent.hub).run(turn(), io()))).toEqual([
    { type: "done", text: "Hello world", session: { id: SESSION } },
  ]);
  const impostor = fakeHub(pubsub, {
    from: "0193cccc-0000-7000-8000-00000000ffff",
    events: [{ type: "text_delta", text: "evil" }],
  });
  expect(await collect(brainWith(pubsub, impostor.hub).run(turn(), io()))).toEqual([
    { type: "done", text: "Hello world", session: { id: SESSION } },
  ]);
});

test("a plan limit streams limit{resetsAt} and ends with a retryable plan_limit", async () => {
  const pubsub = createMemoryPubSub();
  const { hub } = fakeHub(pubsub, {
    events: [{ type: "limit", resetsAt: "2030-03-17T17:46:40.000Z" }],
    final: { type: "error", code: "plan_limit", message: "You've hit your limit", retryable: true },
  });
  expect(await collect(brainWith(pubsub, hub).run(turn(), io()))).toEqual([
    { type: "limit", resetsAt: "2030-03-17T17:46:40.000Z" },
    { type: "error", code: "plan_limit", message: "You've hit your limit", retryable: true },
  ]);
});

test("not reachable: each reason ends the turn at once, retryable, without calling the machine", async () => {
  const cases: [MachineStatus | null, string][] = [
    [null, "machine_offline"],
    [status({ online: false }), "machine_offline"],
    [status({ execAllowed: false }), "exec_disabled"],
    [status({ protocol: BRAIN_PROTOCOL - 1 }), "runner_outdated"],
    [status({ executors: { detectedAt: "2026-10-17T00:00:00Z" } }), "cli_missing"],
    [status({ executors: { claude: { version: "2.1", loggedIn: false } } }), "not_logged_in"],
  ];
  for (const [s, code] of cases) {
    const pubsub = createMemoryPubSub();
    const { hub, calls } = fakeHub(pubsub, { status: s });
    const events = await collect(brainWith(pubsub, hub).run(turn(), io()));
    expect(events).toEqual([expect.objectContaining({ type: "error", code, retryable: true })]);
    expect(calls).toHaveLength(0);
  }
  // Login unknown (an older detection): it is tried.
  expect(claudeCodeAvailability(status({ executors: { claude: { version: "2.1" } } }))).toBeNull();
  const pubsub = createMemoryPubSub();
  const { hub } = fakeHub(pubsub);
  expect(await collect(brainWith(pubsub, hub).run(turn({ session: undefined }), io()))).toEqual([
    expect.objectContaining({ code: "no_session", retryable: true }),
  ]);
});

test("a failed request becomes the turn's error (offline and old runners may fall back; a timeout doesn't)", async () => {
  const cases: [Error, string, boolean][] = [
    [new MachineOfflineError("mac"), "machine_offline", true],
    [new MachineRequestError("bad_request", "Unknown op brain.turn"), "runner_outdated", true],
    [new MachineRequestError("timeout", "too slow"), "timeout", false],
    [new MachineRequestError("internal", "busy"), "busy", true],
    [new MachineRequestError("canceled", "canceled"), "canceled", false],
  ];
  for (const [fail, code, retryable] of cases) {
    const pubsub = createMemoryPubSub();
    const { hub } = fakeHub(pubsub, { fail });
    expect(await collect(brainWith(pubsub, hub).run(turn(), io()))).toEqual([
      expect.objectContaining({ type: "error", code, retryable }),
    ]);
  }
});

test("session ids: stable per agent and conversation, UUID-shaped", () => {
  const a = brainSessionId("agent-1", "thread-1");
  expect(a).toBe(brainSessionId("agent-1", "thread-1"));
  expect(a).not.toBe(brainSessionId("agent-1", "thread-2"));
  expect(a).not.toBe(brainSessionId("agent-2", "thread-1"));
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("end to end through the real hub: the runner's brain.event frames reach the brain; plan usage is recorded at no cost", async () => {
  f = await setup({ machines: true });
  const fx = f;
  const hub = fx.machineHub;
  if (!hub) throw new Error("no hub");
  const deps = { db: fx.db, pubsub: fx.pubsub, publicUrl: "https://agentes.chat" };
  const RUNNER = {
    hostname: "mac",
    os: "darwin" as const,
    arch: "arm64",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/Users/w/agentes",
  };
  const paired = await pairMachine(deps, fx.owner.id, fx.org.id, { name: "MacBook", ...RUNNER, exec: true });
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request" || frame.op !== "brain.turn") return;
      setTimeout(async () => {
        const final = { type: "done", text: "Oi!", session: { id: frame.session.id } };
        await reply({ type: "brain.event", runId: frame.runId, event: { type: "text_delta", text: "Oi" } });
        await reply({
          type: "brain.event",
          runId: frame.runId,
          event: { type: "usage", input: 9, output: 3, source: "plan" },
        });
        await reply({ type: "brain.event", runId: frame.runId, event: final });
        await reply({ type: "brain.done", runId: frame.runId });
        await reply({ type: "result", id: frame.id, ok: true, data: { runId: frame.runId, final } });
      }, 1);
    },
    close() {},
  });
  await hub.message(
    conn,
    JSON.stringify({
      type: "hello",
      token: paired.token,
      ...RUNNER,
      exec: true,
      executors: { claude: { version: "2.1.300", loggedIn: true, authMethod: "claude.ai", plan: "max" } },
    }),
  );
  const [row] = await fx.db.select().from(schema.machines).where(eq(schema.machines.id, paired.machineId));
  expect(row?.executors.claude).toEqual({ version: "2.1.300", loggedIn: true, authMethod: "claude.ai", plan: "max" });

  const brain = createClaudeCodeBrain({
    hub,
    pubsub: fx.pubsub,
    agentScope: async (t) => ({ id: t.agentId, handle: fx.agent.handle }),
    finalGraceMs: 20,
  });
  const events = await collect(
    brain.run(
      turn({
        orgId: fx.org.id,
        agentId: fx.agent.id,
        session: { id: SESSION, resume: false, machineId: paired.machineId, cwd: "" },
      }),
      io(),
    ),
  );
  expect(events).toEqual([
    { type: "text_delta", text: "Oi" },
    { type: "usage", input: 9, output: 3, source: "plan" },
    { type: "done", text: "Oi!", session: { id: SESSION } },
  ]);

  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
      trigger: "mention",
      hop: 1,
    })
    .returning({ id: schema.agentRuns.id });
  const id = await recordPlanUsage(fx.db, {
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run?.id ?? "",
    provider: "claude_code",
    model: "claude-opus-5-5",
    inputTokens: 9,
    outputTokens: 3,
  });
  const [usage] = await fx.db
    .select()
    .from(schema.usageRecords)
    .where(eq(schema.usageRecords.id, id ?? ""));
  expect(usage).toMatchObject({
    costNanoUsd: 0,
    billedTo: "plan",
    provider: "claude_code",
    model: "claude-opus-5-5",
    inputTokens: 9,
    outputTokens: 3,
  });
});

test("live text end to end: the runner's partial deltas reach the channel as agent.delta while the run thinks", async () => {
  f = await setup({ machines: true });
  const fx = f;
  const hub = fx.machineHub;
  if (!hub) throw new Error("no hub");
  const deps = { db: fx.db, pubsub: fx.pubsub, publicUrl: "https://agentes.chat" };
  const RUNNER = {
    hostname: "mac",
    os: "darwin" as const,
    arch: "arm64",
    version: "0.8.0",
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace: "/Users/w/agentes",
  };
  const paired = await pairMachine(deps, fx.owner.id, fx.org.id, { name: "MacBook", ...RUNNER, exec: true });
  await fx.db
    .update(schema.agents)
    .set({ machineId: paired.machineId, brain: "claude_code" })
    .where(eq(schema.agents.id, fx.agent.id));
  const events = fx.listen(fx.general.id);
  /** What the channel had seen when the runner sent its last delta (before the answer). */
  let seenBeforeDone: string[] = [];
  const reply = (frame: unknown) => hub.message(conn, JSON.stringify(frame));
  const conn = hub.open({
    send(text: string) {
      const frame = JSON.parse(text) as ServerFrame;
      if (frame.type !== "request" || frame.op !== "brain.turn") return;
      setTimeout(async () => {
        // Claude Code's `--include-partial-messages`, batched by the runner: three pieces.
        for (const piece of ["Olá, ", "tudo ", "certo."]) {
          await reply({ type: "brain.event", runId: frame.runId, event: { type: "text_delta", text: piece } });
          await new Promise((r) => setTimeout(r, 30));
        }
        seenBeforeDone = events.flatMap((e) =>
          e.type === "agent.delta" ? [(e as unknown as { text: string }).text] : [],
        );
        const final = { type: "done", text: "Olá, tudo certo.", session: { id: frame.session.id } };
        await reply({ type: "brain.event", runId: frame.runId, event: final });
        await reply({ type: "brain.done", runId: frame.runId });
        await reply({ type: "result", id: frame.id, ok: true, data: { runId: frame.runId, final } });
      }, 1);
    },
    close() {},
  });
  await hub.message(
    conn,
    JSON.stringify({
      type: "hello",
      token: paired.token,
      ...RUNNER,
      exec: true,
      executors: { claude: { version: "2.1.300", loggedIn: true } },
    }),
  );
  const handlers = createJobHandlers({
    ...fx.jobDeps,
    deltaFlushMs: 0,
    machines: hub,
    brains: {
      claude_code: (_agent, _run, s) =>
        createClaudeCodeBrain({
          hub,
          pubsub: fx.pubsub,
          agentScope: async (t) => ({ id: t.agentId, handle: fx.agent.handle }),
          mcpToken: () => s.mcpToken(),
          finalGraceMs: 20,
        }),
    },
  });
  const question = await postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body: "@dev oi",
  });
  await drainOutbox(fx.db, handlers);

  // Streamed live, piece by piece, before the turn ended.
  expect(seenBeforeDone.join("")).toBe("Olá, tudo certo.");
  expect(seenBeforeDone.length).toBeGreaterThanOrEqual(2);
  expect(events.findIndex((e) => e.type === "agent.typing")).toBeLessThan(
    events.findIndex((e) => e.type === "agent.delta"),
  );
  const thread = await listMessages(fx.db, fx.owner.id, fx.org.id, fx.general.id, { threadId: question.id });
  expect(thread.map((m) => m.body)).toEqual(["@dev oi", "Olá, tudo certo."]);
});

// A pure check (no fixture): what counts as restating a reaction after `react`.
test("restatesReaction: empty, NO_REPLY or only emoji and punctuation; any letter or digit is a reply", () => {
  for (const t of ["", "  ", "👍", "👍🏽", "🙌!", "✅ ✅", "❤️", "NO_REPLY", "👍👍👍👍👍👍👍👍"])
    expect(restatesReaction(t)).toBe(true);
  for (const t of ["ok", "👍 feito", "Pronto!", "42", "valeu"]) expect(restatesReaction(t)).toBe(false);
});
