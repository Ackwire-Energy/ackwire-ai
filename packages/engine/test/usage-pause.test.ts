import { afterEach, expect, setSystemTime, test } from "bun:test";
import { channelTopic, MACHINE_PROTOCOL_VERSION, orgTopic, type PlanUsage } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  archiveAgent,
  type Brain,
  type BrainEvent,
  type BrainTurn,
  BUSY_RETRIES,
  CANCELED_NOTE_QUIET_MS,
  cancelRun,
  cancelUsageQueue,
  clearPlanLimits,
  continueRun,
  createAgent,
  createChannel,
  createFakeJudge,
  createJobHandlers,
  createRoutine,
  drainOutbox,
  type Judge,
  LINE_SAFETY_MS,
  listMessages,
  listRoutines,
  loadAgentStatuses,
  loadReplyPolicy,
  type MachineStatus,
  nextMonthStart,
  noticeCategoryOf,
  overruledHere,
  postPersonMessage,
  RESUME_AFTER_MS,
  RESUME_GAP_MS,
  recoverStaleRuns,
  resumeBudgetWaits,
  runRoutineNow,
  stopRun,
  storedPlanLimit,
  updateAgent,
  usageQueue,
  usageWaitKey,
  usageWaitPlace,
  wakeNextInLine,
  wakePlanWaits,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * The usage-aware design, Phase 1: at a plan's limit or an agent's budget the run waits in its own session
 * and its job resumes it after the reset; nothing is lost and every resume checks the gate again.
 */

let f: Fixture;
afterEach(() => {
  setSystemTime();
  clearPlanLimits();
  const fx: Fixture | undefined = f;
  // A test with no database leaves nothing to close (not the previous test's again).
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

async function computerAgent(fx: Fixture, over: Partial<typeof schema.agents.$inferInsert> = {}) {
  const deps = { db: fx.db, pubsub: fx.pubsub, publicUrl: "https://agentes.chat" };
  const paired = await pairMachine(deps, fx.owner.id, fx.org.id, { name: "MacBook", ...RUNNER, exec: true });
  await fx.db
    .update(schema.agents)
    .set({ machineId: paired.machineId, brain: "claude_code", ...over })
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

const handlersWith = (fx: Fixture, brain: Brain) =>
  createJobHandlers({
    ...fx.jobDeps,
    brains: { claude_code: () => brain },
    machines: { status: async (id) => statusOf(id) },
    planLimitGraceMs: 50,
  });

const post = (fx: Fixture, body: string, threadId?: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, {
    body,
    ...(threadId ? { threadId } : {}),
  });

const notes = async (fx: Fixture, code: string, threadId?: string) =>
  (await listMessages(fx.db, fx.owner.id, fx.org.id, fx.general.id, threadId ? { threadId } : {})).filter(
    (m) => m.meta.bodyCode === code,
  );

const runs = (fx: Fixture) => fx.db.select().from(schema.agentRuns).orderBy(schema.agentRuns.createdAt);

/** The pending job that resumes this run's usage wait. */
async function resumeJob(fx: Fixture, runId: string) {
  const jobs = await fx.db
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.kind, "agent_run.execute"), eq(schema.outbox.status, "pending")));
  return jobs.find((j) => j.payload.runId === runId && typeof j.payload.wait === "string");
}

const later = (ms: number) => new Date(Date.now() + ms);

async function storeOwnUsage(fx: Fixture, machineId: string, usage: Record<string, unknown>) {
  const [m] = await fx.db.select().from(schema.machines).where(eq(schema.machines.id, machineId));
  await fx.db
    .update(schema.machines)
    .set({ executors: { ...m?.executors, ownUsage: { claude_code: usage as never } } })
    .where(eq(schema.machines.id, machineId));
}

test("a turn cut by the plan after a tool waits in its session and picks up after the reset", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  await computerAgent(f);
  // Keep the short reset window independent of database work and contention on the CI runner.
  const now = Date.now();
  setSystemTime(new Date(now));
  const resetsAt = later(150).toISOString();
  const { brain, seen } = scripted((n) =>
    n === 0
      ? [
          { type: "usage", input: 1200, output: 80, source: "plan" },
          {
            type: "tool_call",
            id: "t1",
            name: "Bash",
            input: { command: "git push origin main" },
            executed: { content: "ok" },
          },
          { type: "limit", resetsAt },
          { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: true },
        ]
      : [{ type: "done", text: "Terminei o deploy." }],
  );
  const handlers = handlersWith(f, brain);
  await post(f, "@dev faz o deploy");
  await drainOutbox(f.db, handlers);

  const [run] = await runs(f);
  expect(run?.status).toBe("waiting_input");
  expect(run?.waitingMachineId).toBeNull();
  const t = run?.transcript as {
    interruptedTurn?: { cause?: string; executed: string[] };
    waitingForBrain?: { code: string };
  };
  expect(t.interruptedTurn?.cause).toBe("plan_limit");
  expect(t.interruptedTurn?.executed).toEqual(["Bash (git push origin main)"]);
  expect(t.waitingForBrain?.code).toBe("plan_limit");
  // Never handed to the API, which couldn't see what it did.
  expect(f.provider.calls).toHaveLength(0);
  const [note] = await notes(f, "plan_limit_cut");
  expect(note?.meta.usageWait).toEqual({ code: "plan_limit", runId: run?.id, forUserId: f.owner.id, resetsAt });
  expect(note?.meta.bodyParams).toEqual({ plan: "Claude" });

  setSystemTime(new Date(now + 200));
  await drainOutbox(f.db, handlers, { now: later(RESUME_AFTER_MS + RESUME_GAP_MS) });
  expect(seen).toHaveLength(2);
  expect(seen[1]?.session?.id).toBe(seen[0]?.session?.id);
  expect(seen[1]?.session?.resume).toBe(true);
  expect(seen[1]?.trigger).toContain("the plan's usage limit was reached");
  expect(seen[1]?.trigger).toContain("Bash (git push origin main)");
  expect(seen[1]?.trigger).toContain("faz o deploy");
  const [done] = await runs(f);
  expect(done?.status).toBe("done");
  expect(await notes(f, "plan_limit_cut")).toHaveLength(1);
});

test("a cut whose turn used only the computer's own tools never falls back, even with an API key", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  await computerAgent(f);
  const { brain } = scripted(() => [
    { type: "limit", resetsAt: later(3600_000).toISOString() },
    { type: "error", code: "plan_limit", message: "You've hit your weekly limit", worked: true },
  ]);
  await post(f, "@dev arruma o teste");
  await drainOutbox(f.db, handlersWith(f, brain));
  const [run] = await runs(f);
  expect(run?.status).toBe("waiting_input");
  expect(f.provider.calls).toHaveLength(0);
});

test("a cut that may have worked never falls back on a resume while the plan is still limited", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  await computerAgent(f);
  // An older runner: no `worked`, no reset.
  const { brain } = scripted(() => [
    { type: "limit" },
    { type: "error", code: "plan_limit", message: "usage limit reached" },
  ]);
  const handlers = handlersWith(f, brain);
  await post(f, "@dev roda a migração");
  await drainOutbox(f.db, handlers);
  const [run] = await runs(f);
  expect(run?.status).toBe("waiting_input");
  expect((run?.transcript as { interruptedTurn?: { cause?: string } } | undefined)?.interruptedTurn?.cause).toBe(
    "plan_limit",
  );

  await drainOutbox(f.db, handlers, { now: later(3.5 * 60_000) });
  const [again] = await runs(f);
  expect(again?.status).toBe("waiting_input");
  expect(f.provider.calls).toHaveLength(0);
  expect((again?.transcript as { fallback?: unknown } | undefined)?.fallback).toBeUndefined();
});

test("a refusal before any work falls back to the API as before", async () => {
  f = await setup({ reply: () => ({ chunks: ["Respondi pela API."] }) });
  await computerAgent(f);
  const { brain } = scripted(() => [
    { type: "limit", resetsAt: later(3600_000).toISOString() },
    { type: "error", code: "plan_limit", message: "You've hit your limit", worked: false },
  ]);
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlersWith(f, brain));
  const [run] = await runs(f);
  expect(run?.status).toBe("done");
  expect(f.provider.calls).toHaveLength(1);
});

test("a limit then the answer: it is posted, and the next run on that plan waits from its start", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  await computerAgent(f, { brainFallback: false });
  const { brain, seen } = scripted(() => [
    { type: "text_delta", text: "Pronto, revisei." },
    { type: "limit", resetsAt: later(3600_000).toISOString() },
    { type: "done", text: "Pronto, revisei." },
  ]);
  const handlers = handlersWith(f, brain);
  const first = await post(f, "@dev revisa");
  await drainOutbox(f.db, handlers);
  expect((await runs(f))[0]?.status).toBe("done");
  expect((await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).at(-1)?.body).toBe("Pronto, revisei.");

  // In a thread of its own, so it doesn't join the first conversation.
  await post(f, "@dev e agora?", first.id);
  await drainOutbox(f.db, handlers);
  expect(seen).toHaveLength(1);
  const [, second] = await runs(f);
  expect(second?.status).toBe("waiting_input");
  expect(await notes(f, "plan_limit_wait", first.id)).toHaveLength(1);
});

