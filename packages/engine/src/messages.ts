import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  desc,
  type Executor,
  eq,
  inArray,
  isNull,
  lt,
  rowsOf,
  schema,
  sql,
} from "@agenteschat/db";
import { requireChannelAccess } from "./channels";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishMessageCreated } from "./events";
import { can } from "./organizations";
import { afterReplyAnswered } from "./questions";

const { messages, agents, channelMembers, channels, agentRuns, outbox, agentQuestions } = schema;

export type Message = typeof messages.$inferSelect;

export const MAX_MESSAGE_LENGTH = 40_000;

export interface MessageView {
  id: string;
  channelId: string;
  threadId: string | null;
  author: { type: "person" | "agent"; id: string | null };
  body: string;
  mentionedAgentIds: string[];
  agentRunId: string | null;
  /** Structured attachments: `{ approvalId }`, `{ memoryUpdates }`, `{ clientId }`. */
  meta: Record<string, unknown>;
  /** The sender's own id for the optimistic copy (echoed back). */
  clientId: string | null;
  /** Which agents saw it and which answered (in message lists; no router scores). */
  receipts?: Receipts;
  createdAt: string;
}

export const messageView = (m: Message): MessageView => ({
  id: m.id,
  channelId: m.channelId,
  threadId: m.threadId,
  author: { type: m.authorType, id: m.authorType === "person" ? m.authorUserId : m.authorAgentId },
  body: m.body,
  mentionedAgentIds: m.mentionedAgentIds,
  agentRunId: m.agentRunId,
  meta: m.meta,
  clientId: typeof m.meta.clientId === "string" ? m.meta.clientId : null,
  createdAt: m.createdAt.toISOString(),
});

export interface Receipts {
  seenBy: string[];
  pickedBy: string[];
  handled: {
    agentId: string;
    status: "queued" | "running" | "waiting_approval" | "waiting_input" | "done" | "failed";
  }[];
}

/**
 * Receipts for messages, from what is already stored: the routing decision
 * (candidates = seen), mentions, and the runs each message triggered.
 * Router off or no candidates → empty receipts.
 */
export async function receiptsFor(db: Database, orgId: string, list: Message[]): Promise<Map<string, Receipts>> {
  const out = new Map<string, Receipts>();
  const ids = list.map((m) => m.id);
  if (ids.length === 0) return out;
  const [decisions, runs] = await Promise.all([
    db
      .select({ messageId: schema.routingDecisions.messageId, candidates: schema.routingDecisions.candidates })
      .from(schema.routingDecisions)
      .where(and(eq(schema.routingDecisions.orgId, orgId), inArray(schema.routingDecisions.messageId, ids))),
    db
      .select({
        triggerMessageId: schema.agentRuns.triggerMessageId,
        agentId: schema.agentRuns.agentId,
        status: schema.agentRuns.status,
      })
      .from(schema.agentRuns)
      .where(and(eq(schema.agentRuns.orgId, orgId), inArray(schema.agentRuns.triggerMessageId, ids))),
  ]);
  const seen = new Map(decisions.map((d) => [d.messageId, d.candidates.map((c) => c.agentId)]));
  for (const m of list) {
    const mine = runs.filter((r) => r.triggerMessageId === m.id);
    const seenBy = [...new Set([...(seen.get(m.id) ?? []), ...m.mentionedAgentIds, ...mine.map((r) => r.agentId)])];
    out.set(m.id, {
      seenBy,
      pickedBy: mine.map((r) => r.agentId),
      handled: mine.map((r) => ({ agentId: r.agentId, status: r.status })),
    });
  }
  return out;
}

/** `@handle` tokens in a message, lower-cased and de-duplicated. Emails (`a@b.c`) are not mentions. */
export function parseMentionHandles(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(/(^|[^\w@.])@([a-zA-Z0-9][a-zA-Z0-9_-]{1,31})(?![\w@-])/g)) {
    if (match[2]) found.add(match[2].toLowerCase());
  }
  return [...found];
}

export type MessageAuthor =
  | { type: "person"; userId: string }
  | { type: "agent"; agentId: string; runId: string; hop: number };

