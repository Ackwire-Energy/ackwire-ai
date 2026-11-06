import { and, type Database, type Executor, eq, inArray, schema, sql } from "@agenteschat/db";
import { modelProvider, ProviderError } from "@agenteschat/providers";
import type { Agent } from "./agents";
import { enqueue } from "./outbox";

const { agentRuns } = schema;

/**
 * The line for one API key while its provider rate-limits it. Runs parked on the same limit all woke on their own
 * timers and tripped it again, so only one tries at a time: the head (a run a person waits on, then the longest parked)
 * makes the call. It passes and the next goes `KEY_LINE_SPACING_MS` later (`kickKeyLine`); it fails and it parks on the
 * outage ladder, the others behind it. Nothing else slows an agent down: a run joins only once its key was refused.
 * Every run keeps a wake job of its own, so a head that ends any other way loses no one.
 */
export const KEY_LINE_SPACING_MS = 5_000;

/** How often a run looks again while the head's call is out. A look reads the database, never the provider. */
export const KEY_LINE_LOOK_MS = 30_000;

/** A head that said nothing for this long died with its process: the next one goes. */
export const KEY_LINE_TRY_MS = 5 * 60_000;

/** What a parked run keeps for its line (`transcript.outage`). `at`: when it tries next; `triedAt`: its call is out. */
export interface KeyLinePlace {
  line?: string;
  at?: number;
  people?: boolean;
  triedAt?: number;
}

/** A failure that says the key is at its rate limit, not that the provider is down. */
export const rateLimited = (error: unknown) =>
  error instanceof ProviderError && error.status === 429 && error.retryable;

/** The key a run's calls go on: the one pinned to its agent, else its provider's default for the workspace. */
export const keyLineOf = (agent: Pick<Agent, "credentialId" | "model">) =>
  agent.credentialId ?? `default:${modelProvider(agent.model) ?? agent.model}`;

const outage = (field: string) => sql`${agentRuns.transcript}->'outage'->>${sql.raw(`'${field}'`)}`;
const inLine = (orgId: string, line: string) => and(eq(agentRuns.orgId, orgId), sql`${outage("line")} = ${line}`);
const peopleSql = sql`coalesce((${outage("people")})::boolean, false)`;
const sinceSql = sql`coalesce((${outage("since")})::bigint, 0)`;
const rankSql = sql<number>`(case when ${peopleSql} then 0 else 1 end)`;

/**
 * Whether this parked run may try now. Null: go, and the runs behind it wait for it. Otherwise `retryAt` says when to
 * look again: right after the run ahead tries, or soon while another's call is out. A run a person waits on goes
 * ahead of agents' work and doesn't wait on a call that is out.
 */
export async function keyLineGate(
  db: Database,
  run: { id: string; orgId: string },
  line: string,
  now = Date.now(),
): Promise<{ retryAt: number } | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`key-line:${run.orgId}:${line}`}))`);
    const [own] = await tx.select({ rank: rankSql, since: sinceSql }).from(agentRuns).where(eq(agentRuns.id, run.id));
    if (!own) return null;
    const [ahead] = await tx
      .select({ at: outage("at").mapWith(Number) })
      .from(agentRuns)
      .where(
        and(
          inLine(run.orgId, line),
          eq(agentRuns.status, "waiting_input"),
          sql`${agentRuns.id} <> ${run.id}`,
          sql`(${rankSql}, ${sinceSql}, ${agentRuns.id}) < (${own.rank}::int, ${own.since}::bigint, ${run.id}::uuid)`,
        ),
      )
      .orderBy(rankSql, sinceSql, agentRuns.id)
      .limit(1);
    if (ahead) return { retryAt: Math.max(now, ahead.at || 0) + KEY_LINE_SPACING_MS };
    if (Number(own.rank) > 0) {
      const [out] = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            inLine(run.orgId, line),
            inArray(agentRuns.status, ["waiting_input", "running"]),
            sql`${agentRuns.id} <> ${run.id}`,
            sql`coalesce((${outage("triedAt")})::bigint, 0) > ${now - KEY_LINE_TRY_MS}::bigint`,
          ),
        )
        .limit(1);
      if (out) return { retryAt: now + KEY_LINE_LOOK_MS };
    }
    await tx
      .update(agentRuns)
      .set({ transcript: sql`jsonb_set(${agentRuns.transcript}, '{outage,triedAt}', ${String(now)}::jsonb)` })
      .where(eq(agentRuns.id, run.id));
    return null;
  });
}

/** The head's call passed: the next in the line tries once the spacing is over. One job per wait. */
export async function kickKeyLine(db: Executor, orgId: string, line: string) {
  const [head] = await db
    .select({ id: agentRuns.id, waitId: sql<string | null>`${outage("waitId")}` })
    .from(agentRuns)
    .where(and(inLine(orgId, line), eq(agentRuns.status, "waiting_input")))
    .orderBy(rankSql, sinceSql, agentRuns.id)
    .limit(1);
  if (!head?.waitId) return;
  await enqueue(db, {
    orgId,
    kind: "agent_run.execute",
    payload: { runId: head.id, wait: head.waitId },
    dedupeKey: `agent_run.execute:${head.id}:key-line:${head.waitId}`,
    runAt: new Date(Date.now() + KEY_LINE_SPACING_MS),
    maxAttempts: 4,
  });
}