test("a stored full window holds after a deploy (the cache forgotten): a new run waits for its reset", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  const machineId = await computerAgent(f, { brainFallback: false });
  const resetsAt = later(2 * 3600_000).toISOString();
  await storeOwnUsage(f, machineId, {
    windows: [{ kind: "five_hour", usedPercent: 100, resetsAt }],
    source: "turn",
    at: new Date().toISOString(),
  });
  clearPlanLimits();
  const { brain, seen } = scripted(() => [{ type: "done", text: "oi" }]);
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlersWith(f, brain));
  expect(seen).toHaveLength(0);
  const [run] = await runs(f);
  expect(run?.status).toBe("waiting_input");
  const job = await resumeJob(f, run?.id ?? "");
  expect(job?.nextAttemptAt.getTime()).toBe(Date.parse(resetsAt) + RESUME_AFTER_MS);
});

test("a limit with no reset: the stored window's reset, else a re-check in 2 minutes", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  const machineId = await computerAgent(f, { brainFallback: false });
  const refused = (): BrainEvent[] => [
    { type: "limit" },
    { type: "error", code: "plan_limit", message: "usage limit reached", worked: true },
  ];
  const { brain } = scripted(refused);
  const handlers = handlersWith(f, brain);
  const windowReset = later(3 * 3600_000).toISOString();
  await storeOwnUsage(f, machineId, {
    windows: [{ kind: "five_hour", usedPercent: 97, resetsAt: windowReset }],
    source: "turn",
    at: new Date().toISOString(),
  });
  const other = await post(f, "outra conversa");
  await post(f, "@dev um");
  await drainOutbox(f.db, handlers);
  const [a] = await runs(f);
  expect((await resumeJob(f, a?.id ?? ""))?.nextAttemptAt.getTime()).toBe(Date.parse(windowReset) + RESUME_AFTER_MS);

  await storeOwnUsage(f, machineId, { windows: [], source: "turn", at: new Date(0).toISOString() });
  clearPlanLimits();
  const before = Date.now();
  await post(f, "@dev dois", other.id);
  await drainOutbox(f.db, handlers);
  const [, b] = await runs(f);
  expect(b?.status).toBe("waiting_input");
  const at = (await resumeJob(f, b?.id ?? ""))?.nextAttemptAt.getTime() ?? 0;
  // Behind the head of the same plan's line, with no reset known: only the head asks the plan again. This one sleeps
  // on the safety timer, one gap later, and goes on when the head gets through.
  expect(at).toBeGreaterThanOrEqual(before + LINE_SAFETY_MS + RESUME_AFTER_MS + RESUME_GAP_MS);
  expect(at).toBeLessThan(Date.now() + LINE_SAFETY_MS + RESUME_AFTER_MS + RESUME_GAP_MS + 1000);

  // The head alone, with no reset known: the re-checks of the ladder (2 minutes first).
  await f.db.delete(schema.agentRuns);
  const start = Date.now();
  await post(f, "@dev três");
  await drainOutbox(f.db, handlers);
  const [head] = await runs(f);
  const first = (await resumeJob(f, head?.id ?? ""))?.nextAttemptAt.getTime() ?? 0;
  expect(first).toBeGreaterThanOrEqual(start + 2 * 60_000 + RESUME_AFTER_MS);
  expect(first).toBeLessThan(Date.now() + 2 * 60_000 + RESUME_AFTER_MS + 1000);
});

test("runs waiting on one plan resume 60 s apart, people's first; a resume still limited parks again quietly", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  const machineId = await computerAgent(f, { brainFallback: false });
  const reset = Date.now() + 3600_000;
  await storeOwnUsage(f, machineId, {
    windows: [{ kind: "five_hour", usedPercent: 100, resetsAt: new Date(reset).toISOString() }],
    source: "turn",
    at: new Date().toISOString(),
  });
  const { brain } = scripted(() => [{ type: "done", text: "oi" }]);
  const handlers = handlersWith(f, brain);
  const root = await post(f, "três conversas");
  const roots = [root.id, (await post(f, "outra")).id, (await post(f, "mais uma")).id];
  // The first one is a routine's (background): nobody waits on it.
  await post(f, "@dev a", roots[0]);
  await drainOutbox(f.db, handlers);
  const [bg] = await runs(f);
  await f.db
    .update(schema.agentRuns)
    .set({ background: true })
    .where(eq(schema.agentRuns.id, bg?.id ?? ""));
  await post(f, "@dev b", roots[1]);
  await drainOutbox(f.db, handlers);
  await post(f, "@dev c", roots[2]);
  await drainOutbox(f.db, handlers);
  const [a, b, c] = await runs(f);
  const at = async (id?: string) => (await resumeJob(f, id ?? ""))?.nextAttemptAt.getTime();
  expect(await at(b?.id)).toBe(reset + RESUME_AFTER_MS);
  expect(await at(c?.id)).toBe(reset + RESUME_AFTER_MS + RESUME_GAP_MS);
  expect(await at(a?.id)).toBe(reset + RESUME_AFTER_MS + 2 * RESUME_GAP_MS);

  // Its job runs while the plan is still at its limit: it parks again, with no second note.
  await drainOutbox(f.db, handlers, { now: new Date(reset + RESUME_AFTER_MS + 1000) });
  const again = (await runs(f)).find((r) => r.id === b?.id);
  expect(again?.status).toBe("waiting_input");
  expect(await notes(f, "plan_limit_wait", roots[1])).toHaveLength(1);
});

test("a plan still silent about its reset after a day: the agent's owner hears it once", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  await computerAgent(f, { brainFallback: false });
  const { brain } = scripted(() => [
    { type: "limit" },
    { type: "error", code: "plan_limit", message: "usage limit reached", worked: true },
  ]);
  const handlers = handlersWith(f, brain);
  await post(f, "@dev um");
  await drainOutbox(f.db, handlers);
  const heard = () =>
    f.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "plan_reset_unknown"));
  expect(await heard()).toHaveLength(0);
  const waitedADay = async () => {
    const [run] = await runs(f);
    const t = run?.transcript as { usageWait: { since: number } };
    t.usageWait.since = Date.now() - 25 * 3600_000;
    await f.db
      .update(schema.agentRuns)
      .set({ transcript: t as never })
      .where(eq(schema.agentRuns.id, run?.id ?? ""));
    await drainOutbox(f.db, handlers, { now: later(3 * 3600_000) });
  };
  await waitedADay();
  const [notice] = await heard();
  expect(notice?.userId).toBe(f.owner.id);
  expect(notice?.latest).toMatchObject({ title: "Claude" });
  await waitedADay();
  expect(await heard()).toHaveLength(1);
});

test("the budget's wall: the run waits for the next month or a raise, and goes on with what it had", async () => {
  f = await setup({ budgetNanoUsd: 0, reply: () => ({ chunks: ["Feito pela API."] }) });
  await post(f, "@dev resume o relatório");
  await drainOutbox(f.db, f.handlers);
  const [run] = await runs(f);
  expect(run?.status).toBe("waiting_input");
  expect(f.provider.calls).toHaveLength(0);
  expect((run?.transcript as { waitingForBrain?: { code: string } } | undefined)?.waitingForBrain?.code).toBe("budget");
  const [note] = await notes(f, "budget_wait");
  expect(note?.meta.usageWait).toEqual({
    code: "budget",
    runId: run?.id,
    forUserId: f.owner.id,
    resetsAt: new Date(nextMonthStart(Date.now())).toISOString(),
  });
  expect((await resumeJob(f, run?.id ?? ""))?.nextAttemptAt.getTime()).toBe(
    nextMonthStart(Date.now()) + RESUME_AFTER_MS,
  );
  const messagesBefore = (run?.transcript as { messages: unknown[] } | undefined)?.messages ?? [];

  // A raise that is still too small: it looks again and parks again quietly.
  await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { monthlyBudgetNanoUsd: 1 });
  await drainOutbox(f.db, f.handlers);
  expect((await runs(f))[0]?.status).toBe("waiting_input");
  expect(f.provider.calls).toHaveLength(0);
  expect(await notes(f, "budget_wait")).toHaveLength(1);

  // A real raise: it goes on at once, with the same conversation it had.
  await updateAgent(f.db, f.owner.id, f.org.id, f.agent.id, { monthlyBudgetNanoUsd: 10_000_000_000 });
  await drainOutbox(f.db, f.handlers);
  expect((await runs(f))[0]?.status).toBe("done");
  expect(f.provider.calls).toHaveLength(1);
  expect(f.provider.calls[0]?.request.messages.slice(0, messagesBefore.length)).toEqual(messagesBefore as never);
  expect((await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).at(-1)?.body).toBe("Feito pela API.");
});

