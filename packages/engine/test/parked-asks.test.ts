import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  type Brain,
  type BrainEvent,
  type BrainTurn,
  clearPlanLimits,
  continueRun,
  createAgent,
  createJobHandlers,
  createReleaseAsksToolSource,
  drainOutbox,
  getMessage,
  insertMessage,
  type MachineStatus,
  parkedOnBlock,
  postPersonMessage,
  RESUME_AFTER_MS,
  receiptsFor,
  type ToolContext,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * Asks a waiting run holds (ADR 0136): handled meanwhile, they are let go early, by the check or by the agent that
 * handled them, and the agent's own requests whose need was met here are withdrawn quietly.
 */

let f: Fixture;
afterEach(() => {
  setSystemTime();
  clearPlanLimits();
  const fx: Fixture | undefined = f;
  f = undefined as unknown as Fixture;
  return fx?.close();
});

const RUNNER = {
  hostname: "mac",
  os: "darwin" as const,
  arch: "arm64",
  version: "0.8.0",
  protocol: MACHINE_PROTOCOL_VERSION,
  workspace: "/Users/w/agentes",
};

const statusOf = (machineId: string): MachineStatus => ({
  id: machineId,
  orgId: "org",
  name: "MacBook",
  online: true,
  execAllowed: true,
  os: "darwin",
  protocol: 8,
  executors: { claude: { version: "2.1.300", loggedIn: true }, detectedAt: new Date().toISOString() },
});

async function computerAgent(fx: Fixture) {
  const deps = { db: fx.db, pubsub: fx.pubsub, publicUrl: "https://agentes.chat" };
  const paired = await pairMachine(deps, fx.owner.id, fx.org.id, { name: "MacBook", ...RUNNER, exec: true });
  await fx.db
    .update(schema.agents)
    .set({ machineId: paired.machineId, brain: "claude_code", brainFallback: false })
    .where(eq(schema.agents.id, fx.agent.id));
  return paired.machineId;
}

function scripted(script: (n: number) => BrainEvent[]) {
  const seen: BrainTurn[] = [];
  const brain: Brain = {
    kind: "claude_code",
    async *run(turn) {
      const n = seen.length;
      seen.push({ ...turn, system: "", messages: [] });
      yield* script(n);
    },
  };
  return { brain, seen };
}

const later = (ms: number) => new Date(Date.now() + ms);
const runsOf = (fx: Fixture, agentId: string) =>
  fx.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.agentId, agentId))
    .orderBy(schema.agentRuns.createdAt);
const closedNotes = async (fx: Fixture) =>
  (await fx.db.select().from(schema.messages)).filter((m) => m.meta.bodyCode === "catch_up_closed");

/** A check that judges each asker by name: `[status, who credited]`, sure at 0.95. */
const byAsker =
  (verdicts: Record<string, [status: "solved" | "not_needed" | "needs_agent", who: string | null]>) =>
  (kind: string, id: string, state: Record<string, unknown>) => {
    if (kind !== "catch_up_triage") return undefined;
    const askers = state.askers as Record<string, { name: string }>;
    const [status, who] = verdicts[askers[id.slice(id.indexOf("_") + 1)]?.name ?? ""] ?? ["needs_agent", null];
    if (id.startsWith("status_")) {
      const probabilities = { needs_agent: 0.025, solved: 0.025, not_needed: 0.025, [status]: 0.95 };
      return { choice: status, probabilities };
    }
    const people = state.participants as Record<string, { name: string }>;
    const key = Object.entries(people).find(([, p]) => p.name === who)?.[0] ?? "nobody";
    return { choice: key, probabilities: { [key]: 0.95 } };
  };

/** A message as stored (receipts and blocks read its meta and mentions). */
const stored = async (fx: Fixture, id: string) => {
  const m = await getMessage(fx.db, fx.org.id, id);
  if (!m) throw new Error("no such message");
  return m;
};

const judgeCalls = (fx: Fixture, kind: string) =>
  (fx.jobDeps.context.judge as unknown as { calls: { kind: string; state: Record<string, unknown> }[] }).calls.filter(
    (c) => c.kind === kind,
  );

