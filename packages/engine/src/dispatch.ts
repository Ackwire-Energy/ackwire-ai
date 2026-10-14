import { and, type Database, eq, inArray, isNull, schema } from "@agenteschat/db";
import { getMessage } from "./messages";
import { enqueue } from "./outbox";
import type { AgentRun } from "./runs";

const { agents, channelMembers, agentRuns } = schema;

export interface DispatchResult {
  runs: AgentRun[];
  /** Why nothing was started, when nothing was. */
  skipped?: "no_mentions" | "hop_limit" | "message_missing";
}

/**
 * Handles `message.posted`: starts one `agent_run` per explicitly @mentioned
 * agent (no router yet). Enforces the per-thread hop limit: a message whose
 * hop already reached `maxHops` (that many consecutive agent replies since a
 * person last posted in the thread) triggers nobody.
 *
 * Idempotent: `(trigger_message_id, agent_id)` is unique, and the execute job
 * has a dedupe key, so a redelivered event starts nothing twice.
 */
export async function dispatchMentions(
  db: Database,
  input: { orgId: string; messageId: string },
  options: { maxHops: number },
): Promise<DispatchResult> {
  const message = await getMessage(db, input.orgId, input.messageId);
  if (!message) return { runs: [], skipped: "message_missing" };
  const candidates = message.mentionedAgentIds.filter((id) => id !== message.authorAgentId);
  if (candidates.length === 0) return { runs: [], skipped: "no_mentions" };
  if (message.hop >= options.maxHops) return { runs: [], skipped: "hop_limit" };

  // Re-check at dispatch time: the agent may have been archived or removed from the channel since.
  const eligible = await db
    .select({ id: agents.id })
    .from(agents)
    .innerJoin(
      channelMembers,
      and(eq(channelMembers.agentId, agents.id), eq(channelMembers.channelId, message.channelId)),
    )
    .where(and(eq(agents.orgId, message.orgId), inArray(agents.id, candidates), isNull(agents.archivedAt)));

  const runs = await db.transaction(async (tx) => {
    const created: AgentRun[] = [];
    for (const { id: agentId } of eligible) {
      const [run] = await tx
        .insert(agentRuns)
        .values({
          orgId: message.orgId,
          agentId,
          channelId: message.channelId,
          threadRootId: message.threadId ?? message.id,
          triggerMessageId: message.id,
          trigger: "mention",
          hop: message.hop + 1,
        })
        .onConflictDoNothing()
        .returning();
      if (!run) continue;
      await enqueue(tx, {
        orgId: message.orgId,
        kind: "agent_run.execute",
        payload: { runId: run.id },
        dedupeKey: `agent_run.execute:${run.id}`,
        maxAttempts: 4,
      });
      created.push(run);
    }
    return created;
  });
  return { runs };
}