test("fallen back to the API and out of budget: it looks again when its own plan resets, not next month", async () => {
  f = await setup({ budgetNanoUsd: 0, reply: () => ({ chunks: ["pela API"] }) });
  await computerAgent(f);
  const resetsAt = later(3600_000).toISOString();
  const { brain } = scripted(() => [
    { type: "limit", resetsAt },
    { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: false },
  ]);
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlersWith(f, brain));
  const [run] = await runs(f);
  expect(run?.status).toBe("waiting_input");
  expect((run?.transcript as { waitingForBrain?: { code: string } } | undefined)?.waitingForBrain?.code).toBe("budget");
  expect((await resumeJob(f, run?.id ?? ""))?.nextAttemptAt.getTime()).toBe(Date.parse(resetsAt) + RESUME_AFTER_MS);
  const [note] = await notes(f, "budget_wait");
  expect(note?.meta.usageWait).toEqual({
    code: "budget",
    runId: run?.id,
    forUserId: f.owner.id,
    resetsAt: new Date(nextMonthStart(Date.now())).toISOString(),
  });
});

test("other runs' reservations filling the budget: the run looks again in minutes, quietly", async () => {
  f = await setup({ budgetNanoUsd: 1_000_000_000, reply: () => ({ chunks: ["ok"] }) });
  const first = await post(f, "@dev um");
  await drainOutbox(f.db, f.handlers);
  await f.db.insert(schema.budgetReservations).values({
    orgId: f.org.id,
    agentId: f.agent.id,
    periodStart: `${new Date().toISOString().slice(0, 8)}01`,
    amountNanoUsd: 999_900_000,
    expiresAt: later(60_000),
  });
  await f.db.update(schema.agentBudgetPeriods).set({ reservedNanoUsd: 999_900_000 });
  const before = Date.now();
  await post(f, "@dev dois", first.id);
  await drainOutbox(f.db, f.handlers);
  const [, run] = await runs(f);
  expect(run?.status).toBe("waiting_input");
  const at = (await resumeJob(f, run?.id ?? ""))?.nextAttemptAt.getTime() ?? 0;
  expect(at).toBeGreaterThanOrEqual(before + 2 * 60_000);
  expect(at).toBeLessThan(Date.now() + 2 * 60_000 + RESUME_AFTER_MS + 1000);
  expect(await notes(f, "budget_wait", first.id)).toHaveLength(0);
});

test("a routine waiting on the plan says so in Rotinas, not running, and its people hear it once", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  await computerAgent(f);
  const { brain } = scripted(() => [
    { type: "limit", resetsAt: later(3600_000).toISOString() },
    { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: false },
  ]);
  const handlers = handlersWith(f, brain);
  const deps = { db: f.db, pubsub: f.pubsub, context: f.context };
  const routine = await createRoutine(deps, f.owner.id, f.org.id, {
    name: "Deploys",
    agentId: f.agent.id,
    prompt: "Check the deploys.",
    target: { type: "channel", channelId: f.general.id },
    trigger: { type: "schedule", phrase: "todo dia às 8h" },
  });
  await runRoutineNow(deps, f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, handlers);
  const [run] = await runs(f);
  expect(run?.status).toBe("waiting_input");
  expect(f.provider.calls).toHaveLength(0);
  const [view] = await listRoutines(f.db, f.owner.id, f.org.id);
  // Stopped at the plan's own limit: it waits for the Claude plan, with nothing to continue.
  expect(view?.state).toBe("usage_paused");
  expect(view?.usagePause?.limit).toBe(true);
  expect(view?.usagePause?.plan).toBe("Claude");
  expect(view?.usagePause?.resetsAt).toBeString();
  expect([view?.recentRuns[0]?.status, view?.recentRuns[0]?.code]).toEqual(["waiting", "waiting_plan"]);
  const heard = () =>
    f.db.select().from(schema.notifications).where(eq(schema.notifications.kind, "routine_waiting_plan"));
  expect((await heard()).map((n) => n.userId)).toEqual([f.owner.id]);
  // Its resume finds the plan still limited: it parks again, and nobody hears it twice.
  await drainOutbox(f.db, handlers, { now: later(3600_000 + RESUME_AFTER_MS + 1000) });
  expect((await runs(f))[0]?.status).toBe("waiting_input");
  expect((await heard())[0]?.count ?? 1).toBe(1);
  expect(await heard()).toHaveLength(1);
});

test("a routine slot that waited on the plan past 12 hours is missed for the plan; one cut mid-work isn't", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  const machineId = await computerAgent(f);
  await storeOwnUsage(f, machineId, {
    windows: [{ kind: "five_hour", usedPercent: 100, resetsAt: later(3600_000).toISOString() }],
    source: "turn",
    at: new Date().toISOString(),
  });
  const { brain } = scripted(() => [{ type: "done", text: "ok" }]);
  const handlers = handlersWith(f, brain);
  const deps = { db: f.db, pubsub: f.pubsub, context: f.context };
  const routine = await createRoutine(deps, f.owner.id, f.org.id, {
    name: "Deploys",
    agentId: f.agent.id,
    prompt: "Check the deploys.",
    target: { type: "channel", channelId: f.general.id },
    trigger: { type: "schedule", phrase: "todo dia às 8h" },
  });
  await runRoutineNow(deps, f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, handlers);
  const [run] = await runs(f);
  expect(run?.status).toBe("waiting_input");
  await f.db.update(schema.routineRuns).set({ at: new Date(Date.now() - 13 * 3600_000) });
  const setCut = async (cut: boolean) => {
    const [r] = await runs(f);
    const t = r?.transcript as { interruptedTurn?: unknown };
    if (cut) t.interruptedTurn = { prompt: "Check the deploys.", executed: [], drops: 0, cause: "plan_limit" };
    else delete t.interruptedTurn;
    await f.db
      .update(schema.agentRuns)
      .set({ transcript: t as never })
      .where(eq(schema.agentRuns.id, r?.id ?? ""));
  };
  await setCut(true);
  await drainOutbox(f.db, handlers, { now: later(3600_000 + RESUME_AFTER_MS + 1000) });
  expect((await runs(f))[0]?.status).toBe("waiting_input");
  const [open] = await f.db.select().from(schema.routineRuns);
  expect(open?.status).not.toBe("missed");

  await setCut(false);
  await drainOutbox(f.db, handlers, { now: later(2 * 3600_000 + RESUME_AFTER_MS + 1000) });
  const [missed] = await f.db.select().from(schema.routineRuns);
  expect([missed?.status, missed?.code]).toEqual(["missed", "waiting_plan_late"]);
});

test("a refusal known only from its words holds until the first window resets, never the next window's", () => {
  const at = Date.parse("2026-11-02T10:00:00Z");
  const usage: PlanUsage = {
    windows: [
      { kind: "five_hour", usedPercent: 97, resetsAt: "2026-11-02T14:00:00Z" },
      { kind: "seven_day", usedPercent: 40, resetsAt: "2026-11-07T10:00:00Z" },
    ],
    limited: true,
    source: "turn",
    at: new Date(at).toISOString(),
  };
  expect(storedPlanLimit(usage, at)).toEqual({ until: Date.parse("2026-11-02T14:00:00Z") });
  expect(storedPlanLimit(usage, Date.parse("2026-11-02T15:00:00Z"))).toBeNull();
  // No window known: it holds a while, then a turn asks the plan again.
  const bare: PlanUsage = { windows: [], limited: true, source: "turn", at: new Date(at).toISOString() };
  expect(storedPlanLimit(bare, at + 60_000)).toEqual({ until: null });
  expect(storedPlanLimit(bare, at + 3600_000)).toBeNull();
});

/** A scheduled slot of a routine of the agent's, started now. */
async function routineSlot(fx: Fixture) {
  const deps = { db: fx.db, pubsub: fx.pubsub, context: fx.context };
  const routine = await createRoutine(deps, fx.owner.id, fx.org.id, {
    name: "Resumo da manhã",
    agentId: fx.agent.id,
    prompt: "Summarize the night.",
    target: { type: "channel", channelId: fx.general.id },
    trigger: { type: "schedule", phrase: "todo dia às 8h" },
  });
  await runRoutineNow(deps, fx.owner.id, fx.org.id, routine.id);
  await fx.db.update(schema.routineRuns).set({ trigger: "schedule" });
  return routine.id;
}

test("a turn that goes through on the plan wakes the runs parked on its limit now, a routine's slot too", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  const machineId = await computerAgent(f, { brainFallback: false });
  // The reading a slot parked on said the reset is hours away (stale, or an unknown reset's re-checks).
  await storeOwnUsage(f, machineId, {
    windows: [{ kind: "five_hour", usedPercent: 100, resetsAt: later(3 * 3600_000).toISOString() }],
    source: "turn",
    at: new Date().toISOString(),
  });
  const { brain, seen } = scripted(() => [{ type: "done", text: "Resumo pronto." }]);
  const handlers = handlersWith(f, brain);
  await routineSlot(f);
  await drainOutbox(f.db, handlers);
  const [slot] = await runs(f);
  expect(slot?.status).toBe("waiting_input");

  // The plan has room again and a person's message goes through on it.
  await storeOwnUsage(f, machineId, { windows: [], source: "turn", at: new Date().toISOString() });
  clearPlanLimits();
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  expect(seen).toHaveLength(2);
  expect((await runs(f)).map((r) => r.status)).toEqual(["done", "done"]);
});

