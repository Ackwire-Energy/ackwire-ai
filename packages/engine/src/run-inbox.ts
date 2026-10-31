import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { mayJoin, type RunTrigger, startOrJoinRun } from "./dispatch";
import { publishChannelEvent } from "./events";
import type { Message } from "./messages";
import { holdsMessages } from "./run-hold";
import { type AgentRun, addRunStep, replyThreadOf } from "./runs";

const { agentRuns, agents, channels, messages } = schema;

/**
 * A run's inbox (`agent_runs.pending_message_ids`): messages sent to the agent's conversation while
 * the run is active (one active run per agent and conversation), read at its next step. The rule
 * that makes delivery safe: a message is only ever queued on a run that is still active, and when
 * a run ends (done, failed, canceled, interrupted) whatever it hasn't read goes to a run of its own.
 * Nothing sent to an agent is dropped (unless it was archived), nor left on a dead run; the sweeper is the
 * safety net.
 */
export const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting_approval", "waiting_input"] as const;

/**
 * Why a run's unread messages were handed on (kept on the run's trail). `held`: the run waits on
 * something a message can't move (an approval, a secret, a mission's decision: `holdsMessages`).
 */
export type ReleaseReason = "done" | "failed" | "canceled" | "interrupted" | "swept" | "held";

/**
 * Queues a message on a run, only while the run is still active (status-guarded: a run that ended
 * meanwhile is never appended to). Idempotent. False: the run ended; the caller starts a run instead.
 */
export async function queueOnRun(tx: Executor, runId: string, messageId: string): Promise<boolean> {
  const queued = await tx
    .update(agentRuns)
    .set({
      pendingMessageIds: sql`case when ${messageId}::uuid = any(${agentRuns.pendingMessageIds})
        then ${agentRuns.pendingMessageIds} else array_append(${agentRuns.pendingMessageIds}, ${messageId}::uuid) end`,
      updatedAt: new Date(),
    })
    .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES])))
    .returning({ id: agentRuns.id });
  return queued.length > 0;
}

/** Takes the run's unread messages (the inbox is emptied): the executor reads them, or hands them on. */
export async function takeInbox(db: Executor, runId: string): Promise<string[]> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ pending: agentRuns.pendingMessageIds })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .for("update");
    const ids = row?.pending ?? [];
    if (ids.length === 0) return [];
    await tx.update(agentRuns).set({ pendingMessageIds: [] }).where(eq(agentRuns.id, runId));
    return ids;
  });
}

/**
 * A run ended without reading some messages: they get a run of their own (the last person's
 * message is its trigger; it reads the conversation, so the earlier ones too), or join the agent's run already
 * active there. `exclude`: messages that need no answer (the one that asked it to stop). The app
 * hears `agent.run.redispatched`. Forum turns are driven by the topic, never redispatched.
 * Returns the run that took them, or null when there was nothing to hand on.
 */
export async function releaseInbox(
  db: Database,
  pubsub: PubSub | undefined,
  run: Pick<AgentRun, "id" | "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId" | "trigger">,
  options: { reason: ReleaseReason; exclude?: string[] },
): Promise<{ runId: string; messageIds: string[] } | null> {
  const taken = await takeInbox(db, run.id).catch(() => [] as string[]);
  return handOn(db, pubsub, run, taken, options);
}

/**
 * Some messages queued on a run that holds them (`holdsMessages`: it waits on an approval, a secret, a
 * mission's decision) leave its inbox and get a run of their own, like an ending's (`releaseInbox`): the
 * agent answers now, the held run still waits for its decision. Those no longer queued there (read, or
 * already handed on) are left alone.
 */
export async function handOnMessages(
  db: Database,
  pubsub: PubSub | undefined,
  run: Pick<AgentRun, "id" | "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId" | "trigger">,
  messageIds: string[],
): Promise<{ runId: string; messageIds: string[] } | null> {
  // Forum turns are driven by the topic: nothing is handed on from them.
  if (messageIds.length === 0 || run.trigger === "forum") return null;
  const taken = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ pending: agentRuns.pendingMessageIds })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.id))
      .for("update");
    const pending = row?.pending ?? [];
    const ids = pending.filter((id) => messageIds.includes(id));
    if (ids.length === 0) return [];
    await tx
      .update(agentRuns)
      .set({ pendingMessageIds: pending.filter((id) => !ids.includes(id)) })
      .where(eq(agentRuns.id, run.id));
    return ids;
  });
  return handOn(db, pubsub, run, taken, { reason: "held" });
}

/**
 * The run just paused on something a message can't move (`holdsMessages`): what it hadn't read yet gets
 * a run of its own instead of waiting behind the decision. A no-op for any other pause.
 */
export async function releaseHeldInbox(db: Database, pubsub: PubSub | undefined, runId: string) {
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!row || row.pendingMessageIds.length === 0 || !(await holdsMessages(db, row))) return null;
  return releaseInbox(db, pubsub, row, { reason: "held" });
}