/**
 * Bia asks @dev, whose plan is out, and Caio's ask joins that waiting run; Ada, another agent, is in the channel.
 * `verdicts`: how the check judges each asker.
 */
async function twoAskers(verdicts: Parameters<typeof byAsker>[0]) {
  f = await setup({ judge: byAsker(verdicts) });
  await computerAgent(f);
  const { brain, seen } = scripted((n) =>
    n === 0
      ? [
          { type: "limit", resetsAt: later(3600_000).toISOString() },
          { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: false },
        ]
      : [{ type: "done", text: "Saiu às 14h." }],
  );
  const handlers = createJobHandlers({
    ...f.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
    planLimitGraceMs: 50,
  });
  const deps = { db: f.db, pubsub: f.pubsub };
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  for (const u of [bia, caio]) await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: u.id });
  const ada = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ada", handle: "ada" },
    { model: "claude-sonnet-5-5" },
  );
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ada.id });
  const asked = await postPersonMessage(deps, bia.id, f.org.id, f.general.id, { body: "@dev o deploy saiu?" });
  await drainOutbox(f.db, handlers);
  const second = await postPersonMessage(deps, caio.id, f.org.id, f.general.id, {
    body: "@dev cria a tarefa do rollback",
  });
  await drainOutbox(f.db, handlers);
  /** Ada's reply in the thread under `root`, as another agent answering there. */
  const adaReplies = (root: string, body: string) =>
    insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: root,
      author: { type: "agent", agentId: ada.id, runId: null, hop: 1, stretchId: null },
      body,
    });
  return { handlers, seen, deps, bia, caio, ada, asked, second, adaReplies };
}

test("a reply in the thread under an ask that joined a run waiting on the plan closes that ask early: its receipt goes, the other asker waits, and the catch-up doesn't redo it", async () => {
  const { handlers, seen, deps, bia, caio, ada, asked, second, adaReplies } = await twoAskers({
    caio: ["solved", "Ada"],
    bia: ["needs_agent", null],
  });
  const [waiting] = await runsOf(f, f.agent.id);
  expect(waiting?.status).toBe("waiting_input");
  expect(waiting?.pendingMessageIds).toEqual([second.id]);
  expect((await receiptsFor(f.db, f.org.id, [await stored(f, second.id)])).get(second.id)?.handled).toEqual([
    expect.objectContaining({ agentId: f.agent.id, status: "waiting_input", usage: "plan" }),
  ]);

  // Another agent takes care of it in the thread under that ask.
  await adaReplies(second.id, "Criei a tarefa #12 do rollback.");
  await drainOutbox(f.db, handlers, { now: later(2 * 60_000) });

  // The check read that reply as one under caio's ask.
  const [call] = judgeCalls(f, "catch_up_triage");
  expect(call?.state.since_pause).toEqual([
    expect.objectContaining({ from: "Ada", kind: "agent", in_thread_of: "a2" }),
  ]);
  const [still, skipped] = await runsOf(f, f.agent.id);
  // The run still waits for bia, without caio's ask; that one went to a run of its own, closed.
  expect(still?.status).toBe("waiting_input");
  expect(still?.pendingMessageIds).toEqual([]);
  expect(skipped).toMatchObject({ status: "done", triggerMessageId: second.id });
  expect((skipped?.transcript as { catchUpTriage?: unknown } | undefined)?.catchUpTriage).toMatchObject({
    outcome: "closed",
    askers: [expect.objectContaining({ userId: caio.id, reason: "solved" })],
  });
  const receipts = await receiptsFor(f.db, f.org.id, [await stored(f, asked.id), await stored(f, second.id)]);
  expect(receipts.get(second.id)?.handled).toEqual([
    expect.objectContaining({ agentId: f.agent.id, runId: skipped?.id, status: "done", passed: true }),
  ]);
  expect(receipts.get(asked.id)?.handled).toEqual([
    expect.objectContaining({ agentId: f.agent.id, status: "waiting_input", usage: "plan" }),
  ]);
  const [note] = await closedNotes(f);
  expect(note?.meta.usageWait).toMatchObject({
    runId: skipped?.id,
    ended: true,
    closed: { reason: "solved", who: { name: "Ada", agentId: ada.id }, askers: [caio.id] },
  });
  const notices = await f.db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.kind, "catch_up_closed_asker"));
  expect(notices.map((n) => n.userId)).toEqual([caio.id]);

  // The plan back two days later: it answers bia only, told caio's ask is no longer its own.
  const t = still?.transcript as { usageWait: { since: number } };
  t.usageWait.since = Date.now() - 2 * 24 * 3600_000;
  await f.db
    .update(schema.agentRuns)
    .set({ transcript: t as never })
    .where(eq(schema.agentRuns.id, still?.id ?? ""));
  clearPlanLimits();
  await drainOutbox(f.db, handlers, { now: later(3600_000 + RESUME_AFTER_MS + 1000) });
  expect(seen).toHaveLength(2);
  const prompt = String(seen[1]?.trigger);
  expect(prompt).toContain("# Catching up");
  expect(prompt).toContain("caio's ask was handled meanwhile by Ada: it isn't yours to answer anymore.");
  expect(prompt).not.toContain("cria a tarefa do rollback");
  expect((await runsOf(f, f.agent.id)).map((r) => r.status)).toEqual(["done", "done"]);
  // Responder mesmo assim stays caio's on the skipped ask.
  await expect(continueRun(deps, bia.id, f.org.id, skipped?.id ?? "")).rejects.toThrow();
});