test("a wait on the plan whose wake job was lost is woken by the sweep once its time passed, again if that fails", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  await computerAgent(f, { brainFallback: false });
  const { brain, seen } = scripted((n) =>
    n === 0
      ? [
          { type: "limit", resetsAt: later(150).toISOString() },
          { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: false },
        ]
      : [{ type: "done", text: "Resumo pronto." }],
  );
  const handlers = handlersWith(f, brain);
  await routineSlot(f);
  await drainOutbox(f.db, handlers);
  const [slot] = await runs(f);
  expect(slot?.status).toBe("waiting_input");
  const job = await resumeJob(f, slot?.id ?? "");
  // Its job died (it failed its attempts, or was lost): nothing else would ever wake it.
  await f.db
    .update(schema.outbox)
    .set({ status: "failed" })
    .where(eq(schema.outbox.id, job?.id ?? ""));
  await Bun.sleep(200);
  const swept = await recoverStaleRuns({ db: f.db, pubsub: f.pubsub }, { now: later(RESUME_AFTER_MS + 3 * 60_000) });
  expect(swept.requeued).toEqual([slot?.id ?? ""]);
  // The sweep's own job fails too (the database away at the reset): a later sweep tries again.
  await f.db
    .update(schema.outbox)
    .set({ status: "failed" })
    .where(and(eq(schema.outbox.status, "pending"), eq(schema.outbox.kind, "agent_run.execute")));
  const again = await recoverStaleRuns({ db: f.db, pubsub: f.pubsub }, { now: later(RESUME_AFTER_MS + 4 * 60_000) });
  expect(again.requeued).toEqual([slot?.id ?? ""]);
  await drainOutbox(f.db, handlers, { now: later(RESUME_AFTER_MS + 4 * 60_000) });
  expect(seen).toHaveLength(2);
  expect((await runs(f))[0]?.status).toBe("done");
});

test("back from a wait on the plan, the agent's status moves at once: the apps don't keep saying it waits", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  await computerAgent(f, { brainFallback: false });
  const statusEvents: unknown[] = [];
  f.pubsub.subscribe(orgTopic(f.org.id), (e) => {
    if ((e as { event?: { type?: string } }).event?.type === "agent.status") statusEvents.push(e);
  });
  let atResume = -1;
  const { brain } = scripted((n) => {
    if (n === 1) atResume = statusEvents.length;
    return n === 0
      ? [
          { type: "limit", resetsAt: later(150).toISOString() },
          { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: false },
        ]
      : [{ type: "done", text: "oi" }];
  });
  const handlers = handlersWith(f, brain);
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  // Waiting on its plan with nothing to fall back on: out of office, with how many conversations wait (ADR 0084 §12).
  const [status] = await loadAgentStatuses(f.db, f.org.id);
  expect(status).toMatchObject({ presence: "out", status: { kind: "out_of_plan", count: 1 } });
  const parked = statusEvents.length;
  await Bun.sleep(200);
  await drainOutbox(f.db, handlers, { now: later(RESUME_AFTER_MS + RESUME_GAP_MS) });
  // Told before its first turn back, not only when it ends.
  expect(atResume).toBeGreaterThan(parked);
});

test("Don't run it: who asked cancels a reply waiting on the plan; its note says so and nothing runs at the reset", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  await computerAgent(f, { brainFallback: false });
  const { brain, seen } = scripted(() => [
    { type: "limit", resetsAt: later(3600_000).toISOString() },
    { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: false },
  ]);
  const handlers = handlersWith(f, brain);
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  const [run] = await runs(f);
  const [note] = await notes(f, "plan_limit_wait");
  expect(note?.meta.usageWait).toMatchObject({ code: "plan_limit", runId: run?.id, forUserId: f.owner.id });

  await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, run?.id ?? "");
  expect((await runs(f))[0]?.status).toBe("canceled");
  const [after] = await notes(f, "plan_limit_wait");
  expect((after?.meta.usageWait as { canceled?: boolean } | undefined)?.canceled).toBe(true);
  expect(await resumeJob(f, run?.id ?? "")).toBeUndefined();
  // Still out of office (the plan is still at its limit), with nothing waiting anymore.
  const [status] = await loadAgentStatuses(f.db, f.org.id);
  expect(status?.status).toMatchObject({ kind: "out_of_plan" });
  expect(status?.status?.count).toBeUndefined();
  await drainOutbox(f.db, handlers, { now: later(3600_000 + RESUME_AFTER_MS + RESUME_GAP_MS) });
  expect(seen).toHaveLength(1);
});

test("one catch-up per conversation: a later ask joins the waiting run, its Não rodar stops both, and a new ask right after a cancel stays quiet", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  await computerAgent(f, { brainFallback: false });
  const resetsAt = later(3600_000).toISOString();
  const { brain } = scripted(() => [
    { type: "limit", resetsAt },
    { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: false },
  ]);
  const handlers = handlersWith(f, brain);
  const first = await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  // The channel's main timeline: a second ask joins the waiting run (no second run, no second note, no early look).
  const second = await post(f, "@dev e aí?");
  await drainOutbox(f.db, handlers);
  const [a, ...more] = await runs(f);
  expect(more).toHaveLength(0);
  expect(a?.status).toBe("waiting_input");
  expect(a?.pendingMessageIds).toEqual([second.id]);
  const looks = (await f.db.select().from(schema.outbox)).filter(
    (j) => j.kind === "agent_run.execute" && j.payload.runId === a?.id && j.status === "pending",
  );
  expect(looks.map((j) => j.dedupeKey)).toEqual([expect.stringContaining(":usage:")]);
  const [note, ...others] = await notes(f, "plan_limit_wait");
  expect(others).toHaveLength(0);
  expect(note?.meta.usageWait).toMatchObject({ runId: a?.id });
  // Each ask's receipt says it waits on the plan, not that the agent waits for an answer.
  const receiptOf = async (id: string) =>
    (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).find((m) => m.id === id)?.receipts?.handled[0];
  expect(await receiptOf(second.id)).toMatchObject({ status: "waiting_input", usage: "plan" });

  // Não rodar: the catch-up goes with what joined it, nothing is handed on to a run of its own.
  await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, a?.id ?? "");
  expect((await runs(f)).map((r) => r.status)).toEqual(["canceled"]);
  expect(await receiptOf(first.id)).toMatchObject({ status: "canceled" });
  expect(await receiptOf(second.id)).toMatchObject({ status: "canceled" });
  expect((await notes(f, "plan_limit_wait"))[0]?.meta.usageWait).toMatchObject({ canceled: true });

  // Asked again right after: the receipt says it waits, the note isn't repeated.
  await post(f, "@dev e agora?");
  await drainOutbox(f.db, handlers);
  expect((await runs(f))[1]?.status).toBe("waiting_input");
  expect(await notes(f, "plan_limit_wait")).toHaveLength(1);

  // A while after the cancel, a new ask is told again.
  await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, (await runs(f))[1]?.id ?? "");
  await f.db
    .update(schema.messages)
    .set({
      meta: {
        ...note?.meta,
        usageWait: {
          ...(note?.meta.usageWait as object),
          canceled: true,
          canceledAt: later(-CANCELED_NOTE_QUIET_MS - 1000).toISOString(),
        },
      },
    })
    .where(eq(schema.messages.id, note?.id ?? ""));
  await post(f, "@dev oi de novo");
  await drainOutbox(f.db, handlers);
  expect(await notes(f, "plan_limit_wait")).toHaveLength(2);
});

test("two people asking in a channel share one catch-up and one note: only who asked first, the owner or an admin stops it", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  await computerAgent(f, { brainFallback: false });
  const resetsAt = later(3600_000).toISOString();
  const { brain } = scripted(() => [
    { type: "limit", resetsAt },
    { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: false },
  ]);
  const handlers = handlersWith(f, brain);
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  const asked = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, f.general.id, {
    body: "@dev e eu?",
  });
  await drainOutbox(f.db, handlers);
  const [a, ...more] = await runs(f);
  expect(more).toHaveLength(0);
  expect(a?.pendingMessageIds).toEqual([asked.id]);
  expect(await notes(f, "plan_limit_wait")).toHaveLength(1);
  await expect(cancelRun({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, a?.id ?? "")).rejects.toThrow();
  expect((await runs(f))[0]?.status).toBe("waiting_input");
});

