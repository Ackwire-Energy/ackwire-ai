import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, ne, schema, sql } from "@agenteschat/db";
import { planOf } from "@agenteschat/providers/plans";
import { extraUsageLeft, planBinding } from "@agenteschat/ui/plan-state";
import { recordAudit } from "./audit";
import { storedPlanUsage } from "./brains/select";
import { BRAIN_PLAN_NAMES, type BrainKind, isComputerBrain } from "./brains/types";
import { mayStopRun, runRequester } from "./cancel";
import { ConflictError, ForbiddenError } from "./errors";
import { publishMessageCreated } from "./events";
import { type Message, messageView } from "./messages";
import type { Membership } from "./organizations";
import { enqueue } from "./outbox";
import { isTerminal } from "./runs";
import { effectiveAgentBudget, monthStartUtc } from "./usage";

/**
 * A run waiting on usage (the usage-aware design, Phase 1): its plan's limit (`plan_limit`) or its agent's
 * monthly API budget (`budget`). It parks in its own session (`waiting_input`, `waitingForBrain` with this
 * code and no computer) and a timed `agent_run.execute` job resumes it; the gate is checked again on every
 * resume, so a wrong reset time corrects itself.
 */
export const USAGE_WAIT_CODES: ReadonlySet<string> = new Set(["plan_limit", "budget", "usage_pause"]);

/** Re-checks of a limit whose reset nobody said (ms after it was seen), then hourly. */
export const LIMIT_LADDER_MS = [2 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];
/** A resumed run starts this long after the reset, and each next one of the same plan this much later. */
export const RESUME_AFTER_MS = 30_000;
export const RESUME_GAP_MS = 60_000;
/** A plan still silent about its reset after this long: the agent's owner hears it once. */
export const UNKNOWN_RESET_NOTICE_MS = 24 * 3600_000;

/** How long the `step`th re-check of an unknown reset waits (0-based). */
export const ladderDelay = (step: number) => LIMIT_LADDER_MS[step] ?? 3600_000;

/** When the next month starts (UTC): an agent's budget renews then. */
export const nextMonthStart = (now: number) => {
  const start = monthStartUtc(new Date(now));
  return Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1);
};

/** The plan's name in a note: the coding plan's maker, else Claude's or ChatGPT's. */
export function planName(kind: BrainKind, provider?: string): string {
  const plan = planOf(provider);
  if (plan) return provider === "opencode" ? plan.name : plan.maker;
  return isComputerBrain(kind) ? BRAIN_PLAN_NAMES[kind] : "Claude";
}

/** What groups the runs that wait on the same thing (they resume one after another): a plan's sign-in or a budget. */
export const usageWaitKey = (
  w:
    | { code: "plan_limit"; machineId: string; kind: BrainKind; accountId?: string }
    | { code: "budget"; agentId: string },
) => (w.code === "budget" ? `budget:${w.agentId}` : `plan:${w.machineId}:${w.kind}:${w.accountId ?? "own"}`);

/**
 * This run's place in line among the runs already waiting on the same `key`: the runs a person waits on
 * (not background) go first, then the rest in the order they parked. A person's run that parks after
 * background ones moves their jobs one gap later, so it goes before them.
 */
export async function usageWaitPlace(db: Database, run: { id: string; background: boolean }, key: string) {
  const { agentRuns, outbox } = schema;
  const parked = await db
    .select({ id: agentRuns.id, background: agentRuns.background })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.status, "waiting_input"),
        ne(agentRuns.id, run.id),
        sql`${agentRuns.transcript}->'waitingForBrain'->>'waitKey' = ${key}`,
      ),
    );
  const people = parked.filter((r) => !r.background);
  if (run.background) return parked.length;
  const behind = parked.filter((r) => r.background).map((r) => r.id);
  if (behind.length > 0) {
    await db
      .update(outbox)
      .set({ nextAttemptAt: sql`${outbox.nextAttemptAt} + ${`${RESUME_GAP_MS / 1000} seconds`}::interval` })
      .where(
        and(
          eq(outbox.kind, "agent_run.execute"),
          eq(outbox.status, "pending"),
          sql`${outbox.payload} ? 'wait'`,
          inArray(sql<string>`${outbox.payload}->>'runId'`, behind),
        ),
      );
  }
  return people.length;
}

