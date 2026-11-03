import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, inArray, ne, schema, sql } from "@agenteschat/db";
import { extraUsageLeft, planBinding } from "@agenteschat/ui/plan-state";
import { recordAudit } from "./audit";
import { storedPlanUsage } from "./brains/select";
import type { BrainKind } from "./brains/types";
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

export { planName } from "./brains/types";

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
export async function usageWaitPlace(
  db: Database,
  run: { id: string; background: boolean; workId?: string | null },
  key: string,
) {
  const { agentRuns, outbox } = schema;
  const parked = await db
    .select({ id: agentRuns.id, background: agentRuns.background, workId: agentRuns.workId })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.status, "waiting_input"),
        ne(agentRuns.id, run.id),
        sql`${agentRuns.transcript}->'waitingForBrain'->>'waitKey' = ${key}`,
      ),
    );
  // Background work (ADR 0121) goes on after the conversations a person waits on, before routines.
  const people = parked.filter((r) => !r.background && !r.workId);
  if (run.background) return parked.length;
  if (run.workId) return people.length + parked.filter((r) => !r.background && r.workId).length;
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
 * A turn on a plan just went through, so the plan has room again: the runs parked on its limit (`plan_limit`, the same
 * `key`) go on now, in `usageWaitPlace`'s order, 60 s apart, instead of each sleeping until its own timer (a later
 * reset reading, an unknown reset's re-checks). Without this a routine's slot could wait well past the reset while a
 * person's reply on the same plan had already gone through. A long-work pause (95%) keeps its timer: a quick reply
 * going through says nothing about its line. One job per wait; the old timed one finds the wait gone and does nothing.
 * Only waits on the same `model` (a model's own weekly limit isn't lifted by another model's turn); a wait stored
 * without one is woken.
 */
export async function wakePlanWaits(
  db: Executor,
  orgId: string,
  key: string,
  model: string | null,
  now = Date.now(),
): Promise<string[]> {
  const { agentRuns } = schema;
  const rows = await db
    .select({
      id: agentRuns.id,
      background: agentRuns.background,
      workId: agentRuns.workId,
      waitId: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'waitId'`,
      until: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'until'`,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.status, "waiting_input"),
        sql`${agentRuns.transcript}->'waitingForBrain'->>'code' = 'plan_limit'`,
        sql`${agentRuns.transcript}->'waitingForBrain'->>'waitKey' = ${key}`,
        sql`(not (${agentRuns.transcript}->'waitingForBrain' ? 'model') or ${agentRuns.transcript}->'waitingForBrain'->>'model' is not distinct from ${model})`,
      ),
    )
    .orderBy(agentRuns.createdAt)
    .limit(100);
  const rank = (r: { background: boolean; workId: string | null }) => (r.background ? 2 : r.workId ? 1 : 0);
  const due = rows
    .filter((r) => r.waitId && !(Date.parse(r.until ?? "") <= now + RESUME_GAP_MS))
    .sort((a, b) => rank(a) - rank(b));
  for (const [i, r] of due.entries()) {
    await enqueue(db, {
      orgId,
      kind: "agent_run.execute",
      payload: { runId: r.id, wait: r.waitId },
      dedupeKey: `agent_run.execute:${r.id}:plan_back:${r.waitId}`,
      runAt: new Date(now + i * RESUME_GAP_MS),
      maxAttempts: 4,
    });
  }
  return due.map((r) => r.id);
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
  /**
   * `ended`: the run ended paused (superseded, failed): nothing left to continue. `canceled`: someone said not to run
   * it ("Don't run it", or any stop while it waited).
   */
  state: "paused" | "continued" | "resumed" | "ended" | "canceled";
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
 * A run's "I'll answer when it resets" note while it is back at work (`ended`: true) or parked on it again (false):
 * "Don't run it" shows only while it waits, never stopping a live answer or a run already over.
 */
export async function usageWaitNoteEnded(
  deps: { db: Database; pubsub?: PubSub },
  run: { id: string; orgId: string; channelId: string; createdAt: Date },
  ended: boolean,
) {
  const { messages } = schema;
  const rows = await deps.db
    .update(messages)
    .set({
      meta: ended
        ? sql`jsonb_set(${messages.meta}, '{usageWait,ended}', 'true'::jsonb)`
        : sql`${messages.meta} #- '{usageWait,ended}'`,
    })
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        sql`${messages.createdAt} >= ${run.createdAt.toISOString()}::timestamptz`,
        sql`${messages.meta}->'usageWait'->>'runId' = ${run.id}`,
        sql`${messages.meta}->'usageWait'->'canceled' is null`,
        ended
          ? sql`${messages.meta}->'usageWait'->'ended' is null`
          : sql`${messages.meta}->'usageWait'->'ended' is not null`,
      ),
    )
    .returning();
  if (deps.pubsub) for (const row of rows) await publishMessageCreated(deps.pubsub, messageView(row));
}