test("another reset is another note, and so is another conversation", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  await computerAgent(f, { brainFallback: false });
  let resetsAt = later(3600_000).toISOString();
  const { brain } = scripted(() => [
    { type: "limit", resetsAt },
    { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: false },
  ]);
  const handlers = handlersWith(f, brain);
  const other = await post(f, "outra conversa");
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  await post(f, "@dev e no fio?", other.id);
  await drainOutbox(f.db, handlers);
  expect(await notes(f, "plan_limit_wait")).toHaveLength(1);
  expect(await notes(f, "plan_limit_wait", other.id)).toHaveLength(1);
  // More in the thread goes into its waiting turn: the message's receipt says it waits on the plan, live too.
  const steered: { usage?: string }[] = [];
  f.pubsub.subscribe(channelTopic(f.general.id), (e) => {
    const event = e as { type?: string; usage?: string };
    if (event.type === "agent.run.steered") steered.push(event);
  });
  await post(f, "@dev mais uma", other.id);
  await drainOutbox(f.db, handlers);
  expect(steered).toEqual([expect.objectContaining({ usage: "plan" })]);
  expect(await notes(f, "plan_limit_wait", other.id)).toHaveLength(1);

  // A conversation's run gone, its next limit with another reset: a note of its own.
  await cancelRun({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, (await runs(f))[0]?.id ?? "");
  clearPlanLimits();
  resetsAt = later(5 * 3600_000).toISOString();
  await post(f, "@dev e agora?");
  await drainOutbox(f.db, handlers);
  expect(await notes(f, "plan_limit_wait")).toHaveLength(2);
});

test("Don't run it goes away once the run is back at work, and comes back if it parks on the limit again", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  await computerAgent(f, { brainFallback: false });
  const limit = (ms: number): BrainEvent[] => [
    { type: "limit", resetsAt: later(ms).toISOString() },
    { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: false },
  ];
  const { brain } = scripted((n) => (n < 2 ? limit(n === 0 ? 150 : 3600_000) : [{ type: "done", text: "oi" }]));
  const handlers = handlersWith(f, brain);
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  const ended = async () =>
    ((await notes(f, "plan_limit_wait"))[0]?.meta.usageWait as { ended?: boolean } | undefined)?.ended;
  expect(await ended()).toBeUndefined();

  // Back at the reset and still limited: parked again on the same note, which offers it again.
  await Bun.sleep(200);
  await drainOutbox(f.db, handlers, { now: later(RESUME_AFTER_MS + RESUME_GAP_MS) });
  expect((await runs(f))[0]?.status).toBe("waiting_input");
  expect(await notes(f, "plan_limit_wait")).toHaveLength(1);
  expect(await ended()).toBeUndefined();

  // Back again and the turn goes through: the note no longer offers to cancel.
  clearPlanLimits();
  await drainOutbox(f.db, handlers, { now: later(3600_000 + RESUME_AFTER_MS + RESUME_GAP_MS) });
  expect((await runs(f))[0]?.status).toBe("done");
  expect(await ended()).toBe(true);
});

test("a turn through on another model doesn't wake a wait parked on its own model's limit", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  const machineId = await computerAgent(f, { brainFallback: false });
  const { brain } = scripted(() => [
    { type: "limit", resetsAt: later(3600_000).toISOString() },
    { type: "error", code: "plan_limit", message: "You've hit your weekly limit", worked: false },
  ]);
  await routineSlot(f);
  await drainOutbox(f.db, handlersWith(f, brain));
  const [slot] = await runs(f);
  expect(slot?.status).toBe("waiting_input");
  const parkedOn = (slot?.transcript as { waitingForBrain?: { model?: string | null } } | undefined)?.waitingForBrain
    ?.model;
  const key = usageWaitKey({ code: "plan_limit", machineId, kind: "claude_code" });
  expect(await wakePlanWaits(f.db, f.org.id, key, "another-model")).toEqual([]);
  expect(await wakePlanWaits(f.db, f.org.id, key, parkedOn ?? null)).toEqual([slot?.id ?? ""]);
});

test("the line keeps its order on a second hit: the head parks again in its place and the rest wait behind it, 60 s apart", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  await computerAgent(f, { brainFallback: false });
  const first = Date.now() + 3600_000;
  let resetsAt = new Date(first).toISOString();
  const { brain } = scripted(() => [
    { type: "limit", resetsAt },
    { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: false },
  ]);
  const handlers = handlersWith(f, brain);
  const roots = [(await post(f, "um")).id, (await post(f, "dois")).id, (await post(f, "três")).id];
  for (const root of roots) {
    await post(f, "@dev oi", root);
    await drainOutbox(f.db, handlers);
  }
  const [a, b, c] = await runs(f);
  const at = async (id?: string) => (await resumeJob(f, id ?? ""))?.nextAttemptAt.getTime();
  expect([await at(a?.id), await at(b?.id), await at(c?.id)]).toEqual([
    first + RESUME_AFTER_MS,
    first + RESUME_AFTER_MS + RESUME_GAP_MS,
    first + RESUME_AFTER_MS + 2 * RESUME_GAP_MS,
  ]);

  // At the reset the head finds the plan full again, with a later reset: it keeps its place, the others move with it.
  clearPlanLimits();
  const second = first + 2 * 3600_000;
  resetsAt = new Date(second).toISOString();
  await drainOutbox(f.db, handlers, { now: new Date(first + RESUME_AFTER_MS + 1000) });
  expect((await runs(f)).map((r) => r.status)).toEqual(["waiting_input", "waiting_input", "waiting_input"]);
  expect([await at(a?.id), await at(b?.id), await at(c?.id)]).toEqual([
    second + RESUME_AFTER_MS,
    second + RESUME_AFTER_MS + RESUME_GAP_MS,
    second + RESUME_AFTER_MS + 2 * RESUME_GAP_MS,
  ]);
  // Its note tells the new time.
  expect((await notes(f, "plan_limit_wait", roots[0]))[0]?.meta.usageWait).toMatchObject({ resetsAt });
});

test("a raised budget wakes the waiting conversations in line order, 60 s apart", async () => {
  f = await setup({ budgetNanoUsd: 0, reply: () => ({ chunks: ["Feito pela API."] }) });
  const roots = [(await post(f, "um")).id, (await post(f, "dois")).id];
  for (const root of roots) {
    await post(f, "@dev oi", root);
    await drainOutbox(f.db, f.handlers);
  }
  const [a, b] = await runs(f);
  const now = Date.now();
  await resumeBudgetWaits(f.db, f.org.id, f.agent.id, now);
  const jobs = (await f.db.select().from(schema.outbox)).filter(
    (j) => j.status === "pending" && String(j.dedupeKey).includes(":budget_raised:"),
  );
  const timeOf = (id?: string) => jobs.find((j) => j.payload.runId === id)?.nextAttemptAt.getTime();
  expect([timeOf(a?.id), timeOf(b?.id)]).toEqual([now, now + RESUME_GAP_MS]);
});

test("a stopped turn's note speaks on for the turns it took in, and the archive ends the line with a reason", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  await computerAgent(f, { brainFallback: false });
  const { brain } = scripted(() => [
    { type: "limit", resetsAt: later(3600_000).toISOString() },
    { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: false },
  ]);
  const handlers = handlersWith(f, brain);
  await post(f, "@dev oi");
  await drainOutbox(f.db, handlers);
  const [a] = await runs(f);
  // A second turn on the same note (a run that didn't join, as one from before catch-ups did).
  const [note] = await notes(f, "plan_limit_wait");
  const extra = await post(f, "@dev e aí?");
  await drainOutbox(f.db, handlers);
  await f.db
    .update(schema.agentRuns)
    .set({ pendingMessageIds: [] })
    .where(eq(schema.agentRuns.id, a?.id ?? ""));
  const [b] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: extra.id,
      triggerMessageId: extra.id,
      trigger: "mention",
      hop: 1,
      status: "waiting_input",
      transcript: { waitingForBrain: { code: "plan_limit", machineId: "", kind: "claude_code" } } as never,
    })
    .returning();
  await f.db
    .update(schema.messages)
    .set({ meta: { ...note?.meta, usageWait: { ...(note?.meta.usageWait as object), runIds: [b?.id] } } })
    .where(eq(schema.messages.id, note?.id ?? ""));

  // The system stops the first turn: the note isn't canceled, the joined turn holds it now.
  const [run] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, a?.id ?? ""));
  await stopRun({ db: f.db, pubsub: f.pubsub }, f.org.id, run as never, "channel", {
    type: "system",
    reason: "consultation_expired",
  });
  expect((await notes(f, "plan_limit_wait"))[0]?.meta.usageWait).toMatchObject({ runId: b?.id, runIds: [] });

  // Archived: the line won't run, and the note says why.
  await archiveAgent(f.db, f.owner.id, f.org.id, f.agent.id, f.pubsub);
  expect((await runs(f)).map((r) => r.status)).toEqual(["canceled", "canceled"]);
  expect((await notes(f, "plan_limit_wait"))[0]?.meta.usageWait).toMatchObject({ canceled: true, reason: "archived" });
});

