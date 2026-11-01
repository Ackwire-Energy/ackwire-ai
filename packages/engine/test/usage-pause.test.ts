import { afterEach, expect, test } from "bun:test";
import { MACHINE_PROTOCOL_VERSION, type PlanUsage } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  type Brain,
  type BrainEvent,
  type BrainTurn,
  clearPlanLimits,
  createJobHandlers,
  createRoutine,
  drainOutbox,
  listMessages,
  listRoutines,
  type MachineStatus,
  nextMonthStart,
  postPersonMessage,
  RESUME_AFTER_MS,
  RESUME_GAP_MS,
  runRoutineNow,
  storedPlanLimit,
  updateAgent,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { pairMachine } from "./machine-fixtures";

/**
 * The usage-aware design, Phase 1: at a plan's limit or an agent's budget the run waits in its own session
 * and its job resumes it after the reset; nothing is lost and every resume checks the gate again.
 */

let f: Fixture;
afterEach(() => {
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
  expect(note?.meta.usageWait).toEqual({ code: "plan_limit", resetsAt });
  expect(note?.meta.bodyParams).toEqual({ plan: "Claude" });

  await Bun.sleep(200);
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
  // Behind the first run of the same plan: one gap later.
  expect(at).toBeGreaterThanOrEqual(before + 2 * 60_000 + RESUME_AFTER_MS + RESUME_GAP_MS);
  expect(at).toBeLessThan(Date.now() + 2 * 60_000 + RESUME_AFTER_MS + RESUME_GAP_MS + 1000);
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

test("a routine waiting on the plan reads as running in Rotinas, and its people hear it once", async () => {
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
  expect(view?.state).toBe("running");
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