/**
 * The agent's budget went up (its own, or the workspace's default): the runs that wait for it go on now.
 * One that still doesn't fit parks again quietly. `agentId` null: every agent of the workspace.
 */
export async function resumeBudgetWaits(db: Executor, orgId: string, agentId: string | null): Promise<string[]> {
  const { agentRuns } = schema;
  const rows = await db
    .select({ id: agentRuns.id, waitId: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'waitId'` })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.status, "waiting_input"),
        ...(agentId ? [eq(agentRuns.agentId, agentId)] : []),
        sql`(${agentRuns.transcript}->'waitingForBrain'->>'code' = 'budget' or (${agentRuns.transcript}->'waitingForBrain'->>'code' = 'usage_pause' and ${agentRuns.transcript}->'waitingForBrain'->>'source' = 'budget'))`,
      ),
    )
    .limit(500);
  for (const r of rows) {
    if (!r.waitId) continue;
    await enqueue(db, {
      orgId,
      kind: "agent_run.execute",
      payload: { runId: r.id, wait: r.waitId },
      dedupeKey: `agent_run.execute:${r.id}:budget_raised:${r.waitId}`,
      maxAttempts: 4,
    });
  }
  return rows.map((r) => r.id);
}

/**
 * Long work (ADR 0118): what pauses near a limit, while replies to people go on. A routine's run (not Rodar agora)
 * and a mission's are long by kind; any other once it grew in this claim of the run (a person acting on it starts
 * a new claim, so a fresh allowance): `LONG_WORK.modelCalls` model calls, a computer brain's third turn, or
 * `LONG_WORK.ms` of work with a call made. A run paused once stays long; Continuar agora's override never pauses.
 */
export const LONG_WORK = { modelCalls: 8, computerTurns: 2, ms: 10 * 60_000 } as const;

export function isLongWork(w: {
  routine: boolean;
  mission: boolean;
  pausedBefore: boolean;
  computer: boolean;
  calls: number;
  elapsedMs: number;
}): boolean {
  if (w.routine || w.mission || w.pausedBefore) return true;
  if (w.computer ? w.calls >= LONG_WORK.computerTurns : w.calls >= LONG_WORK.modelCalls) return true;
  return w.calls >= 1 && w.elapsedMs >= LONG_WORK.ms;
}

/** Continuar agora's override still holds: until the window it was pressed on resets (null: until the run ends). */
export const overrideHolds = (o: { until: string | null } | undefined, now = Date.now()) =>
  o !== undefined && (o.until === null || Date.parse(o.until) > now);

/** The plan's own allowance: past it, long work goes on only into paid extra usage. */
export const PLAN_FULL = 100;

/** Where a paused run's plan was read when it parked, so Continuar agora reads the same window again. */
export interface PlanReadingRef {
  machineId: string;
  accountId?: string;
  model?: string | null;
}

/**
 * Continuar agora's one rule (ADR 0118), the card's and Rotinas' alike, and the gate after a press: a run paused near
 * its plan's limit may go on up to the plan's own allowance (100%), and past it only into paid extra usage the agent
 * may use (`extra`). True: going on now would go past the plan with extra usage off.
 */
export const continuesPastPlan = (r: { source: "plan" | "budget"; used: number; extra?: boolean } | null) =>
  r !== null && r.source === "plan" && !r.extra && r.used >= PLAN_FULL;

/**
 * Why Continuar agora is refused (`continuesPastPlan`), in the words both places use: the agent's extra-usage switch
 * is off, or it is on but the plan has no extra usage left (none reported, or that window is used up too).
 */
export const CONTINUE_PAST_PLAN = {
  extra_off:
    "This plan's window is used up and this agent's long work doesn't use paid extra usage: turn that on in its AI settings to continue now, or it picks up after the reset",
  extra_used_up:
    "This plan's window is used up and its paid extra usage is used up or unavailable: it picks up after the reset",
} as const;

export type PastPlanReason = keyof typeof CONTINUE_PAST_PLAN;

/** Where the plan of a run paused at `ref` stands now, as the executor's gate reads it. Null: nothing known. */
export async function pausedPlanReading(
  db: Executor,
  orgId: string,
  kind: BrainKind,
  ref: PlanReadingRef | undefined,
  extraUsage: boolean,
) {
  if (!ref?.machineId) return null;
  const usage = await storedPlanUsage(db, orgId, ref.machineId, kind, ref.accountId).catch(() => null);
  const top = planBinding(usage, { model: ref.model ?? null });
  return top
    ? { source: "plan" as const, used: top.used, extra: extraUsage && extraUsageLeft(usage), extraSwitch: extraUsage }
    : null;
}

/** Why Continuar agora on the paused run `runId` would go past its plan without extra usage (`continuesPastPlan`); null: it may go on. */
export async function pauseContinuesPastPlan(
  db: Executor,
  orgId: string,
  runId: string,
): Promise<PastPlanReason | null> {
  const { agentRuns, agents } = schema;
  const [row] = await db
    .select({
      wait: sql<Record<string, unknown> | null>`${agentRuns.transcript}->'waitingForBrain'`,
      extraUsage: agents.brainExtraUsage,
    })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.id, runId)));
  const wait = row?.wait as { kind?: BrainKind; source?: string; reading?: PlanReadingRef } | null | undefined;
  if (!row || !wait?.kind || wait.source === "budget") return null;
  const reading = await pausedPlanReading(db, orgId, wait.kind, wait.reading, row.extraUsage);
  if (!continuesPastPlan(reading)) return null;
  return row.extraUsage ? "extra_used_up" : "extra_off";
}

/** Refuses Continuar agora that would go past the plan without extra usage, as `<where>.continue_<reason>`. */
export async function assertMayContinuePause(db: Executor, orgId: string, runId: string, where: "routine" | "run") {
  const reason = await pauseContinuesPastPlan(db, orgId, runId);
  if (reason) throw new ConflictError(CONTINUE_PAST_PLAN[reason], `${where}.continue_${reason}`);
}

/**
 * How much of its monthly budget the agent used this UTC month, in percent: `spent`, and `held` with what its runs
 * reserved for calls in flight (worst-case, released when each call ends).
 */
export async function budgetUsedPercent(
  db: Database,
  agent: { id: string; orgId: string; monthlyBudgetNanoUsd: number | null },
  now = new Date(),
): Promise<{ spent: number; held: number }> {
  const { agentBudgetPeriods } = schema;
  const period = monthStartUtc(now).toISOString().slice(0, 10);
  const [[row], budget] = await Promise.all([
    db
      .select({ spent: agentBudgetPeriods.spentNanoUsd, reserved: agentBudgetPeriods.reservedNanoUsd })
      .from(agentBudgetPeriods)
      .where(and(eq(agentBudgetPeriods.agentId, agent.id), eq(agentBudgetPeriods.periodStart, period))),
    effectiveAgentBudget(db, agent),
  ]);
  const percent = (n: number) => (budget <= 0 ? 0 : Math.floor((n / budget) * 100));
  const spent = row?.spent ?? 0;
  return { spent: percent(spent), held: percent(spent + (row?.reserved ?? 0)) };
}

/** A plan's window in a sentence the engine writes ("of its 5 hours"); the apps word it themselves. */
export const USAGE_WINDOW_WORDS: Record<string, string> = {
  five_hour: "of its 5 hours",
  seven_day: "of its week",
  seven_day_opus: "of its Opus week",
  seven_day_sonnet: "of its Sonnet week",
  monthly: "of its month",
};

/** What a computer brain reads in "# This turn" from 90% of its plan (ADR 0118). */
export function usageNoticeText(
  plan: string,
  r: { used: number; window?: string; resetsAt?: string; extra?: boolean },
) {
  const window = r.window ? ` ${USAGE_WINDOW_WORDS[r.window] ?? ""}`.trimEnd() : "";
  const resets = r.resetsAt ? ` and resets at ${r.resetsAt}` : "";
  return [
    "# Your plan's usage",
    `Your ${plan} plan is at ${r.used}%${window}${resets}.`,
    r.extra
      ? "Its paid extra usage is on, so long work goes on past the plan's limit and replies to people go on too."
      : "At 95% long work pauses by itself and picks up after the reset, and replies to people go on. Keep working as usual and leave each finished step in a working state. Before you start something big, tell the people it may pause.",
  ].join("\n");
}

/** Whether a routine's run was started by Rodar agora (a person asked for it now), not by its schedule. */
export async function routineRunByHand(db: Executor, runId: string) {
  const { routineRuns } = schema;
  const [row] = await db
    .select({ trigger: routineRuns.trigger })
    .from(routineRuns)
    .where(eq(routineRuns.agentRunId, runId))
    .limit(1);
  return row?.trigger === "manual";
}

/** `meta.actionCard` of a long-work pause's card (ADR 0118). Only the executor and Continuar agora write it. */
export interface UsagePauseCard {
  kind: "usage_paused";
  /** `ended`: the run ended paused (canceled, superseded, failed): nothing left to continue. */
  state: "paused" | "continued" | "resumed" | "ended";
  runId: string;
  waitId: string;
  agentId: string;
  /** The person behind the work: with the agent's owner and admins, who may press Continuar agora. */
  forUserId: string | null;
  source: "plan" | "budget";
  percent: number;
  window?: string;
  plan: string;
  resetsAt?: string;
  continuedByUserId: string | null;
  continuedAt: string | null;
}

export const usagePauseCardOf = (meta: Record<string, unknown> | null | undefined): UsagePauseCard | null => {
  const card = meta?.actionCard as Partial<UsagePauseCard> | undefined;
  return card?.kind === "usage_paused" && typeof card.runId === "string" && typeof card.waitId === "string"
    ? (card as UsagePauseCard)
    : null;
};

/** The paused run picked up by itself (the window reset, or room again): its card says so, once. */
export const usageCardResumed = (deps: { db: Database; pubsub?: PubSub }, orgId: string, messageId: string) =>
  setUsageCardState(deps, orgId, messageId, "resumed");

/** Moves a card still `paused` to `state`, once. */
async function setUsageCardState(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  messageId: string,
  state: "resumed" | "ended",
) {
  const { messages } = schema;
  const [row] = await deps.db
    .update(messages)
    .set({ meta: sql`jsonb_set(${messages.meta}, '{actionCard,state}', ${JSON.stringify(state)}::jsonb)` })
    .where(
      and(
        eq(messages.orgId, orgId),
        eq(messages.id, messageId),
        sql`${messages.meta}->'actionCard'->>'state' = 'paused'`,
      ),
    )
    .returning();
  if (row && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(row));
}

/**
 * Continuar agora's step on a paused run (the card's and Rotinas'): once per wait (a compare-and-set on its wait id
 * with no override yet), it goes on past the pause line until `until` (the window's reset; null: until it ends) and
 * is queued now. Audited as `usage.continued`. False: the run already moved on (a second press, the timed job).
 */
export async function overrideUsagePause(
  tx: Executor,
  p: {
    orgId: string;
    runId: string;
    waitId: string;
    until: string | null;
    userId: string;
    details: Record<string, unknown>;
    channelId?: string | null;
  },
): Promise<boolean> {
  const { agentRuns } = schema;
  const override = { until: p.until, by: p.userId };
  const [moved] = await tx
    .update(agentRuns)
    .set({
      transcript: sql`${agentRuns.transcript} || jsonb_build_object('usagePause',
        coalesce(${agentRuns.transcript}->'usagePause', '{}'::jsonb) || jsonb_build_object('override', ${JSON.stringify(override)}::jsonb))`,
    })
    .where(
      and(
        eq(agentRuns.orgId, p.orgId),
        eq(agentRuns.id, p.runId),
        eq(agentRuns.status, "waiting_input"),
        sql`${agentRuns.transcript}->'waitingForBrain'->>'waitId' = ${p.waitId}`,
        sql`${agentRuns.transcript}->'usagePause'->'override' is null`,
      ),
    )
    .returning({ id: agentRuns.id });
  if (!moved) return false;
  await enqueue(tx, {
    orgId: p.orgId,
    kind: "agent_run.execute",
    payload: { runId: p.runId, wait: p.waitId },
    dedupeKey: `agent_run.execute:${p.runId}:continue:${p.waitId}`,
    maxAttempts: 4,
  });
  await recordAudit(tx, {
    orgId: p.orgId,
    actor: { type: "person", id: p.userId },
    action: "usage.continued",
    target: { type: "agent_run", id: p.runId },
    details: { ...p.details, until: p.until },
    ...(p.channelId ? { channelId: p.channelId } : {}),
  });
  return true;
}

/**
 * Continuar agora on a long-work pause's card (`POST …/messages/{id}/answer-now`, ADR 0118): the run goes on now,
 * past the pause line until that window resets (the plan's own limit still stops it). Who asked, the person behind
 * the work, the agent's owner or an admin (`mayStopRun`); everyone else sees it greyed. Once: a second press, or
 * the run already back at work, starts nothing. Audited.
 */
export async function continueUsagePause(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  membership: Membership,
  message: Message,
  card: UsagePauseCard,
): Promise<{ runs: { agentId: string; runId: string }[] }> {
  const { db } = deps;
  const { agentRuns, agents, messages } = schema;
  const [row] = await db
    .select({ run: agentRuns, ownerUserId: agents.ownerUserId, requester: runRequester })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .leftJoin(messages, and(eq(messages.id, agentRuns.triggerMessageId), eq(messages.orgId, agentRuns.orgId)))
    .where(and(eq(agentRuns.orgId, message.orgId), eq(agentRuns.id, card.runId)));
  if (!row) return { runs: [] };
  if (!(await mayStopRun(db, userId, membership, row)))
    throw new ForbiddenError("Only who asked, the agent's owner or an admin can do this", "run.answer_forbidden");
  if (card.source !== "budget") await assertMayContinuePause(db, message.orgId, card.runId, "run");
  const until = card.resetsAt ?? null;
  const done = await db.transaction(async (tx) => {
    const moved = await overrideUsagePause(tx, {
      orgId: message.orgId,
      runId: card.runId,
      waitId: card.waitId,
      until,
      userId,
      details: { messageId: message.id, source: card.source, percent: card.percent },
      channelId: message.channelId,
    });
    if (!moved) return null;
    const next: UsagePauseCard = {
      ...card,
      state: "continued",
      continuedByUserId: userId,
      continuedAt: new Date().toISOString(),
    };
    const [updated] = await tx
      .update(messages)
      .set({ meta: sql`jsonb_set(${messages.meta}, '{actionCard}', ${JSON.stringify(next)}::jsonb)` })
      .where(and(eq(messages.orgId, message.orgId), eq(messages.id, message.id)))
      .returning();
    return updated ?? null;
  });
  if (!done) {
    // The run ended while paused: the card says so instead of offering a button that does nothing.
    if (isTerminal(row.run.status)) await setUsageCardState(deps, message.orgId, message.id, "ended");
    return { runs: [] };
  }
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(done));
  return { runs: [{ agentId: card.agentId, runId: card.runId }] };
}