test("back after a long wait, a conversation catches up: how long, what was posted since, and it may pass", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  await computerAgent(f, { brainFallback: false });
  const { brain, seen } = scripted((n) =>
    n === 0
      ? [
          { type: "limit", resetsAt: later(3600_000).toISOString() },
          { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: false },
        ]
      : [{ type: "done", text: "Respondido." }],
  );
  const handlers = handlersWith(f, brain);
  const nina = await addMember(f.db, f.org.id, "member", "nina");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: nina.id });
  await post(f, "@dev qual o status do deploy?");
  await drainOutbox(f.db, handlers);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, nina.id, f.org.id, f.general.id, {
    body: "O deploy terminou às 14h.",
  });
  await drainOutbox(f.db, handlers);
  // Paused two days ago.
  const [run] = await runs(f);
  const t = run?.transcript as { usageWait: { since: number } };
  t.usageWait.since = Date.now() - 2 * 24 * 3600_000;
  await f.db
    .update(schema.agentRuns)
    .set({ transcript: t as never })
    .where(eq(schema.agentRuns.id, run?.id ?? ""));
  clearPlanLimits();
  await drainOutbox(f.db, handlers, { now: later(3600_000 + RESUME_AFTER_MS + 1000) });
  expect(seen).toHaveLength(2);
  const prompt = String(seen[1]?.trigger ?? "");
  expect(prompt).toContain("# Catching up");
  expect(prompt).toContain("You were paused 2 days ago because the Claude plan hit its limit");
  expect(prompt).toContain("O deploy terminou às 14h.");
  expect(prompt).toContain("call `pass`");
  expect(prompt).toContain("ask whether it is still needed before starting long work");
  expect(await loadReplyPolicy(f.db, f.org.id, run?.id ?? "")).toMatchObject({ mayPass: true, listsPass: true });
});

test("long work waiting in the agent's line of work reads as in line, not as waiting for your answer", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  const asked = await post(f, "@dev um trabalho longo");
  await drainOutbox(f.db, f.handlers);
  const [run] = await runs(f);
  await f.db
    .update(schema.agentRuns)
    .set({
      status: "waiting_input",
      transcript: { waitingForBrain: { code: "work_queue", machineId: "", kind: "model" } } as never,
    })
    .where(eq(schema.agentRuns.id, run?.id ?? ""));
  const shown = (await listMessages(f.db, f.owner.id, f.org.id, f.general.id)).find((m) => m.id === asked.id);
  expect(shown?.receipts?.handled[0]).toMatchObject({ status: "waiting_input", computer: "line" });
});

test("the usage queue: rows in line order with what happened since, hidden rows counted, Don't run any for the owner", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  await computerAgent(f, { brainFallback: false });
  const { brain } = scripted(() => [
    { type: "limit", resetsAt: later(3600_000).toISOString() },
    { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: false },
  ]);
  const handlers = handlersWith(f, brain);
  const nina = await addMember(f.db, f.org.id, "member", "nina");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: nina.id });
  const root = await post(f, "um assunto");
  await post(f, "@dev oi", root.id);
  await drainOutbox(f.db, handlers);
  await post(f, "@dev e aí?");
  await drainOutbox(f.db, handlers);
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, nina.id, f.org.id, f.general.id, {
    body: "Já respondi isso",
    threadId: root.id,
  });
  const [a, b] = await runs(f);
  const q = await usageQueue(f.db, f.owner.id, f.org.id, f.agent.id);
  expect(q).toMatchObject({ reason: "plan", plan: "Claude", hidden: 0, mayStopAll: true });
  expect(q.rows.map((r) => r.runId)).toEqual([a?.id ?? "", b?.id ?? ""]);
  expect(q.rows[0]).toMatchObject({
    kind: "conversation",
    threadId: root.id,
    // A reply in the thread joins its catch-up: Nina is one more person waiting on it.
    askers: [f.owner.id, nina.id],
    state: "queued",
    mayStop: true,
    after: { count: 1, names: ["nina"] },
  });
  expect(q.rows[1]).toMatchObject({ threadId: null, after: { count: 0, names: [] } });

  // Nina joined one catch-up, she didn't start either: she sees the rows, can't stop them, nor all of them.
  const theirs = await usageQueue(f.db, nina.id, f.org.id, f.agent.id);
  expect(theirs.rows.map((r) => r.mayStop)).toEqual([false, false]);
  expect(theirs.mayStopAll).toBe(false);
  await expect(cancelUsageQueue({ db: f.db, pubsub: f.pubsub }, nina.id, f.org.id, f.agent.id)).rejects.toThrow();

  // Someone outside the channel sees none of it, only how many.
  const bob = await addMember(f.db, f.org.id, "member", "bob");
  expect(await usageQueue(f.db, bob.id, f.org.id, f.agent.id)).toMatchObject({ rows: [], hidden: 2 });

  expect(await cancelUsageQueue({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.agent.id)).toEqual({
    canceled: 2,
    skipped: 0,
  });
  expect((await runs(f)).map((r) => r.status)).toEqual(["canceled", "canceled"]);
});

test("who asked stops only their own ask: someone else's that joined the catch-up still gets its answer", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  await computerAgent(f, { brainFallback: false });
  const { brain } = scripted(() => [
    { type: "limit", resetsAt: later(3600_000).toISOString() },
    { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: false },
  ]);
  const handlers = handlersWith(f, brain);
  const deps = { db: f.db, pubsub: f.pubsub };
  const ana = await addMember(f.db, f.org.id, "member", "ana");
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  for (const u of [ana, bia]) await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: u.id });
  await postPersonMessage(deps, ana.id, f.org.id, f.general.id, { body: "@dev oi" });
  await drainOutbox(f.db, handlers);
  const mine = await postPersonMessage(deps, ana.id, f.org.id, f.general.id, { body: "@dev e aí?" });
  const theirs = await postPersonMessage(deps, bia.id, f.org.id, f.general.id, { body: "@dev e eu?" });
  await drainOutbox(f.db, handlers);
  const [a] = await runs(f);
  expect(a?.pendingMessageIds).toEqual([mine.id, theirs.id]);

  await cancelRun(deps, ana.id, f.org.id, a?.id ?? "");
  await drainOutbox(f.db, handlers);
  const [, b, ...more] = await runs(f);
  expect(more).toHaveLength(0);
  // Bia's ask waits in a run of its own; Ana's went with her stop.
  expect(b).toMatchObject({ status: "waiting_input", triggerMessageId: theirs.id });
  expect(b?.pendingMessageIds).not.toContain(mine.id);
});

test("a line holds one head per reset: a wait on another model's own limit keeps its own timers", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  const key = "plan:m:claude_code:own";
  const wait = (model: string | null, since: number) =>
    ({ waitingForBrain: { code: "plan_limit", waitKey: key, model, since } }) as never;
  const park = async (model: string | null, since: number) => {
    // Each in a thread of its own: in the main timeline the next ask would join the waiting one.
    const m = await post(f, "@dev oi", (await post(f, "assunto")).id);
    const [r] = await f.db
      .update(schema.agentRuns)
      .set({ status: "waiting_input", transcript: wait(model, since) })
      .where(eq(schema.agentRuns.triggerMessageId, m.id))
      .returning();
    return r as typeof schema.agentRuns.$inferSelect;
  };
  const opus = await park("opus", 1);
  const sonnet = await park("", 2);
  const late = await park("", 3);
  // The default model's first wait heads its own reset, behind the Opus one in line; only its own kind is behind it.
  expect(await usageWaitPlace(f.db, sonnet, key, 2, "")).toEqual({ place: 1, head: true, behind: [late.id] });
  expect(await usageWaitPlace(f.db, late, key, 3, "")).toEqual({ place: 2, head: false, behind: [] });
  expect(await usageWaitPlace(f.db, opus, key, 1, "opus")).toEqual({ place: 0, head: true, behind: [] });
});

test("a catch-up cut mid-work reads what it missed but owes what it started: no pass", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  await computerAgent(f, { brainFallback: false });
  const { brain, seen } = scripted((n) =>
    n === 0
      ? [
          { type: "limit", resetsAt: later(3600_000).toISOString() },
          { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: false },
        ]
      : [{ type: "done", text: "Feito." }],
  );
  const handlers = handlersWith(f, brain);
  await post(f, "@dev roda o deploy");
  await drainOutbox(f.db, handlers);
  const [run] = await runs(f);
  const t = run?.transcript as { usageWait: { since: number }; executedCalls?: number };
  t.usageWait.since = Date.now() - 3600_000;
  t.executedCalls = 2;
  await f.db
    .update(schema.agentRuns)
    .set({ transcript: t as never })
    .where(eq(schema.agentRuns.id, run?.id ?? ""));
  clearPlanLimits();
  await drainOutbox(f.db, handlers, { now: later(3600_000 + RESUME_AFTER_MS + 1000) });
  const prompt = String(seen[1]?.trigger ?? "");
  expect(prompt).toContain("# Catching up");
  expect(prompt).not.toContain("call `pass`");
  expect(await loadReplyPolicy(f.db, f.org.id, run?.id ?? "")).toMatchObject({ mayPass: false });
});

// ── The check before a catch-up (ADR 0136) ─────────────────────────────────────────────────────────────────────

type JudgeFn = NonNullable<Parameters<typeof setup>[0]>["judge"];

