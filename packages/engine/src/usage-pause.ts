import { and, type Database, type Executor, eq, inArray, ne, schema, sql } from "@agenteschat/db";
import { planOf } from "@agenteschat/providers/plans";
import { BRAIN_PLAN_NAMES, type BrainKind, isComputerBrain } from "./brains/types";
import { enqueue } from "./outbox";
import { monthStartUtc } from "./usage";

/**
 * A run waiting on usage (the usage-aware design, Phase 1): its plan's limit (`plan_limit`) or its agent's
 * monthly API budget (`budget`). It parks in its own session (`waiting_input`, `waitingForBrain` with this
 * code and no computer) and a timed `agent_run.execute` job resumes it; the gate is checked again on every
 * resume, so a wrong reset time corrects itself.
 */
export const USAGE_WAIT_CODES: ReadonlySet<string> = new Set(["plan_limit", "budget"]);

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
        sql`${agentRuns.transcript}->'waitingForBrain'->>'code' = 'budget'`,
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
