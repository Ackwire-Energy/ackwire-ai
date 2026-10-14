import { and, type Database, eq, gte, schema, sql } from "@agenteschat/db";
import { requirePermission } from "./organizations";

const { usageRecords, agents } = schema;

/** Start of the calendar month (UTC) containing `now`: budgets reset then. */
export const monthStartUtc = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** What an agent spent this month, in nano-USD. */
export async function agentSpendThisMonth(db: Database, orgId: string, agentId: string, now = new Date()) {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${usageRecords.costNanoUsd}), 0)` })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.orgId, orgId),
        eq(usageRecords.agentId, agentId),
        gte(usageRecords.createdAt, monthStartUtc(now)),
      ),
    );
  return Number(row?.total ?? 0);
}

/** Tokens and cost per agent since `since` (default: start of this month). */
export async function usageSummary(db: Database, actorId: string, orgId: string, options: { since?: Date } = {}) {
  await requirePermission(db, actorId, orgId, "view_usage");
  const since = options.since ?? monthStartUtc(new Date());
  const rows = await db
    .select({
      agentId: usageRecords.agentId,
      handle: agents.handle,
      calls: sql<number>`count(*)::int`,
      inputTokens: sql<string>`sum(${usageRecords.inputTokens})`,
      outputTokens: sql<string>`sum(${usageRecords.outputTokens})`,
      costNanoUsd: sql<string>`sum(${usageRecords.costNanoUsd})`,
    })
    .from(usageRecords)
    .innerJoin(agents, eq(agents.id, usageRecords.agentId))
    .where(and(eq(usageRecords.orgId, orgId), gte(usageRecords.createdAt, since)))
    .groupBy(usageRecords.agentId, agents.handle);
  return rows.map((r) => ({
    agentId: r.agentId ?? "",
    handle: r.handle,
    calls: r.calls,
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    costNanoUsd: Number(r.costNanoUsd),
  }));
}

/**
 * Recomputes an agent's spend counter for this month from its usage records
 * (when a budget is set or changed, so earlier spend counts). Open
 * reservations are kept.
 */
export async function resyncBudgetCounter(db: Database, orgId: string, agentId: string, now = new Date()) {
  const spent = await agentSpendThisMonth(db, orgId, agentId, now);
  await db
    .insert(schema.agentBudgetPeriods)
    .values({ orgId, agentId, periodStart: monthStartUtc(now).toISOString().slice(0, 10), spentNanoUsd: spent })
    .onConflictDoUpdate({
      target: [schema.agentBudgetPeriods.agentId, schema.agentBudgetPeriods.periodStart],
      set: { spentNanoUsd: spent, updatedAt: now },
    });
}
