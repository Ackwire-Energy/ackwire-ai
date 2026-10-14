import { and, type Executor, eq, schema, sql } from "@agenteschat/db";

const { agentRuns, agentRunSteps } = schema;

export type AgentRun = typeof agentRuns.$inferSelect;
export type RunStatus = AgentRun["status"];

/**
 * Allowed transitions of `agent_runs.status` (docs/adr/0008-agent-runs.md):
 * `queued → running → (waiting_approval → running)* → done | failed`.
 * `done` and `failed` are terminal. Suspending for an approval is a status
 * change; resuming is enqueueing a new `agent_run.execute` job.
 */
export const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "failed"],
  running: ["waiting_approval", "done", "failed"],
  waiting_approval: ["running", "failed"],
  done: [],
  failed: [],
};

export const isTerminal = (status: RunStatus) => RUN_TRANSITIONS[status].length === 0;
export const canTransition = (from: RunStatus, to: RunStatus) => RUN_TRANSITIONS[from].includes(to);

export class InvalidRunTransitionError extends Error {
  constructor(from: RunStatus, to: RunStatus) {
    super(`agent run can't go from ${from} to ${to}`);
    this.name = "InvalidRunTransitionError";
  }
}

/**
 * Compare-and-set transition: succeeds only if the run is still in `from`.
 * Returns the updated run, or null when another worker moved it first.
 */
export async function transitionRun(
  db: Executor,
  runId: string,
  from: RunStatus,
  to: RunStatus,
  patch: { error?: string | null; replyMessageId?: string; transcript?: Record<string, unknown> } = {},
): Promise<AgentRun | null> {
  if (!canTransition(from, to)) throw new InvalidRunTransitionError(from, to);
  const now = new Date();
  const [row] = await db
    .update(agentRuns)
    .set({
      status: to,
      updatedAt: now,
      ...(to === "running"
        ? { startedAt: sql`coalesce(${agentRuns.startedAt}, ${now.toISOString()}::timestamptz)` }
        : {}),
      ...(isTerminal(to) ? { finishedAt: now } : {}),
      ...patch,
    })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, from)))
    .returning();
  return row ?? null;
}

export type StepKind = (typeof schema.agentRunStepKindEnum.enumValues)[number];

/** Appends a step to a run's trail (numbered in order). */
export async function addRunStep(
  db: Executor,
  run: Pick<AgentRun, "id" | "orgId">,
  kind: StepKind,
  data: Record<string, unknown>,
) {
  await db.insert(agentRunSteps).values({
    orgId: run.orgId,
    runId: run.id,
    kind,
    data,
    seq: sql`(select coalesce(max(${agentRunSteps.seq}), 0) + 1 from ${agentRunSteps} where ${agentRunSteps.runId} = ${run.id})`,
  });
}