export interface NewMessage {
  orgId: string;
  channelId: string;
  threadId?: string | null;
  author: MessageAuthor;
  body: string;
  meta?: Record<string, unknown>;
}

/**
 * Writes a message and its `message.posted` outbox event (mentions or router)
 * in the caller's transaction. Mentions resolve to active agents that are members of the
 * channel; an agent never mentions itself. No permission checks: callers
 * (`postPersonMessage`, the run executor) do them.
 */
export async function insertMessage(tx: Executor, input: NewMessage): Promise<Message> {
  return (await insertMessageWithRuns(tx, input, { startRuns: false })).message;
}

interface RawMessage {
  id: string;
  created_at: Date | string;
  org_id: string;
  channel_id: string;
  thread_id: string | null;
  author_type: Message["authorType"];
  author_user_id: string | null;
  author_agent_id: string | null;
  body: string;
  mentioned_agent_ids: string[] | string | null;
  hop: number;
  agent_run_id: string | null;
  meta: Record<string, unknown> | string | null;
  edited_at: Date | string | null;
  deleted_at: Date | string | null;
  runs: { id: string; agentId: string }[] | string | null;
}

const asDate = (v: Date | string | null) => (v === null ? null : v instanceof Date ? v : new Date(v));
const parseUuidArray = (v: string[] | string | null) =>
  Array.isArray(v) ? v : v ? v.replace(/^{|}$/g, "").split(",").filter(Boolean) : [];
const parseJson = <T>(v: T | string | null, fallback: T): T =>
  typeof v === "string" ? (JSON.parse(v) as T) : (v ?? fallback);

/**
 * Writes a message in ONE statement (the database may be far away): thread
 * check, mention resolution (active agents that are members of the
 * channel; an agent never mentions itself), the message, its outbox rows
 * (`search.index`, `message.posted`), and, with `startRuns` for a person's
 * message, the runs of the agents that will surely answer (mentioned ones,
 * or the agent of a DM) with their `agent_run.execute` jobs. Atomic like a
 * transaction. No permission checks: callers do them.
 */
