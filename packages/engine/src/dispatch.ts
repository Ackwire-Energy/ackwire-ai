import { and, type Database, type Executor, eq, inArray, isNull, schema } from "@agenteschat/db";
import { getMessage, type Message } from "./messages";
import { enqueue } from "./outbox";
import type { AgentRun } from "./runs";

const { agents, channelMembers, agentRuns } = schema;

export type RunTrigger = AgentRun["trigger"];

export interface DispatchResult {
  runs: AgentRun[];
  /** Why nothing was started, when nothing was. */
  skipped?: "no_mentions" | "hop_limit" | "message_missing";
}

/**
 * Creates one `agent_run` per agent for a trigger message and enqueues its
 * execution, in the caller's transaction. Shared by every way agents wake up
 * (mentions, router, DMs, routines, webhooks, issues). Idempotent:
 * `(trigger_message_id, agent_id)` is unique and the execute job has a dedupe
 * key, so a redelivered event starts nothing twice.
 *
 * Callers decide WHO may run (eligibility, hop limit); this never grants anything.
 */
export async function createAgentRuns(
  tx: Executor,
  message: Pick<Message, "id" | "orgId" | "channelId" | "threadId" | "hop">,
  agentIds: string[],
  trigger: RunTrigger,
): Promise<AgentRun[]> {
  const created: AgentRun[] = [];
  for (const agentId of agentIds) {
    const [run] = await tx
      .insert(agentRuns)
      .values({
        orgId: message.orgId,
        agentId,
        channelId: message.channelId,
        threadRootId: message.threadId ?? message.id,
        triggerMessageId: message.id,
        trigger,
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
}

/** Active agents among `agentIds` that are members of the channel (re-checked at dispatch time). */
export async function eligibleChannelAgents(
  db: Executor,
  orgId: string,
  channelId: string,
  agentIds: string[],
  options: { autoReplyOnly?: boolean } = {},
) {
  if (agentIds.length === 0) return [];
  return db
    .select({ id: agents.id, handle: agents.handle, name: agents.name, role: agents.role })
    .from(agents)
    .innerJoin(channelMembers, and(eq(channelMembers.agentId, agents.id), eq(channelMembers.channelId, channelId)))
    .where(
      and(
        eq(agents.orgId, orgId),
        inArray(agents.id, agentIds),
        isNull(agents.archivedAt),
        options.autoReplyOnly ? eq(channelMembers.autoReply, true) : undefined,
      ),
    );
}

/**
 * Handles `message.posted` for messages with mentions: starts one run per
 * explicitly @mentioned agent. Enforces the per-thread hop limit: a message
 * whose hop already reached `maxHops` (that many consecutive agent replies
 * since a person last posted in the thread) triggers nobody.
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
  const eligible = await eligibleChannelAgents(db, message.orgId, message.channelId, candidates);
  const runs = await db.transaction((tx) =>
    createAgentRuns(
      tx,
      message,
      eligible.map((a) => a.id),
      "mention",
    ),
  );
  return { runs };
}
