import { and, type Database, type Executor, eq, schema, sql } from "@agenteschat/db";
import type { ToolResult } from "./brains/types";
import { enqueue } from "./outbox";

const { agentRuns } = schema;

/** The part of a run's transcript these helpers read and write (the engine's `Transcript`). */
interface StoredTranscript {
  pending?: {
    calls: { toolUseId: string; name: string; waitId?: string; result?: { content: string; isError: boolean } }[];
  };
  waitingForBrain?: { kind: string; machineId: string; code: string; waitId?: string };
  consulted?: { agentId: string; consultationId: string; status: string; question?: string; answer?: string | null }[];
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
  input: {
    runId: string;
    waitId: string;
    result: ToolResult;
    /** An agent it consulted (`ask_agent`): its reply's `meta.consulted` card. */
    consulted?: { agentId: string; consultationId: string; status: string; question?: string; answer?: string | null };
  },
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
    if (input.consulted) t.consulted = [...(t.consulted ?? []), input.consulted];
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
 * Found by `agent_runs.waiting_machine_id` (indexed, set only while a run
 * waits for its computer); one job per wait (`waitingForBrain.waitId`), so
 * reconnects while the job is still queued don't add more.
 */
export async function resumeRunsWaitingForMachine(db: Executor, machineId: string): Promise<string[]> {
  const rows = await db
    .select({
      id: agentRuns.id,
      orgId: agentRuns.orgId,
      waitId: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'waitId'`,
      updatedAt: agentRuns.updatedAt,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.waitingMachineId, machineId), eq(agentRuns.status, "waiting_input")))
    .limit(200);
  for (const r of rows) {
    await enqueue(db, {
      orgId: r.orgId,
      kind: "agent_run.execute",
      payload: { runId: r.id },
      // The wait's own id (older waits: when the run started waiting, which no reconnect changes).
      dedupeKey: `agent_run.execute:${r.id}:brain_back:${r.waitId ?? r.updatedAt.getTime()}`,
      maxAttempts: 4,
    });
  }
  return rows.map((r) => r.id);
}
