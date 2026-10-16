import { and, type Database, type Executor, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { audienceSql } from "./audience";
import { dmAgents } from "./dms";
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
    // One active run per agent and conversation (forum turns are driven separately):
    // the message goes to it, read at its next step, instead of a second run.
    if (trigger !== "forum") {
      const [active] = await tx
        .select({
          id: agentRuns.id,
          pending: agentRuns.pendingMessageIds,
          triggerMessageId: agentRuns.triggerMessageId,
        })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.orgId, message.orgId),
            eq(agentRuns.agentId, agentId),
            eq(agentRuns.channelId, message.channelId),
            inArray(agentRuns.status, ["queued", "running", "waiting_approval", "waiting_input"]),
            sql`(${agentRuns.threadRootId} = ${message.threadId ?? message.id}::uuid or exists (
              select 1 from channels c where c.id = ${message.channelId}::uuid and c.kind = 'dm'))`,
          ),
        )
        .orderBy(sql`${agentRuns.createdAt} desc`)
        .limit(1);
      if (active && active.triggerMessageId !== message.id) {
        if (!active.pending.includes(message.id)) {
          await tx
            .update(agentRuns)
            .set({ pendingMessageIds: sql`array_append(${agentRuns.pendingMessageIds}, ${message.id}::uuid)` })
            .where(eq(agentRuns.id, active.id));
        }
        continue;
      }
    }
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
  options: { autoReplyOnly?: boolean; requesterUserId?: string | null } = {},
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
        // Who can talk to the agent (D31), for the person behind the message.
        options.requesterUserId !== undefined
          ? audienceSql("agents", sql`${options.requesterUserId}::text`)
          : undefined,
      ),
    );
}

/**
 * The person behind a message: its author, or for an agent's message the
 * person whose message started that agent's run (up to a few hops). Null when
 * a routine, webhook or other system started the chain.
 */
export async function requesterOf(db: Executor, message: Pick<Message, "orgId" | "authorUserId" | "agentRunId">) {
  let current: Pick<Message, "authorUserId" | "agentRunId"> | null = message;
  for (let hop = 0; current && hop < 6; hop++) {
    if (current.authorUserId) return current.authorUserId;
    if (!current.agentRunId) return null;
    const [run] = await db
      .select({ trigger: agentRuns.triggerMessageId })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, current.agentRunId), eq(agentRuns.orgId, message.orgId)));
    if (!run) return null;
    current = await getMessage(db, message.orgId, run.trigger);
  }
  return null;
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
  options: { maxHops: number; onlyAgentIds?: string[] },
): Promise<DispatchResult> {
  const message = await getMessage(db, input.orgId, input.messageId);
  if (!message) return { runs: [], skipped: "message_missing" };
  const candidates = message.mentionedAgentIds.filter(
    (id) => id !== message.authorAgentId && (!options.onlyAgentIds || options.onlyAgentIds.includes(id)),
  );
  if (candidates.length === 0) return { runs: [], skipped: "no_mentions" };
  if (message.hop >= options.maxHops) return { runs: [], skipped: "hop_limit" };

  // Re-check at dispatch time: the agent may have been archived or removed from the channel since.
  // An agent asking another one acts for the person behind its run, who must be allowed to talk to it.
  const eligible = await eligibleChannelAgents(db, message.orgId, message.channelId, candidates, {
    requesterUserId: await requesterOf(db, message),
  });
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

/**
 * A person's message in a DM with an agent: the agent always answers (no
 * router), within the hop limit. Mentions in a DM go through `dispatchMentions`.
 */
export async function dispatchDm(
  db: Database,
  message: Message,
  options: { maxHops: number },
): Promise<DispatchResult & { agentIds: string[] }> {
  if (message.authorType !== "person") return { runs: [], agentIds: [] };
  if (message.hop >= options.maxHops) return { runs: [], skipped: "hop_limit", agentIds: [] };
  const dm = await dmAgents(db, message.orgId, message.channelId);
  const allowed = await eligibleChannelAgents(
    db,
    message.orgId,
    message.channelId,
    dm.map((a) => a.id),
    { requesterUserId: message.authorUserId },
  );
  const agentIds = allowed.map((a) => a.id);
  const runs = await db.transaction((tx) => createAgentRuns(tx, message, agentIds, "dm"));
  return { runs, agentIds };
}