/** Messages taken from a run's inbox go on: to a run of their own, or the agent's run already active there. */
async function handOn(
  db: Database,
  pubsub: PubSub | undefined,
  run: Pick<AgentRun, "id" | "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId" | "trigger">,
  taken: string[],
  options: { reason: ReleaseReason; exclude?: string[] },
): Promise<{ runId: string; messageIds: string[] } | null> {
  const ids = taken.filter((id) => !options.exclude?.includes(id));
  if (ids.length === 0 || run.trigger === "forum") return null;
  // An archived (or deleted) agent answers nobody: a run of its own would only fail, so what it was sent is dropped.
  const [agent] = await db.select({ archivedAt: agents.archivedAt }).from(agents).where(eq(agents.id, run.agentId));
  if (!agent || agent.archivedAt) return null;
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.orgId, run.orgId), inArray(messages.id, ids), isNull(messages.deletedAt)))
    .orderBy(asc(messages.createdAt));
  // The trigger: the last person's message, else the last notice (a routine's report, another agent's
  // answer: events the agent must act on), else another agent's call. The agent's own fast reply
  // (talker) is context only: it never starts a run by itself.
  const callers = rows.filter((m) => !m.meta.talker);
  const last =
    callers.filter((m) => m.authorType === "person").at(-1) ??
    callers.filter((m) => m.meta.notice).at(-1) ??
    callers.at(-1);
  if (!last) return null;
  const trigger = await triggerFor(db, run, last);
  const started = await db.transaction(async (tx) => {
    const out = await startOrJoinRun(tx, last, run.agentId, trigger);
    if (!out) return out;
    const taker = "created" in out ? out.created.id : out.joined;
    for (const m of rows) {
      if (m.id === last.id) continue;
      // One that may not reach the run that took them (a routine's report next to a person's message,
      // ADR 0053 §4) goes its own way.
      if (!(await mayJoin(tx, m, taker))) await startOrJoinRun(tx, m, run.agentId, await triggerFor(tx, run, m));
      // Joined a run that already read its context: the rest go to it too (a new run reads them in the conversation).
      else if ("joined" in out) await queueOnRun(tx, out.joined, m.id);
    }
    return out;
  });
  if (!started) return null;
  const newRunId = "created" in started ? started.created.id : started.joined;
  const messageIds = rows.map((m) => m.id);
  await addRunStep(db, run, "context", {
    redispatchedMessageIds: messageIds,
    reason: options.reason,
    toRunId: newRunId,
  }).catch(() => undefined);
  const threadId = replyThreadOf(run);
  await publishChannelEvent(pubsub, {
    type: "agent.run.redispatched",
    channelId: run.channelId,
    threadId,
    agentId: run.agentId,
    runId: run.id,
    newRunId,
    messageIds,
  });
  if ("created" in started) {
    await publishChannelEvent(pubsub, {
      type: "agent.thinking",
      channelId: run.channelId,
      threadId: replyThreadOf(started.created),
      agentId: run.agentId,
      runId: newRunId,
    });
  }
  return { runId: newRunId, messageIds };
}

/**
 * The trigger of the run a handed-on message starts (ADR 0053 §10): it matches the message, never the run
 * that ended. A person's message in a DM is `dm`; a person's message or a notice elsewhere is `mention`
 * (it was sent to this agent: it must answer, never pass as a router pick would). Another agent's message
 * keeps how the ended run was called.
 */
async function triggerFor(
  db: Executor,
  run: Pick<AgentRun, "channelId" | "trigger">,
  message: Pick<Message, "authorType" | "meta" | "channelId">,
): Promise<RunTrigger> {
  if (message.authorType === "person") {
    const [channel] = await db.select({ kind: channels.kind }).from(channels).where(eq(channels.id, message.channelId));
    return channel?.kind === "dm" ? "dm" : "mention";
  }
  if (message.meta.notice) return "mention";
  return run.trigger;
}

/** How long an ended run's unread messages are left to the path that ended it before the sweeper takes them. */
export const INBOX_SWEEP_GRACE_MS = 30_000;
/**
 * A run that ended longer ago than this is stale: its unread messages are only emptied, never answered
 * now (inboxes left from before delivery existed woke agents on requests days old).
 */
export const INBOX_SWEEP_MAX_AGE_MS = 60 * 60_000;

/**
 * Safety net: ended runs (done, failed, canceled) still holding unread messages, finished more
 * than `graceMs` ago (whatever ended them didn't hand them on: a crash between the end and the
 * release, or a path that ends runs without it), are released; ones that ended more than
 * `maxAgeMs` ago are only emptied. Idempotent: a released inbox is empty. Returns how many runs were swept.
 */
export async function sweepEndedInboxes(
  deps: { db: Database; pubsub?: PubSub },
  options: { now?: Date; graceMs?: number; maxAgeMs?: number; limit?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.graceMs ?? INBOX_SWEEP_GRACE_MS));
  const stale = now.getTime() - (options.maxAgeMs ?? INBOX_SWEEP_MAX_AGE_MS);
  const ended = await deps.db
    .select()
    .from(agentRuns)
    .where(
      and(
        inArray(agentRuns.status, ["done", "failed", "canceled"]),
        sql`cardinality(${agentRuns.pendingMessageIds}) > 0`,
        sql`coalesce(${agentRuns.finishedAt}, ${agentRuns.updatedAt}) < ${cutoff.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(agentRuns.updatedAt))
    .limit(options.limit ?? 100);
  let swept = 0;
  for (const run of ended) {
    // Nobody waits for an answer this late: the inbox is just emptied (an archived agent's always is, `handOn`).
    const endedAt = (run.finishedAt ?? run.updatedAt).getTime();
    if (endedAt < stale) await takeInbox(deps.db, run.id);
    else await releaseInbox(deps.db, deps.pubsub, run, { reason: "swept" });
    swept++;
  }
  return swept;
}
