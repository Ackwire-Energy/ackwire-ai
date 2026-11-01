import { and, type Database, type Executor, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { audienceSql } from "./audience";
import { messageRoot, personOfMessage, runAuthorityById } from "./authority";
import { dmAgents, isAgentOnlyDm } from "./dms";
import { getMessage, type Message } from "./messages";
import { enqueue } from "./outbox";
import { routineCreatorOf } from "./requester";
import { holdsMessages } from "./run-hold";
import { ACTIVE_RUN_STATUSES, queueOnRun } from "./run-inbox";
import { inChannelRun } from "./run-scope";
import type { AgentRun } from "./runs";
import { holdOf, hopLimitReached, pauseStretch, stretchOf, stretchStop } from "./stretch";

const { agents, channelMembers, channels, agentRuns, messages } = schema;

export type RunTrigger = AgentRun["trigger"];

export interface DispatchResult {
  runs: AgentRun[];
  /** Why nothing was started, when nothing was. */
  skipped?: "no_mentions" | "hop_limit" | "message_missing";
}

/** What starting a run on a message reads of it. */
type Trigger = Pick<
  Message,
  "id" | "orgId" | "channelId" | "threadId" | "hop" | "stretchId" | "authorAgentId" | "agentRunId"
>;

/**
 * Creates one `agent_run` per agent for a trigger message and enqueues its
 * execution, in the caller's transaction. Shared by every way agents wake up
 * (mentions, router, DMs, routines, webhooks, issues). Idempotent:
 * `(trigger_message_id, agent_id)` is unique and the execute job has a dedupe
 * key, so a redelivered event starts nothing twice.
 *
 * Callers decide WHO may run (eligibility, the depth backstop); this never grants anything.
 */
export async function createAgentRuns(
  tx: Executor,
  message: Trigger,
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
   * run that answers in the channel itself (ADR 0029), so two people calling one agent get one answer.
   * Routines, agents' messages and consultations keep one run per message.
   */
  joinChannelRun?: boolean;
  /**
   * Background work (a routine's run): it holds no conversation's slot, so it never joins the
   * conversation's active run (nor does anything ever join it).
   */
  background?: boolean;
  /**
   * A person let the work go on (Continuar on a stretch's pause card): the run starts at hop 1 in this fresh
   * stretch, past the limits of the one that held it (ADR 0089).
   */
  granted?: string;
}

/**
 * One agent and one message: the message joins the agent's active run in that conversation (read
 * at its next step; `joined`), or a run starts on it (`created`). Null: nothing to do (a
 * redelivered event), or a run agents started on their own would pass its stretch's limits
 * (`stretchStop`): the wake-up is held for the pause card (ADR 0089). A run that ends between the
 * lookup and the append is never appended to: the message starts a run of its own instead.
 */
export async function startOrJoinRun(
  tx: Executor,
  message: Trigger,
  agentId: string,
  trigger: RunTrigger,
  options: StartRunOptions = {},
): Promise<{ created: AgentRun } | { joined: string } | null> {
  // One active run per agent and conversation (forum turns are driven separately; background runs
  // hold no slot): the message goes to it, read at its next step, instead of a second run.
  if (trigger !== "forum" && !options.background) {
    // Several runs may be active (in the agents' DM one per person behind them; elsewhere a person's run
    // next to an unattended one, or one held by a decision): the message joins the newest it may
    // (`mayJoin`). A run waiting on an approval, a secret or a mission's decision takes nothing new
    // (`holdsMessages`): the agent answers this in a run of its own meanwhile.
    const active = await tx
      .select({
        id: agentRuns.id,
        orgId: agentRuns.orgId,
        status: agentRuns.status,
        triggerMessageId: agentRuns.triggerMessageId,
      })
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
      if (
        run.triggerMessageId === message.id ||
        (await holdsMessages(tx, run)) ||
        !(await mayJoin(tx, message, run.id))
      )
        continue;
      if (await queueOnRun(tx, run.id, message.id)) return { joined: run.id };
      break;
    }
  }
  // Agents started it (its trigger is an agent's, hop 1 or more): within its stretch's limits. A forum's turns and a
  // routine's background run keep their own.
  if (!options.granted && trigger !== "forum" && !options.background && message.hop >= 1) {
    const stop = await stretchStop(tx, message.orgId, stretchOf(message), agentId, message.id);
    if (stop) {
      await pauseStretch(tx, message.orgId, holdOf(message, agentId, trigger, stop));
      return null;
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
      hop: options.granted ? 1 : message.hop + 1,
      stretchId: options.granted ?? stretchOf(message),
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
 * Whether a message may join a run active in its conversation (ADR 0053 §4, §9). A person's own words
 * steer the agent's run there (and put them behind an unattended one), except in the agents' DM, where a
 * run works for one person. Another agent's message for a person joins only a run working for that same
 * person. A routine's report or another agent's note joins only a run such news woke: never one working
 * for a person, nor the agent's own work (a mission's); it starts a run of its own. The agent's own
 * events (a task that ended, a folder decision) still go to whatever run is working there.
 */
export async function mayJoin(
  tx: Executor,
  message: Pick<Message, "id" | "orgId" | "channelId">,
  runId: string,
): Promise<boolean> {
  const [channel] = await tx
    .select({ kind: channels.kind, dmKey: channels.dmKey })
    .from(channels)
    .where(and(eq(channels.orgId, message.orgId), eq(channels.id, message.channelId)));
  const agentsDm = !!channel && isAgentOnlyDm(channel);
  const [row] = await tx
    .select({ authorType: messages.authorType })
    .from(messages)
    .where(and(eq(messages.orgId, message.orgId), eq(messages.id, message.id)));
  if (row?.authorType === "person" && !agentsDm) return true;
  const root = await messageRoot(tx, message.orgId, message.id);
  if (root.kind === "agent" && !agentsDm) return true;
  const behind = await runAuthorityById(tx, message.orgId, runId);
  if (root.kind === "person") return behind.personId === root.personId;
  if (root.kind === "agent") return behind.personId === null;
  return behind.kind === "unattended" && behind.reason !== "agent";
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
        // Who can talk to the agent, for the person behind the message.
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
 * explicitly @mentioned agent. A message whose hop already reached `maxHops`
 * (the depth backstop, `hopLimitReached`) triggers nobody.
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
  if (await hopLimitReached(db, message, options.maxHops)) return { runs: [], skipped: "hop_limit" };

  // Re-check at dispatch time: the agent may have been archived or removed from the channel since.
  // An agent asking another one acts for the person behind its run, who must be allowed to talk to it;
  // a routine set to act wakes only agents its creator can talk to.
  const requester =
    (await requesterOf(db, message)) ??
    (message.agentRunId ? routineCreatorOf(await runAuthorityById(db, message.orgId, message.agentRunId)) : null);
  const eligible = await eligibleChannelAgents(db, message.orgId, message.channelId, candidates, {
    requesterUserId: requester,
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
