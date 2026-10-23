import { and, desc, type Executor, eq, inArray, ne, schema } from "@agenteschat/db";
import type { AgentRun } from "./runs";

const { messages, routineRuns } = schema;

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
