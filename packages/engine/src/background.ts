import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, inArray, ne, schema, sql } from "@agenteschat/db";
import type { AgentRun } from "./runs";

const { messages, routineRuns } = schema;

/** What a background run keeps of its final text: the routine's history, read by its next run. */
export const MAX_RUN_RECORD = 4000;

export interface RoutineOfRun {
  routineId: string;
  /** The `routine_runs` row of this firing (null on triggers written before it was carried). */
  routineRunId: string | null;
  name: string;
}

/** The routine behind a run, from its trigger (`meta.routine`); null for anything else. */
export async function routineOfRun(
  db: Executor,
  run: Pick<AgentRun, "orgId" | "triggerMessageId">,
): Promise<RoutineOfRun | null> {
  const [m] = await db
    .select({ meta: messages.meta })
    .from(messages)
    .where(and(eq(messages.orgId, run.orgId), eq(messages.id, run.triggerMessageId)));
  const r = m?.meta.routine as { id?: unknown; name?: unknown; runId?: unknown } | undefined;
  if (!r || typeof r.id !== "string") return null;
  return {
    routineId: r.id,
    routineRunId: typeof r.runId === "string" ? r.runId : null,
    name: typeof r.name === "string" ? r.name : "",
  };
}

/**
 * A background run (`agent_runs.background`, a routine's run) reached its
 * final answer: nothing is posted in the conversation. Its text is the run's
 * own record (the routine's history, which its next run compares with);
 * people hear only what it handed off (`hand_off`, which already marked the
 * routine run `reported`). Without a hand-off the run is `silent`.
 */
export async function finishBackgroundRun(
  deps: { db: Database; pubsub: PubSub },
  run: AgentRun,
  text: string,
): Promise<void> {
  const routine = await routineOfRun(deps.db, run);
  if (!routine?.routineRunId) return;
  // Routines written for the old protocol may still answer the bare word NO_REPLY: no record then.
  const said = text.trim();
  const record = /^[`*]*NO_REPLY[`*]*\.?$/.test(said) ? "" : said.slice(0, MAX_RUN_RECORD);
  const reported = sql`${routineRuns.status} = 'reported'`;
  await deps.db
    .update(routineRuns)
    .set({
      status: sql`case when ${reported} then 'reported' else 'silent' end`,
      // No final text: a hand-off keeps its report as the record; silence keeps nothing.
      summary: record ? record : sql`case when ${reported} then ${routineRuns.summary} else '' end`,
    })
    .where(
      and(
        eq(routineRuns.id, routine.routineRunId),
        eq(routineRuns.orgId, run.orgId),
        inArray(routineRuns.status, ["started", "reported"]),
      ),
    );
}

/** A routine's last finished background run before this one: when, whether it reported, and its record. */
export async function lastRoutineRecord(
  db: Executor,
  orgId: string,
  routineId: string,
  currentRoutineRunId: string | null,
): Promise<{ at: Date; reported: boolean; record: string } | null> {
  const [row] = await db
    .select({ at: routineRuns.at, status: routineRuns.status, summary: routineRuns.summary })
    .from(routineRuns)
    .where(
      and(
        eq(routineRuns.orgId, orgId),
        eq(routineRuns.routineId, routineId),
        inArray(routineRuns.status, ["silent", "reported"]),
        currentRoutineRunId ? ne(routineRuns.id, currentRoutineRunId) : undefined,
      ),
    )
    .orderBy(desc(routineRuns.createdAt))
    .limit(1);
  return row ? { at: row.at, reported: row.status === "reported", record: row.summary } : null;
}
