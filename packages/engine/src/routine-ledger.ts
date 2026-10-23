import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, schema, sql } from "@agenteschat/db";
import { routineOfRun } from "./background";
import type { AgentRun } from "./runs";

const { routineRuns } = schema;

/** What a background run's record keeps of its final text (the routine's history, read by its next run). */
export const MAX_RUN_RECORD = 4000;

/** How a routine's background run ended, on any path (ADR 0053). */
export type RoutineRunEnd =
  /** Its final answer: the run's own record (empty when it had nothing to say). */
  | { status: "done"; text: string }
  /** It failed: `code` is the coded reason the app translates (a run error code, `no_report`…). */
  | { status: "failed"; code: string; detail?: string }
  /** A person stopped it, or the next slot replaced it (`superseded`), or it gave way (`missed`). */
  | { status: "canceled" | "superseded" | "missed"; code: string; byUserId?: string | null };

/** A routine run's end state (`routine_runs.status`). */
export type RoutineRunEndStatus = "reported" | "silent" | "failed" | "canceled" | "superseded" | "missed";

/** Statuses a routine run can still end from. */
const OPEN = ["queued", "starting", "started", "reported"];

/**
 * Closes the routine run of a background run, on every ending (ADR 0053): its answer, a failure, a
 * stop, a deploy, a computer cut off. The one place a routine's ledger moves to its end, so the run
 * strip, the failure streak and the next run's "last time" all read one truth. A run that already
 * handed off stays `reported` whatever happens after (people heard it). Returns the routine run and
 * its end status, or null when the run is not a routine's or its row already ended.
 */
export async function closeRoutineRun(
  deps: { db: Database; pubsub?: PubSub },
  run: Pick<AgentRun, "id" | "orgId" | "triggerMessageId" | "background">,
  end: RoutineRunEnd,
): Promise<{ routineId: string; routineRunId: string; status: RoutineRunEndStatus } | null> {
  if (!run.background) return null;
  const routine = await routineOfRun(deps.db, run);
  if (!routine?.routineRunId) return null;
  const reported = sql`${routineRuns.status} = 'reported'`;
  let set: Record<string, unknown>;
  if (end.status === "done") {
    // Routines written for the old protocol may still answer the bare word NO_REPLY: no record then.
    const said = end.text.trim();
    const record = /^[`*]*NO_REPLY[`*]*\.?$/.test(said) ? "" : said.slice(0, MAX_RUN_RECORD);
    set = {
      status: sql`case when ${reported} then 'reported' else 'silent' end`,
      // No final text: a hand-off keeps its report as the record; silence keeps nothing.
      summary: record ? record : sql`case when ${reported} then ${routineRuns.summary} else '' end`,
    };
  } else {
    set = {
      status: sql`case when ${reported} then 'reported' else ${end.status} end`,
      code: sql`case when ${reported} then ${routineRuns.code} else ${end.code} end`,
      ...(end.status === "failed" && end.detail
        ? { summary: sql`case when ${reported} then ${routineRuns.summary} else ${end.detail.slice(0, 500)} end` }
        : {}),
    };
  }
  const [row] = await deps.db
    .update(routineRuns)
    .set({ ...set, finishedAt: new Date() })
    .where(
      and(
        eq(routineRuns.id, routine.routineRunId),
        eq(routineRuns.orgId, run.orgId),
        inArray(routineRuns.status, OPEN),
      ),
    )
    .returning({ status: routineRuns.status });
  if (!row) return null;
  return {
    routineId: routine.routineId,
    routineRunId: routine.routineRunId,
    status: row.status as RoutineRunEndStatus,
  };
}