test("the trigger's own asker handled while another still waits: the run ends with its note closed, and the rest gets a run of its own", async () => {
  const { handlers, seen, bia, ada, asked, second, adaReplies } = await twoAskers({
    bia: ["solved", "Ada"],
    caio: ["needs_agent", null],
  });
  await adaReplies(asked.id, "Saiu às 14h, está em produção.");
  await drainOutbox(f.db, handlers, { now: later(2 * 60_000) });
  const [closed, rehomed, ...more] = await runsOf(f, f.agent.id);
  expect(more).toEqual([]);
  expect(closed?.status).toBe("done");
  expect((closed?.transcript as { catchUpTriage?: unknown } | undefined)?.catchUpTriage).toMatchObject({
    outcome: "closed",
    askers: [expect.objectContaining({ userId: bia.id })],
  });
  // Its own note says why, offering Responder mesmo assim to bia.
  const [note] = (await f.db.select().from(schema.messages)).filter(
    (m) => (m.meta.usageWait as { runId?: string } | undefined)?.runId === closed?.id,
  );
  expect(note?.meta.usageWait).toMatchObject({ closed: { reason: "solved", who: { name: "Ada", agentId: ada.id } } });
  // Caio's ask isn't dropped: it waits on the plan in a run of its own, nothing answered yet.
  expect(rehomed).toMatchObject({ triggerMessageId: second.id, status: "waiting_input" });
  expect(seen).toHaveLength(1);
  const notices = await f.db
    .select()
    .from(schema.notifications)
    .where(eq(schema.notifications.kind, "catch_up_closed_asker"));
  expect(notices.map((n) => n.userId)).toEqual([bia.id]);
});

