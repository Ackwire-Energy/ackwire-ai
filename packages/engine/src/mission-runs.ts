import { and, type Executor, eq, inArray, schema, sql } from "@agenteschat/db";
import { enqueue } from "./outbox";

const { agentRuns } = schema;

/**
 * A run of the mission's agent on a notice in its home thread (agent mode,
 * ADR 0029): when the agent already works in that thread, the notice joins
 * that run (read at its next step, like a person's message); otherwise a new
 * run starts on it. Only that exact thread counts (a run elsewhere in a DM is
 * another conversation). Returns the new run, or `steered` with the run that
 * got it.
 */
export async function enqueueRunJob(
  tx: Executor,
  message: { id: string; orgId: string; channelId: string; threadId: string | null; hop: number },
  agentId: string,
): Promise<{ run: typeof agentRuns.$inferSelect | null; steered: string | null }> {
  const threadRootId = message.threadId ?? message.id;
  const [active] = await tx
    .select({ id: agentRuns.id, pending: agentRuns.pendingMessageIds })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, message.orgId),
        eq(agentRuns.agentId, agentId),
        eq(agentRuns.channelId, message.channelId),
        eq(agentRuns.threadRootId, threadRootId),
        inArray(agentRuns.status, ["queued", "running", "waiting_approval", "waiting_input"]),
      ),
    )
    .orderBy(sql`${agentRuns.createdAt} desc`)
    .limit(1);
  if (active) {
    if (!active.pending.includes(message.id)) {
      await tx
        .update(agentRuns)
        .set({ pendingMessageIds: sql`array_append(${agentRuns.pendingMessageIds}, ${message.id}::uuid)` })
        .where(eq(agentRuns.id, active.id));
    }
    return { run: null, steered: active.id };
  }
  const [run] = await tx
    .insert(agentRuns)
    .values({
      orgId: message.orgId,
      agentId,
      channelId: message.channelId,
      threadRootId,
      triggerMessageId: message.id,
      trigger: "mention",
      // The notice is hop 0: inside an active mission its own wake-ups don't count toward the agent-to-agent limit.
      hop: message.hop + 1,
    })
    .onConflictDoNothing()
    .returning();
  if (!run) return { run: null, steered: null };
  await enqueue(tx, {
    orgId: message.orgId,
    kind: "agent_run.execute",
    payload: { runId: run.id },
    dedupeKey: `agent_run.execute:${run.id}`,
    maxAttempts: 4,
  });
  return { run, steered: null };
}