export async function insertMessageWithRuns(
  tx: Executor,
  input: NewMessage,
  options: { startRuns: boolean },
): Promise<{ message: Message; runs: { id: string; agentId: string }[] }> {
  const body = input.body.trim();
  if (body === "") throw new ValidationError("Message is empty");
  if (body.length > MAX_MESSAGE_LENGTH)
    throw new ValidationError(`Message is longer than ${MAX_MESSAGE_LENGTH} characters`);
  const handles = `{${parseMentionHandles(body).join(",")}}`; // handles match [a-z0-9_-]: safe as an array literal
  const id = Bun.randomUUIDv7();
  const person = input.author.type === "person";
  const userId = input.author.type === "person" ? input.author.userId : null;
  const agentId = input.author.type === "agent" ? input.author.agentId : null;
  const runId = input.author.type === "agent" ? input.author.runId : null;
  const hop = input.author.type === "agent" ? input.author.hop : 0;
  const threadId = input.threadId ?? null;
  const startRuns = options.startRuns && person;
  const rows = rowsOf<RawMessage>(
    await tx.execute(sql`with mentioned as (
        select a.id from ${agents} a
        join ${channelMembers} cm on cm.agent_id = a.id and cm.channel_id = ${input.channelId}::uuid
        where a.org_id = ${input.orgId}::uuid and a.archived_at is null
          and a.handle = any(${handles}::text[])
          and a.id is distinct from ${agentId}::uuid
      ), answered as (
        -- A person's reply where an agent asked something (same channel and thread) answers it.
        update ${agentQuestions} q set status = 'answered', answer = ${body}, answered_by_user_id = ${userId},
          answered_at = now()
        where ${person}::boolean and q.status = 'open' and q.id = (
            select oq.id from ${agentQuestions} oq
            where oq.org_id = ${input.orgId}::uuid and oq.channel_id = ${input.channelId}::uuid
              and oq.status = 'open' and oq.expires_at > now()
              and oq.thread_id is not distinct from ${threadId}::uuid
            order by oq.created_at desc limit 1)
          and (not exists (select 1 from mentioned) or q.agent_id in (select id from mentioned))
          and (${threadId}::uuid is null or exists (
            select 1 from ${messages} r where r.id = ${threadId}::uuid and r.org_id = ${input.orgId}::uuid
              and r.channel_id = ${input.channelId}::uuid and r.thread_id is null))
        returning q.id, q.run_id, q.agent_id
      ), m as (
        insert into ${messages} (id, created_at, org_id, channel_id, thread_id, author_type, author_user_id,
          author_agent_id, agent_run_id, hop, body, mentioned_agent_ids, meta)
        select ${id}::uuid, now(), ${input.orgId}::uuid, ${input.channelId}::uuid, ${threadId}::uuid,
          ${input.author.type}::author_type, ${userId}, ${agentId}::uuid, ${runId}::uuid, ${hop}, ${body},
          coalesce((select array_agg(id) from mentioned), '{}'::uuid[]),
          ${JSON.stringify(input.meta ?? {})}::jsonb
            || coalesce((select jsonb_build_object('answersQuestionId', id) from answered), '{}'::jsonb)
        where ${threadId}::uuid is null or exists (
          select 1 from ${messages} r where r.id = ${threadId}::uuid and r.org_id = ${input.orgId}::uuid
            and r.channel_id = ${input.channelId}::uuid and r.thread_id is null)
        returning *
      ), answering as (
        select a.id as agent_id, case when exists (select 1 from mentioned) then 'mention' else 'dm' end as trig
        from ${agents} a
        join ${channelMembers} cm on cm.agent_id = a.id and cm.channel_id = ${input.channelId}::uuid
        where ${startRuns}::boolean and a.org_id = ${input.orgId}::uuid and a.archived_at is null
          and a.id not in (select agent_id from answered)
          and (a.id in (select id from mentioned)
            or (not exists (select 1 from mentioned) and not exists (select 1 from answered) and exists (
              select 1 from ${channels} c where c.id = ${input.channelId}::uuid and c.kind = 'dm')))
      ), runs as (
        insert into ${agentRuns} (id, org_id, agent_id, channel_id, thread_root_id, trigger_message_id, trigger, hop)
        select gen_random_uuid(), ${input.orgId}::uuid, an.agent_id, ${input.channelId}::uuid,
          coalesce(${threadId}::uuid, ${id}::uuid), ${id}::uuid, an.trig::agent_run_trigger, ${hop} + 1
        from answering an where exists (select 1 from m)
        on conflict do nothing
        returning id, agent_id
      ), jobs as (
        insert into ${outbox} (id, org_id, kind, payload, dedupe_key, max_attempts)
        select gen_random_uuid(), ${input.orgId}::uuid, 'agent_run.execute', jsonb_build_object('runId', r.id),
          'agent_run.execute:' || r.id, 4 from runs r
        union all
        select gen_random_uuid(), ${input.orgId}::uuid, 'agent_run.execute', jsonb_build_object('runId', a.run_id),
          'agent_run.execute:' || a.run_id || ':question:' || a.id, 4 from answered a
        union all
        select gen_random_uuid(), ${input.orgId}::uuid, 'search.index',
          jsonb_build_object('kind', 'message', 'sourceId', m.id), 'search.index:message:' || m.id, 8 from m
        union all
        select gen_random_uuid(), ${input.orgId}::uuid, 'message.posted', jsonb_build_object('messageId', m.id),
          'message.posted:' || m.id, 8 from m
          where m.author_type = 'person' or cardinality(m.mentioned_agent_ids) > 0
        on conflict do nothing
        returning id
      )
      select m.*,
        coalesce((select json_agg(json_build_object('id', r.id, 'agentId', r.agent_id)) from runs r), '[]'::json) as runs,
        (select count(*) from jobs)::int as jobs
      from m`),
  );
  const row = rows[0];
  if (!row) throw new ValidationError("threadId must be a top-level message of this channel");
  const message: Message = {
    id: row.id,
    createdAt: asDate(row.created_at) as Date,
    orgId: row.org_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    authorType: row.author_type,
    authorUserId: row.author_user_id,
    authorAgentId: row.author_agent_id,
    body: row.body,
    mentionedAgentIds: parseUuidArray(row.mentioned_agent_ids),
    hop: row.hop,
    agentRunId: row.agent_run_id,
    meta: parseJson(row.meta, {}),
    editedAt: asDate(row.edited_at),
    deletedAt: asDate(row.deleted_at),
  };
  return { message, runs: parseJson(row.runs, []) };
}