/** A check that answers every asker the same: `status` sure at `p`, and `who` the participant named so. */
const checks =
  (status: "solved" | "not_needed" | "needs_agent", who: string | null, p = 0.95): JudgeFn =>
  (kind, id, state) => {
    if (kind !== "catch_up_triage") return undefined;
    if (id.startsWith("status_")) {
      const rest = (1 - p) / 2;
      const probabilities = { needs_agent: rest, solved: rest, not_needed: rest, [status]: p };
      return { choice: status, probabilities };
    }
    const people = state.participants as Record<string, { name: string }>;
    const key = Object.entries(people).find(([, x]) => x.name === who)?.[0] ?? "nobody";
    return { choice: key, probabilities: { [key]: 0.95 } };
  };

const triageCalls = (fx: Fixture) =>
  (fx.jobDeps.context.judge as unknown as { calls: { kind: string }[] }).calls.filter(
    (c) => c.kind === "catch_up_triage",
  );

/**
 * Bia asks @dev in #general and the plan is out; Nina answers meanwhile (`answered`); the pause started two days ago.
 * `resume` drains past the reset.
 */
async function pausedAsk(judge: JudgeFn, o: { answered?: boolean; judgeOverride?: Judge } = {}) {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }), judge });
  await computerAgent(f, { brainFallback: false });
  const { brain, seen } = scripted((n) =>
    n === 0
      ? [
          { type: "limit", resetsAt: later(3600_000).toISOString() },
          { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: false },
        ]
      : [{ type: "done", text: "Respondido." }],
  );
  const handlers = o.judgeOverride
    ? createJobHandlers({
        ...f.jobDeps,
        context: { ...f.jobDeps.context, judge: o.judgeOverride },
        brains: { claude_code: () => brain },
        machines: { status: async (id) => statusOf(id) },
        planLimitGraceMs: 50,
      })
    : handlersWith(f, brain);
  const deps = { db: f.db, pubsub: f.pubsub };
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const nina = await addMember(f.db, f.org.id, "member", "nina");
  for (const u of [bia, nina]) await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: u.id });
  const asked = await postPersonMessage(deps, bia.id, f.org.id, f.general.id, { body: "@dev o deploy saiu?" });
  await drainOutbox(f.db, handlers);
  if (o.answered !== false)
    await postPersonMessage(deps, nina.id, f.org.id, f.general.id, { body: "Saiu às 14h, está em produção." });
  await drainOutbox(f.db, handlers);
  await pausedLongAgo(f);
  clearPlanLimits();
  const resume = () => drainOutbox(f.db, handlers, { now: later(3600_000 + RESUME_AFTER_MS + 1000) });
  return { handlers, seen, bia, nina, asked, deps, resume };
}

/** Every waiting run paused two days ago. */
async function pausedLongAgo(fx: Fixture) {
  for (const run of await runs(fx)) {
    if (run.status !== "waiting_input") continue;
    const t = run.transcript as { usageWait: { since: number } };
    t.usageWait.since = Date.now() - 2 * 24 * 3600_000;
    await fx.db
      .update(schema.agentRuns)
      .set({ transcript: t as never })
      .where(eq(schema.agentRuns.id, run.id));
  }
}

const triageSteps = async (fx: Fixture, runId: string) =>
  (await fx.db.select().from(schema.agentRunSteps).where(eq(schema.agentRunSteps.runId, runId)))
    .map((s) => (s.data as { catchUpTriage?: { outcome: string } }).catchUpTriage)
    .filter(Boolean);

const noticesOf = (fx: Fixture, kind: string) =>
  fx.db.select().from(schema.notifications).where(eq(schema.notifications.kind, kind));

test("a catch-up someone else already answered ends quietly: no turn, the note says who, who asked and the owner hear it", async () => {
  const { seen, bia, resume } = await pausedAsk(checks("solved", "nina"));
  const [run] = await runs(f);
  await resume();
  // Zero turns at the resume: the only one is the turn that hit the limit.
  expect(seen).toHaveLength(1);
  expect(triageCalls(f)).toHaveLength(1);
  const [done] = await runs(f);
  expect(done?.status).toBe("done");
  expect(done?.pendingMessageIds).toEqual([]);
  const [note] = await notes(f, "plan_limit_wait");
  expect(note?.meta.usageWait).toMatchObject({
    ended: true,
    closed: { reason: "solved", who: { name: "nina" }, askers: [bia.id] },
  });
  expect(await triageSteps(f, run?.id ?? "")).toEqual([expect.objectContaining({ outcome: "closed", calls: 1 })]);
  // Who asked hears someone else was credited; the owner hears the line skipped one. Neither pushes.
  const [asker] = await noticesOf(f, "catch_up_closed_asker");
  expect(asker).toMatchObject({ userId: bia.id, latest: { title: "nina", reason: "solved" } });
  expect((await noticesOf(f, "catch_up_closed")).map((n) => [n.userId, n.count])).toEqual([[f.owner.id, 1]]);
  expect(noticeCategoryOf("catch_up_closed", false)).toBeNull();
  expect(noticeCategoryOf("catch_up_closed_asker", false)).toBeNull();
  // The queue keeps it for a day, with "Responder mesmo assim" for who asked.
  const queue = await usageQueue(f.db, bia.id, f.org.id, f.agent.id);
  expect(queue.closed).toEqual([
    expect.objectContaining({ runId: run?.id, messageId: note?.id, mayAnswer: true, continuedRunId: null }),
  ]);
});

test("Responder mesmo assim: one run that reads the catch-up and can't pass; who asked may press it, once, and the conversation isn't skipped again", async () => {
  const { seen, bia, nina, deps, resume, handlers } = await pausedAsk(checks("solved", "nina"));
  await resume();
  const [closed] = await runs(f);
  // Nina neither asked nor owns the agent.
  await expect(continueRun(deps, nina.id, f.org.id, closed?.id ?? "")).rejects.toThrow();
  const { runId } = await continueRun(deps, bia.id, f.org.id, closed?.id ?? "");
  await expect(continueRun(deps, f.owner.id, f.org.id, closed?.id ?? "")).rejects.toThrow();
  expect(await loadReplyPolicy(f.db, f.org.id, runId)).toMatchObject({ mayPass: false });
  await drainOutbox(f.db, handlers);
  expect(seen).toHaveLength(2);
  const prompt = JSON.stringify(seen[1]);
  expect(prompt).toContain("bia asked you to answer this anyway. A quick check had judged it already handled by nina.");
  expect(prompt).toContain("# Catching up");
  expect(prompt).toContain("Saiu às 14h");
  expect(prompt).not.toContain("call `pass`");
  const [note] = await notes(f, "plan_limit_wait");
  expect(note?.meta.usageWait).toMatchObject({ continuedRunId: runId, continuedByUserId: bia.id });
  // Overruled: for a week no check skips this agent's catch-ups in this conversation.
  const [old] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, closed?.id ?? ""));
  expect((old?.transcript as { catchUpTriage?: { overruledBy: string } } | undefined)?.catchUpTriage?.overruledBy).toBe(
    bia.id,
  );
  const another = {
    ...(old as NonNullable<typeof old>),
    id: Bun.randomUUIDv7(),
    threadRootId: "x",
    triggerMessageId: "x",
  };
  another.threadRootId = another.triggerMessageId = Bun.randomUUIDv7();
  expect(await overruledHere(f.db, another)).toBe(true);
  expect((await usageQueue(f.db, bia.id, f.org.id, f.agent.id)).closed[0]).toMatchObject({
    mayAnswer: false,
    continuedRunId: runId,
  });
});

test("still open: the agent runs, told whose ask the check judged open", async () => {
  const { seen, resume } = await pausedAsk(checks("needs_agent", null));
  await resume();
  expect(seen).toHaveLength(2);
  expect(String(seen[1]?.trigger)).toContain(
    "A quick check judged bia's ask still open. It can be wrong, so read below.",
  );
  const [run] = await runs(f);
  expect(await triageSteps(f, run?.id ?? "")).toEqual([expect.objectContaining({ outcome: "run" })]);
});

test("a third party saying it's solved, with no source code can check, never closes: it runs", async () => {
  // The judge is fooled and sure, but credits Carla, who never posted, reacted or moved the task.
  const { seen, resume } = await pausedAsk(checks("solved", "carla"));
  await addMember(f.db, f.org.id, "member", "carla");
  await resume();
  expect(seen).toHaveLength(2);
  expect(String(seen[1]?.trigger)).toContain("A quick check couldn't tell whether this is still open.");
});

test("the check failing runs the catch-up as before, with no verdict", async () => {
  const throwing: Judge = {
    name: "jev",
    ask: async (r) => {
      if (r.kind === "catch_up_triage") throw new Error("TypeSafe didn't answer");
      return createFakeJudge().ask(r);
    },
  };
  const { seen, resume } = await pausedAsk(undefined, { judgeOverride: throwing });
  await resume();
  expect(seen).toHaveLength(2);
  expect(String(seen[1]?.trigger)).not.toContain("A quick check");
  const [run] = await runs(f);
  expect(await triageSteps(f, run?.id ?? "")).toEqual([expect.objectContaining({ outcome: "judge_error" })]);
});

