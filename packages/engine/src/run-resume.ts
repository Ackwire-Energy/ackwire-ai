import { and, type Database, type Executor, eq, inArray, schema, sql } from "@agenteschat/db";
import type { ToolResult } from "./brains/types";
import { enqueue } from "./outbox";

const { agentRuns } = schema;

/** The part of a run's transcript these helpers read and write (the engine's `Transcript`). */
interface StoredTranscript {
  pending?: {
    calls: { toolUseId: string; name: string; waitId?: string; result?: { content: string; isError: boolean } }[];
  };
  waitingForBrain?: { kind: string; machineId: string; code: string };
  [key: string]: unknown;
}

/**
 * A run paused on a mission's own wait (a blocking `ask_decision`, a
 * `request_review`: the tool returned `data.pause` with the decision's or
 * review's id) gets its answer: the waiting call's result is set and the run
 * is queued again; the engine resumes it like after an approval (model
 * brain: the tool result; computer brain: the text in its session). Null:
 * the run doesn't wait on that id (anymore).
 */
export async function resumeRunWithResult(
  db: Database,
  input: { runId: string; waitId: string; result: ToolResult },
): Promise<{ runId: string } | null> {
  const resumed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ id: agentRuns.id, orgId: agentRuns.orgId, status: agentRuns.status, transcript: agentRuns.transcript })
      .from(agentRuns)
      .where(eq(agentRuns.id, input.runId))
      .for("update");
    if (!row || (row.status !== "waiting_input" && row.status !== "waiting_approval")) return null;
    const t = row.transcript as StoredTranscript | null;
    const call = t?.pending?.calls.find((c) => c.waitId === input.waitId && !c.result);
    if (!t || !call) return null;
    call.result = { content: input.result.content, isError: input.result.isError === true };
    await tx
      .update(agentRuns)
      .set({ transcript: t as Record<string, unknown>, updatedAt: new Date() })
      .where(eq(agentRuns.id, row.id));
    await enqueue(tx, {
      orgId: row.orgId,
      kind: "agent_run.execute",
      payload: { runId: row.id },
      dedupeKey: `agent_run.execute:${row.id}:wait:${input.waitId}`,
      maxAttempts: 4,
    });
    return { runId: row.id };
  });
  return resumed;
}

/**
 * The agent's computer is back (ADR 0032 §5): runs that waited for its
 * computer brain (no model credential to fall back on) are queued again.
 */
export async function resumeRunsWaitingForMachine(db: Executor, machineId: string): Promise<string[]> {
  const rows = await db
    .select({ id: agentRuns.id, orgId: agentRuns.orgId })
    .from(agentRuns)
    .where(
      and(
        inArray(agentRuns.status, ["waiting_input"]),
        sql`${agentRuns.transcript}->'waitingForBrain'->>'machineId' = ${machineId}`,
      ),
    )
    .limit(200);
  const at = Date.now();
  for (const r of rows) {
    await enqueue(db, {
      orgId: r.orgId,
      kind: "agent_run.execute",
      payload: { runId: r.id },
      dedupeKey: `agent_run.execute:${r.id}:brain_back:${at}`,
      maxAttempts: 4,
    });
  }
  return rows.map((r) => r.id);
}