/** @dev waits (`wait`) on bia's "@dev @ada …"; Ada's run answers the same message. */
async function waitingBeside(wait: "plan" | "budget" | "queued") {
  f = await setup();
  const deps = { db: f.db, pubsub: f.pubsub };
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  const ada = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ada", handle: "ada" },
    { model: "claude-sonnet-5-5" },
  );
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { agentId: ada.id });
  const posted = await postPersonMessage(deps, bia.id, f.org.id, f.general.id, { body: "@dev @ada o deploy saiu?" });
  const asked = await stored(f, posted.id);
  const [dev] = await runsOf(f, f.agent.id);
  const [adas] = await runsOf(f, ada.id);
  if (!dev || !adas) throw new Error("both agents were asked");
  const machineId =
    wait === "queued"
      ? (await pairMachine(deps, f.owner.id, f.org.id, { name: "MacBook", ...RUNNER })).machineId
      : null;
  const resetsAt = later(3 * 3600_000).toISOString();
  const waitingForBrain =
    wait === "queued"
      ? { kind: "claude_code", machineId, code: "busy", waitId: "w1" }
      : wait === "plan"
        ? {
            kind: "claude_code",
            machineId: "",
            code: "plan_limit",
            waitId: "w1",
            waitKey: "plan:m1:claude_code:own",
            resetsAt,
            plan: "Claude",
            since: Date.now(),
          }
        : {
            kind: "model",
            machineId: "",
            code: "budget",
            waitId: "w1",
            waitKey: `budget:${f.agent.id}`,
            resetsAt,
            since: Date.now(),
          };
  await f.db
    .update(schema.agentRuns)
    .set({
      status: "waiting_input",
      startedAt: new Date(),
      waitingMachineId: machineId,
      transcript: { system: [], messages: [], waitingForBrain, usageWait: { since: Date.now(), step: 0 } } as never,
    })
    .where(eq(schema.agentRuns.id, dev.id));
  await f.db
    .update(schema.agentRuns)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(schema.agentRuns.id, adas.id));
  const [running] = await runsOf(f, ada.id);
  const ctx: ToolContext = {
    db: f.db,
    orgId: f.org.id,
    agentId: ada.id,
    runId: adas.id,
    channelId: f.general.id,
    threadRootId: adas.threadRootId,
    triggerMessageId: adas.triggerMessageId,
  };
  const [tool] = await createReleaseAsksToolSource({ pubsub: f.pubsub }).tools(ctx);
  if (!tool || !running) throw new Error("the tool is listed");
  return { deps, bia, ada, asked, dev, ada_run: running, ctx, tool };
}

describe("release_waiting_agent: an agent that handled the ask lets the one waiting on it go", () => {
  for (const [wait, words] of [
    ["plan", "Dev (@dev) is waiting for its plan's limit to reset (back in 3 h)"],
    ["budget", "Dev (@dev) is waiting for its monthly budget to renew (back in 3 h)"],
    ["queued", "Dev (@dev) is in line for its computer"],
  ] as const) {
    test(`waiting on its ${wait}: told in the context, released with the closed note and Responder mesmo assim`, async () => {
      const { deps, bia, ada, asked, dev, ada_run, ctx, tool } = await waitingBeside(wait);
      expect(await parkedOnBlock(f.db, ada_run, asked)).toContain(words);
      const out = await tool.execute({ agent: "@dev", reason: "Respondi que saiu às 14h." }, ctx);
      expect(out.content).toStartWith("Released: Dev won't answer it later.");
      const [done] = await runsOf(f, f.agent.id);
      expect(done?.status).toBe("done");
      expect(done?.waitingMachineId).toBeNull();
      expect((done?.transcript as { catchUpTriage?: unknown } | undefined)?.catchUpTriage).toMatchObject({
        outcome: "closed",
        releasedBy: ada.id,
      });
      const [note] = await closedNotes(f);
      expect(note?.meta.usageWait).toMatchObject({
        runId: dev.id,
        closed: { reason: "solved", who: { name: "Ada", agentId: ada.id }, askers: [bia.id] },
      });
      expect((await receiptsFor(f.db, f.org.id, [asked])).get(asked.id)?.handled).toContainEqual(
        expect.objectContaining({ agentId: f.agent.id, status: "done", passed: true }),
      );
      // Nothing waits anymore, so nothing to tell.
      expect(await parkedOnBlock(f.db, ada_run, asked)).toBeNull();
      // Who asked may still ask it to answer.
      expect((await continueRun(deps, bia.id, f.org.id, dev.id)).runId).toBeTruthy();
    });
  }

  test("nothing running is stopped, and nobody else's wait is touched", async () => {
    const { dev, ctx, tool } = await waitingBeside("plan");
    expect((await tool.execute({ agent: "Eva", reason: "x" }, ctx)).content).toStartWith('No agent called "Eva"');
    await f.db
      .update(schema.agentRuns)
      .set({ status: "running", waitingMachineId: null })
      .where(eq(schema.agentRuns.id, dev.id));
    expect((await tool.execute({ agent: "dev", reason: "x" }, ctx)).content).toStartWith('No agent called "dev"');
    expect((await runsOf(f, f.agent.id))[0]?.status).toBe("running");
  });
});
