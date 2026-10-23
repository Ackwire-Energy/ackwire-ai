import { and, type Database, type Executor, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { audienceSql } from "./audience";
import { personOfMessage, runAuthorityById } from "./authority";
import { dmAgents, isAgentOnlyDm } from "./dms";
import { getMessage, type Message } from "./messages";
import { enqueue } from "./outbox";
import { ACTIVE_RUN_STATUSES, queueOnRun } from "./run-inbox";
import { inChannelRun } from "./run-scope";
import type { AgentRun } from "./runs";

const { agents, channelMembers, channels, agentRuns } = schema;

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
  options: StartRunOptions = {},
): Promise<AgentRun[]> {
  const created: AgentRun[] = [];
  for (const agentId of agentIds) {
    const started = await startOrJoinRun(tx, message, agentId, trigger, options);
    if (started && "created" in started) created.push(started.created);
  }
  return created;
}

export interface StartRunOptions {
  /**
   * A person's new message in the channel (the router picked the agent): it also joins the agent's
   * run that answers in the channel itself (D62), so two people calling one agent get one answer.
   * Routines, agents' messages and consultations keep one run per message.
   */
  joinChannelRun?: boolean;
  /**
   * Background work (a routine's run): it holds no conversation's slot, so it never joins the
   * conversation's active run (nor does anything ever join it).
   */
  background?: boolean;
}

/**
 * One agent and one message: the message joins the agent's active run in that conversation (read
 * at its next step; `joined`), or a run starts on it (`created`). Null: nothing to do (a
 * redelivered event). A run that ends between the lookup and the append is never appended to:
 * the message starts a run of its own instead.
 */
export async function startOrJoinRun(
  tx: Executor,
  message: Pick<Message, "id" | "orgId" | "channelId" | "threadId" | "hop">,
  agentId: string,
  trigger: RunTrigger,
  options: StartRunOptions = {},
): Promise<{ created: AgentRun } | { joined: string } | null> {
  // One active run per agent and conversation (forum turns are driven separately; background runs
  // hold no slot): the message goes to it, read at its next step, instead of a second run.
  if (trigger !== "forum" && !options.background) {
    // In the agents' DM several runs may be active, one per person behind them: join that person's.
    const active = await tx
      .select({ id: agentRuns.id, triggerMessageId: agentRuns.triggerMessageId })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, message.orgId),
          eq(agentRuns.agentId, agentId),
          eq(agentRuns.channelId, message.channelId),
          inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
          eq(agentRuns.background, false),
          sql`(${agentRuns.threadRootId} = ${message.threadId ?? message.id}::uuid or exists (
            select 1 from channels c where c.id = ${message.channelId}::uuid and c.kind = 'dm')
            or ${
              options.joinChannelRun && !message.threadId
                ? sql`(${agentRuns.status} in ('queued', 'running') and ${inChannelRun(sql`${agentRuns}`)})`
                : sql`false`
            })`,
        ),
      )
      .orderBy(sql`${agentRuns.createdAt} desc`)
      .limit(10);
    for (const run of active) {
      if (run.triggerMessageId === message.id || !(await samePersonInAgentsDm(tx, message, run.id))) continue;
      if (await queueOnRun(tx, run.id, message.id)) return { joined: run.id };
      break;
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
      ...(options.background ? { background: true } : {}),
    })
    .onConflictDoNothing()
    .returning();
  if (!run) return null;
  await enqueue(tx, {
    orgId: message.orgId,
    kind: "agent_run.execute",
    payload: { runId: run.id },
    dedupeKey: `agent_run.execute:${run.id}`,
    maxAttempts: 4,
  });
  return { created: run };
}

/**
 * In the agents' DM a run works for one person (ADR 0053 §9): a question or note joins the run active
 * there only when the same person is behind both (or nobody is behind either); otherwise it starts a
 * run of its own, so one person's exchange never reaches a run working for another. Any other
 * conversation: true.
 */
async function samePersonInAgentsDm(
  tx: Executor,
  message: Pick<Message, "id" | "orgId" | "channelId">,
  runId: string,
): Promise<boolean> {
  const [channel] = await tx
    .select({ kind: channels.kind, dmKey: channels.dmKey })
    .from(channels)
    .where(and(eq(channels.orgId, message.orgId), eq(channels.id, message.channelId)));
  if (!channel || !isAgentOnlyDm(channel)) return true;
  const person = await personOfMessage(tx, message.orgId, message.id);
  const behindRun = await runAuthorityById(tx, message.orgId, runId);
  return person === behindRun.personId;
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
 * The person behind a message (`authority.ts`): its author, or for an agent's message the person
 * behind the run that wrote it. Null when nobody is (a routine, a webhook, an agent on its own).
 */
export const requesterOf = (db: Executor, message: Pick<Message, "orgId" | "id">) =>
  personOfMessage(db, message.orgId, message.id);

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