/** A note cancelled this recently still speaks for its conversation: a new ask there shows only its receipt. */
export const CANCELED_NOTE_QUIET_MS = 15 * 60_000;

/**
 * One "I'll answer when it resets" note per agent, conversation, person and wait. When the agent's word in this
 * conversation (`threadId`: a thread, or null for the main timeline) since it last said anything else holds a note to
 * the same person (`forUserId`: only who asked can stop it) on the same limit (`code`, a reset within a minute of
 * `resetsAt`, or both unknown) whose run isn't back at work, a newly parked turn posts none: a note still waiting
 * takes the turn in (`usageWait.runIds`, its "Don't run it" stops them all) and comes back to be published; one
 * cancelled less than `CANCELED_NOTE_QUIET_MS` ago stays as it is (`note: null`), the turn's receipt says it waits.
 * Null: the turn posts its own note.
 */
export async function joinUsageNote(
  tx: Executor,
  run: { id: string; orgId: string; agentId: string; channelId: string },
  threadId: string | null,
  forUserId: string | null,
  code: string,
  resetsAt: string | undefined,
  now = Date.now(),
): Promise<{ note: Message | null } | null> {
  const { messages } = schema;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`usage-note:${run.agentId}:${run.channelId}:${threadId ?? ""}`}))`,
  );
  // ponytail: looks back 20 messages; a longer run of notes to other people just posts a new note.
  const recent = await tx
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        eq(messages.authorAgentId, run.agentId),
        sql`${messages.threadId} is not distinct from ${threadId}::uuid and ${messages.deletedAt} is null`,
        // "Told it to stop" and the other notices the agent reads aren't its word in the conversation.
        sql`${messages.meta}->'notice' is null`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(20);
  type Wait = {
    code?: string;
    forUserId?: string | null;
    resetsAt?: string;
    ended?: boolean;
    canceled?: boolean;
    canceledAt?: string;
  };
  const waitOf = (m: Message) => (m.meta.actionCard ? undefined : (m.meta.usageWait as Wait | undefined));
  // Its notes to other people in a channel don't end its word to this one; anything else it said does.
  const stop = recent.findIndex((m) => !waitOf(m) || (waitOf(m)?.forUserId ?? null) === forUserId);
  const last = stop < 0 ? undefined : recent[stop];
  const w = last && waitOf(last);
  if (!last || !w || w.code !== code || w.ended) return null;
  const sameReset =
    w.resetsAt && resetsAt
      ? Math.abs(Date.parse(w.resetsAt) - Date.parse(resetsAt)) < 60_000
      : !w.resetsAt && !resetsAt;
  if (!sameReset) return null;
  if (w.canceled) return now - Date.parse(w.canceledAt ?? "") < CANCELED_NOTE_QUIET_MS ? { note: null } : null;
  const [note] = await tx
    .update(messages)
    .set({
      meta: sql`jsonb_set(${messages.meta}, '{usageWait,runIds}',
        coalesce(${messages.meta}->'usageWait'->'runIds', '[]'::jsonb) || to_jsonb(${run.id}::text))`,
    })
    .where(and(eq(messages.id, last.id), eq(messages.createdAt, last.createdAt)))
    .returning();
  return { note: note ?? null };
}

/**
 * A run waiting on its plan or budget was stopped ("Don't run it", or any stop while it waited): what said it would run
 * later says it won't, quietly: its note (`meta.usageWait.canceled`, with when) and its long-work card (`canceled`).
 * Returns the turns its note took in (`joinUsageNote`): "Don't run it" stops them too.
 */
export async function usageWaitCanceled(
  deps: { db: Database; pubsub?: PubSub },
  run: { id: string; orgId: string; channelId: string; createdAt: Date },
): Promise<string[]> {
  const { messages } = schema;
  const card = sql`coalesce(${messages.meta}->'actionCard'->>'kind', '') = 'usage_paused'`;
  const rows = await deps.db
    .update(messages)
    .set({
      meta: sql`case when ${card}
        then jsonb_set(${messages.meta}, '{actionCard,state}', '"canceled"'::jsonb)
        else jsonb_set(${messages.meta}, '{usageWait}', (${messages.meta}->'usageWait')
          || jsonb_build_object('canceled', true, 'canceledAt', ${new Date().toISOString()}::text)) end`,
    })
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        sql`${messages.createdAt} >= ${run.createdAt.toISOString()}::timestamptz`,
        sql`((${card} and ${messages.meta}->'actionCard'->>'runId' = ${run.id} and ${messages.meta}->'actionCard'->>'state' = 'paused')
          or (not ${card} and ${messages.meta}->'usageWait'->>'runId' = ${run.id} and ${messages.meta}->'usageWait'->'canceled' is null))`,
      ),
    )
    .returning();
  if (deps.pubsub) for (const row of rows) await publishMessageCreated(deps.pubsub, messageView(row));
  return rows.flatMap((r) => {
    const ids = (r.meta.usageWait as { runIds?: unknown } | undefined)?.runIds;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  });
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