test("nothing posted since the pause: no call, the agent just answers", async () => {
  const { seen, resume } = await pausedAsk(checks("solved", "nina"), { answered: false });
  await resume();
  expect(triageCalls(f)).toHaveLength(0);
  expect(seen).toHaveLength(2);
  const [run] = await runs(f);
  expect(await triageSteps(f, run?.id ?? "")).toEqual([expect.objectContaining({ outcome: "skipped_quiet" })]);
});

test("a message joining while the check answers makes it run", async () => {
  let posted = false;
  const fake = createFakeJudge(checks("solved", "nina"));
  const joining: Judge = {
    name: "jev",
    ask: async (r) => {
      if (r.kind === "catch_up_triage" && !posted) {
        posted = true;
        const [u] = await f.db.select().from(schema.users).where(eq(schema.users.name, "bia"));
        await postPersonMessage({ db: f.db, pubsub: f.pubsub }, u?.id ?? "", f.org.id, f.general.id, {
          body: "@dev ah, e o rollback?",
        });
      }
      return fake.ask(r);
    },
  };
  const { seen, resume } = await pausedAsk(undefined, { judgeOverride: joining });
  await resume();
  expect(posted).toBe(true);
  expect(seen).toHaveLength(2);
  const [run] = await runs(f);
  expect(run?.status).toBe("done");
  expect((await triageSteps(f, run?.id ?? "")).at(-1)).toMatchObject({ outcome: "unsure" });
});

test("another agent still answering in the conversation: the check waits 60 s with no call, then checks after 5 tries", async () => {
  const { handlers } = await pausedAsk(checks("solved", "nina"));
  const ada = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ada", handle: "ada" },
    { model: "claude-sonnet-5-5" },
  );
  const said = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "pergunta para a Ada",
  });
  await f.db.insert(schema.agentRuns).values({
    orgId: f.org.id,
    agentId: ada.id,
    channelId: f.general.id,
    threadRootId: said.id,
    triggerMessageId: said.id,
    trigger: "mention",
    hop: 1,
    stretchId: said.id,
    status: "running",
    heartbeatAt: later(3600_000 * 10),
  });
  const [waiting] = (await runs(f)).filter((r) => r.agentId === f.agent.id);
  const at = later(3600_000 + RESUME_AFTER_MS + 1000);
  setSystemTime(at);
  await drainOutbox(f.db, handlers);
  expect(triageCalls(f)).toHaveLength(0);
  expect((await resumeJob(f, waiting?.id ?? ""))?.nextAttemptAt.getTime()).toBe(at.getTime() + 60_000);
  const [still] = await f.db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, waiting?.id ?? ""));
  expect(still?.status).toBe("waiting_input");
  expect(
    (still?.transcript as { catchUpTriage?: { busyRetries: number } } | undefined)?.catchUpTriage?.busyRetries,
  ).toBe(1);
  // Ada is still at it after every try: the check goes ahead and reads what is there.
  await f.db
    .update(schema.agentRuns)
    .set({ transcript: { ...(still?.transcript as object), catchUpTriage: { calls: 0, busyRetries: BUSY_RETRIES } } })
    .where(eq(schema.agentRuns.id, waiting?.id ?? ""));
  setSystemTime(new Date(at.getTime() + 2 * 60_000));
  await drainOutbox(f.db, handlers);
  expect(triageCalls(f)).toHaveLength(1);
});

test("a skip wakes the next in line only while the line drains; a line paused on another reset keeps its slots", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }) });
  const machineId = await computerAgent(f, { brainFallback: false });
  const resetsAt = later(3600_000);
  const { brain } = scripted(() => [
    { type: "limit", resetsAt: resetsAt.toISOString() },
    { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: false },
  ]);
  const handlers = handlersWith(f, brain);
  await post(f, "@dev um");
  await drainOutbox(f.db, handlers);
  const other = await createChannel(f.db, f.owner.id, f.org.id, { name: "outro" });
  await addChannelMember(f.db, f.owner.id, f.org.id, other.id, { agentId: f.agent.id });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, other.id, { body: "@dev dois" });
  await drainOutbox(f.db, handlers);
  const [a, b] = await runs(f);
  const key = usageWaitKey({ code: "plan_limit", machineId, kind: "claude_code" });
  // The line waits for a reset an hour away: nothing moves.
  expect(await wakeNextInLine(f.db, f.org.id, key, "sonnet")).toBeNull();
  // At the reset the first is done (skipped): the second goes now instead of a minute later.
  await f.db
    .update(schema.agentRuns)
    .set({ status: "done" })
    .where(eq(schema.agentRuns.id, a?.id ?? ""));
  const at = resetsAt.getTime() + RESUME_AFTER_MS + 1000;
  expect(await wakeNextInLine(f.db, f.org.id, key, "sonnet", at)).toBe(b?.id ?? "");
  expect((await resumeJob(f, b?.id ?? ""))?.nextAttemptAt.getTime()).toBe(at);
});

test("two skips on one line make one owner notice counting both; one in a conversation the owner can't read isn't counted", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }), judge: checks("solved", "nina") });
  await computerAgent(f, { brainFallback: false });
  const { brain, seen } = scripted((n) =>
    n < 3
      ? [
          { type: "limit", resetsAt: later(3600_000).toISOString() },
          { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: false },
        ]
      : [{ type: "done", text: "Respondido." }],
  );
  const handlers = handlersWith(f, brain);
  const deps = { db: f.db, pubsub: f.pubsub };
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const nina = await addMember(f.db, f.org.id, "member", "nina");
  for (const u of [bia, nina]) await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: u.id });
  const ops = await createChannel(f.db, f.owner.id, f.org.id, { name: "ops" });
  for (const u of [bia, nina]) await addChannelMember(f.db, f.owner.id, f.org.id, ops.id, { userId: u.id });
  await addChannelMember(f.db, f.owner.id, f.org.id, ops.id, { agentId: f.agent.id });
  const theirs = await createChannel(f.db, bia.id, f.org.id, { name: "bia-nina", visibility: "private" });
  await addChannelMember(f.db, bia.id, f.org.id, theirs.id, { userId: nina.id });
  await addChannelMember(f.db, f.owner.id, f.org.id, theirs.id, { agentId: f.agent.id });
  await postPersonMessage(deps, bia.id, f.org.id, f.general.id, { body: "@dev o deploy saiu?" });
  await drainOutbox(f.db, handlers);
  await postPersonMessage(deps, bia.id, f.org.id, ops.id, { body: "@dev e o relatório?" });
  await drainOutbox(f.db, handlers);
  await postPersonMessage(deps, bia.id, f.org.id, theirs.id, { body: "@dev e a fatura?" });
  await drainOutbox(f.db, handlers);
  await postPersonMessage(deps, nina.id, f.org.id, f.general.id, { body: "Saiu às 14h." });
  await postPersonMessage(deps, nina.id, f.org.id, ops.id, { body: "Relatório no Drive." });
  await postPersonMessage(deps, nina.id, f.org.id, theirs.id, { body: "Fatura paga." });
  await drainOutbox(f.db, handlers);
  await pausedLongAgo(f);
  clearPlanLimits();
  await drainOutbox(f.db, handlers, { now: later(3600_000 + RESUME_AFTER_MS + 5 * RESUME_GAP_MS) });
  // One turn hit the limit; the other two parked on the stored limit, and none ran at the resume.
  expect(seen).toHaveLength(1);
  expect((await runs(f)).map((r) => r.status)).toEqual(["done", "done", "done"]);
  const owner = await noticesOf(f, "catch_up_closed");
  expect(owner.map((n) => [n.userId, n.count])).toEqual([[f.owner.id, 2]]);
  expect(await noticesOf(f, "catch_up_closed_asker")).toHaveLength(3);
});

test("who asked withdrawing it closes it with no notice to them", async () => {
  f = await setup({ reply: () => ({ chunks: ["pela API"] }), judge: checks("not_needed", "bia") });
  await computerAgent(f, { brainFallback: false });
  const { brain, seen } = scripted(() => [
    { type: "limit", resetsAt: later(3600_000).toISOString() },
    { type: "error", code: "plan_limit", message: "You've hit your session limit", worked: false },
  ]);
  const handlers = handlersWith(f, brain);
  const deps = { db: f.db, pubsub: f.pubsub };
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: bia.id });
  await postPersonMessage(deps, bia.id, f.org.id, f.general.id, { body: "@dev o deploy saiu?" });
  await drainOutbox(f.db, handlers);
  await postPersonMessage(deps, bia.id, f.org.id, f.general.id, { body: "deixa, já vi aqui" });
  await drainOutbox(f.db, handlers);
  await pausedLongAgo(f);
  clearPlanLimits();
  await drainOutbox(f.db, handlers, { now: later(3600_000 + RESUME_AFTER_MS + 1000) });
  expect(seen).toHaveLength(1);
  const [note] = await notes(f, "plan_limit_wait");
  expect(note?.meta.usageWait).toMatchObject({ closed: { reason: "withdrawn", who: { name: "bia", userId: bia.id } } });
  expect(await noticesOf(f, "catch_up_closed_asker")).toHaveLength(0);
});