/**
 * A person posts in a channel: org membership, channel membership and the
 * `post` permission are checked, then message + outbox event commit together,
 * then the message is published to real-time subscribers.
 */
export async function postPersonMessage(
  deps: { db: Database; pubsub: PubSub },
  userId: string,
  orgId: string,
  channelId: string,
  input: { body: string; threadId?: string | null; clientId?: string | null },
): Promise<MessageView> {
  // One access check (membership + channel) instead of two round trips.
  const { channel, membership } = await requireChannelAccess(deps.db, userId, orgId, channelId);
  if (!can(membership.role, "post")) throw new ForbiddenError();
  const clientId = input.clientId?.trim().slice(0, 64) || null;
  // One statement: the message, its jobs, and the runs of agents that will surely answer.
  const { message, runs } = await insertMessageWithRuns(
    deps.db,
    {
      orgId,
      channelId,
      threadId: input.threadId,
      author: { type: "person", userId },
      body: input.body,
      meta: clientId ? { clientId } : undefined,
    },
    { startRuns: true },
  );
  const view = messageView(message);
  // Right after the commit, before any routing: the sender's optimistic copy reconciles by `clientId`.
  await publishMessageCreated(deps.pubsub, view);
  const answers = message.meta.answersQuestionId;
  if (typeof answers === "string") await afterReplyAnswered(deps, orgId, answers);
  if (runs.length > 0) {
    // DMs are flat: replies to a top-level DM message go in the main timeline.
    const threadId = message.threadId ?? (channel.kind === "dm" ? null : message.id);
    await publishChannelEvent(deps.pubsub, {
      type: "message.routed",
      channelId,
      messageId: message.id,
      seenBy: message.mentionedAgentIds.length > 0 ? message.mentionedAgentIds : runs.map((r) => r.agentId),
      pickedBy: runs.map((r) => r.agentId),
      strategy: channel.kind === "dm" && message.mentionedAgentIds.length === 0 ? "dm" : "mention",
    });
    for (const run of runs) {
      await publishChannelEvent(deps.pubsub, {
        type: "agent.thinking",
        channelId,
        threadId,
        agentId: run.agentId,
        runId: run.id,
      });
    }
  }
  return view;
}

export async function getMessage(db: Executor, orgId: string, messageId: string): Promise<Message | null> {
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.orgId, orgId)));
  return row ?? null;
}

/**
 * Lists messages the user may read. Without `threadId`: top-level channel
 * messages, newest page first (returned oldest → newest). With `threadId`:
 * the thread root and its replies.
 */
export async function listMessages(
  db: Database,
  userId: string,
  orgId: string,
  channelId: string,
  options: { threadId?: string; before?: Date; limit?: number } = {},
): Promise<MessageView[]> {
  await requireChannelAccess(db, userId, orgId, channelId);
  const limit = Math.min(options.limit ?? 50, 200);
  const scope = and(eq(messages.orgId, orgId), eq(messages.channelId, channelId), isNull(messages.deletedAt));
  if (options.threadId) {
    const root = await getMessage(db, orgId, options.threadId);
    if (!root || root.channelId !== channelId) throw new NotFoundError("Thread not found");
    const replies = await db
      .select()
      .from(messages)
      .where(and(scope, eq(messages.threadId, options.threadId)))
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .limit(limit);
    return withReceipts(db, orgId, [root, ...replies]);
  }
  const rows = await db
    .select()
    .from(messages)
    .where(and(scope, isNull(messages.threadId), options.before ? lt(messages.createdAt, options.before) : undefined))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit);
  return withReceipts(db, orgId, rows.reverse());
}

async function withReceipts(db: Database, orgId: string, list: Message[]): Promise<MessageView[]> {
  const receipts = await receiptsFor(
    db,
    orgId,
    list.filter((m) => m.authorType === "person"),
  );
  return list.map((m) => ({ ...messageView(m), ...(receipts.has(m.id) ? { receipts: receipts.get(m.id) } : {}) }));
}
