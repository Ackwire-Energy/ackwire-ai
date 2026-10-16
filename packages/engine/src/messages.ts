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
  or,
  rowsOf,
  schema,
  sql,
} from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { withDeletedArtifacts } from "./artifacts";
import { audienceSql, notifyBlocked } from "./audience";
import { cancelRun } from "./cancel";
import { requireChannelAccess } from "./channels";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishMessageCreated, publishUserEvent } from "./events";
import { isStopRequest, type Judge } from "./judge";
import { can } from "./organizations";
import { afterReplyAnswered } from "./questions";
import { syncWikiLinks, withWikiLinks } from "./wiki-links";

const { messages, agents, channelMembers, channels, agentRuns, outbox, agentQuestions, threads } = schema;

export type Message = typeof messages.$inferSelect;

export const MAX_MESSAGE_LENGTH = 40_000;

export interface MessageView {
  id: string;
  channelId: string;
  threadId: string | null;
  author: { type: "person" | "agent"; id: string | null };
  body: string;
  mentionedAgentIds: string[];
  /** People mentioned by handle (`@ana`) who are in the channel. */
  mentionedUserIds: string[];
  agentRunId: string | null;
  /** Structured attachments: `{ approvalId }`, `{ memoryUpdates }`, `{ clientId }`. */
  meta: Record<string, unknown>;
  /** The sender's own id for the optimistic copy (echoed back). */
  clientId: string | null;
  /** Which agents saw it and which answered (in message lists; no router scores). */
  receipts?: Receipts;
  /** Agent messages in lists: model, tokens and cost of the run that wrote it. */
  usage?: MessageUsage;
  /** Only in the sender's own POST response: agents that won't answer them, and why (never stored). */
  notices?: { agentId: string; text: string; code?: string; params?: Record<string, unknown> }[];
  /** Top-level messages with `include=replies`: thread summary and the latest replies. */
  replies?: { count: number; lastAt: string | null; latest: MessageView[] };
  /** In message lists: reactions (`+1`/`-1` or an emoji) and who reacted. */
  reactions?: ReactionCount[];
  createdAt: string;
}

export interface ReactionCount {
  reaction: string;
  count: number;
  userIds: string[];
}

/** `meta.replyTo` of a quote reply: the message it answers, as it was when quoted. */
export interface ReplyRef {
  messageId: string;
  /** The quoted message's thread (null = main timeline). */
  threadId: string | null;
  author: { type: "person" | "agent"; id: string | null };
  authorName: string;
  excerpt: string;
}

export const REPLY_EXCERPT_LENGTH = 200;

/** One line of a message for a quote: whitespace collapsed, code fences dropped, ~200 chars. */
export function replyExcerpt(body: string, max = REPLY_EXCERPT_LENGTH): string {
  const line = body
    .replace(/```[\w+-]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Files a person may attach to one message. */
export const MAX_MESSAGE_ATTACHMENTS = 10;

/** Model and tokens of the run that wrote an agent message (no money: everyone in the channel sees it). */
export interface MessageUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export const messageView = (m: Message): MessageView => ({
  id: m.id,
  channelId: m.channelId,
  threadId: m.threadId,
  author: { type: m.authorType, id: m.authorType === "person" ? m.authorUserId : m.authorAgentId },
  body: m.body,
  mentionedAgentIds: m.mentionedAgentIds,
  mentionedUserIds: m.mentionedUserIds,
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
    status: "queued" | "running" | "waiting_approval" | "waiting_input" | "done" | "failed" | "canceled";
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
  | { type: "agent"; agentId: string; runId: string | null; hop: number };

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
  mentioned_user_ids: string[] | string | null;
  hop: number;
  agent_run_id: string | null;
  meta: Record<string, unknown> | string | null;
  edited_at: Date | string | null;
  deleted_at: Date | string | null;
  runs: { id: string; agentId: string }[] | string | null;
  /** Agents the sender addressed but can't talk to (D31). */
  blocked?: string[] | string | null;
  /** Active runs this message was delivered to (no new run). */
  steered?: { id: string; agentId: string }[] | string | null;
  /** The reply reopened a closed thread. */
  reopened?: boolean | null;
}

async function isThreadArchived(db: Executor, orgId: string, rootId: string) {
  const [row] = await db
    .select({ state: threads.state })
    .from(threads)
    .where(and(eq(threads.orgId, orgId), eq(threads.rootMessageId, rootId)));
  return row?.state === "archived";
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
): Promise<{
  message: Message;
  runs: { id: string; agentId: string }[];
  blocked: string[];
  /** Runs already active in this conversation that will read the message at their next step. */
  steered: { id: string; agentId: string }[];
  /** A person's reply reopened a closed thread. */
  reopened: boolean;
}> {
  const body = input.body.trim();
  // Files alone are a message (`meta.artifacts`): the text may be empty then.
  const attached = input.meta?.artifacts;
  const files = Array.isArray(attached) && attached.length > 0;
  if (body === "" && !files) throw new ValidationError("Message is empty");
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
    await tx.execute(sql`with archived as (
        -- An archived thread is read only for people (ADR 0029); an agent's run already going still lands.
        select 1 from ${threads} th
        where ${person}::boolean and ${threadId}::uuid is not null and th.org_id = ${input.orgId}::uuid
          and th.root_message_id = ${threadId}::uuid and th.state = 'archived'
      ), muted as (
        -- A mission's thread (ADR 0029): only its owner and those who can decide make its agent act.
        -- Anyone else addressing it starts nothing: the message becomes a suggestion.
        select mi.id as mission_id, mi.agent_id from ${schema.missions} mi
        where ${person}::boolean and ${threadId}::uuid is not null and mi.org_id = ${input.orgId}::uuid
          and mi.thread_root_id = ${threadId}::uuid and mi.status in ('proposed', 'active', 'paused')
          and mi.owner_id is distinct from ${userId}
          and not exists (select 1 from ${schema.missionParticipants} mp
            where mp.mission_id = mi.id and mp.user_id = ${userId} and mp.role = 'decide')
      ), mentioned as (
        select a.id from ${agents} a
        join ${channelMembers} cm on cm.agent_id = a.id and cm.channel_id = ${input.channelId}::uuid
        where a.org_id = ${input.orgId}::uuid and a.archived_at is null
          and a.handle = any(${handles}::text[])
          and a.id is distinct from ${agentId}::uuid
      ), mentioned_people as (
        select om.user_id from ${schema.organizationMembers} om
        join ${channelMembers} pcm on pcm.user_id = om.user_id and pcm.channel_id = ${input.channelId}::uuid
        where om.org_id = ${input.orgId}::uuid and om.handle = any(${handles}::text[])
          and om.user_id is distinct from ${userId}
      ), answered as (
        -- A person's reply where an agent asked something (same channel and thread) answers it.
        update ${agentQuestions} q set status = 'answered', answer = ${body}, answered_by_user_id = ${userId},
          answered_at = now()
        where ${person}::boolean and q.status = 'open' and not exists (select 1 from archived) and q.id = (
            select oq.id from ${agentQuestions} oq
            where oq.org_id = ${input.orgId}::uuid and oq.channel_id = ${input.channelId}::uuid
              and oq.status = 'open' and oq.expires_at > now()
              and oq.thread_id is not distinct from ${threadId}::uuid
            order by oq.created_at desc limit 1)
          and (not exists (select 1 from mentioned) or q.agent_id in (select id from mentioned))
          and q.agent_id not in (select agent_id from muted)
          and exists (select 1 from ${agents} qa where qa.id = q.agent_id and ${audienceSql("qa", sql`${userId}::text`)})
          and (${threadId}::uuid is null or exists (
            select 1 from ${messages} r where r.id = ${threadId}::uuid and r.org_id = ${input.orgId}::uuid
              and r.channel_id = ${input.channelId}::uuid and r.thread_id is null))
        returning q.id, q.run_id, q.agent_id
      ), addressed as (
        select a.id as agent_id, case when exists (select 1 from mentioned) then 'mention' else 'dm' end as trig,
          ${audienceSql("a", sql`${userId}::text`)} as allowed
        from ${agents} a
        join ${channelMembers} cm on cm.agent_id = a.id and cm.channel_id = ${input.channelId}::uuid
        where ${startRuns}::boolean and a.org_id = ${input.orgId}::uuid and a.archived_at is null
          and a.id not in (select agent_id from answered)
          and (a.id in (select id from mentioned)
            or (not exists (select 1 from mentioned) and not exists (select 1 from answered) and exists (
              select 1 from ${channels} c where c.id = ${input.channelId}::uuid and c.kind = 'dm')))
      ), answering as (
        -- Who can talk to the agent (D31): the others get no run, only a notice for the sender.
        select agent_id, trig from addressed where allowed and agent_id not in (select agent_id from muted)
      ), active as (
        -- One active run per agent and conversation: a new message goes to it instead of a second run.
        -- Addressed agents (mention, DM) with a run in this conversation, and, for a reply in a
        -- thread, any agent working in that thread (no mention needed to talk to it there).
        select distinct on (r.agent_id) r.id, r.agent_id from ${agentRuns} r
        join ${agents} ra on ra.id = r.agent_id
        where ${person}::boolean and r.org_id = ${input.orgId}::uuid and r.channel_id = ${input.channelId}::uuid
          and r.status in ('queued', 'running', 'waiting_approval', 'waiting_input')
          and r.agent_id not in (select agent_id from answered)
          and r.agent_id not in (select agent_id from muted)
          and (
            (r.agent_id in (select agent_id from answering)
              and (r.thread_root_id = coalesce(${threadId}::uuid, ${id}::uuid) or exists (
                select 1 from ${channels} c where c.id = ${input.channelId}::uuid and c.kind = 'dm')))
            or (${threadId}::uuid is not null and r.thread_root_id = ${threadId}::uuid
              and ${audienceSql("ra", sql`${userId}::text`)})
          )
        order by r.agent_id, r.created_at desc
      ), m as (
        insert into ${messages} (id, created_at, org_id, channel_id, thread_id, author_type, author_user_id,
          author_agent_id, agent_run_id, hop, body, mentioned_agent_ids, mentioned_user_ids, meta)
        select ${id}::uuid, now(), ${input.orgId}::uuid, ${input.channelId}::uuid, ${threadId}::uuid,
          ${input.author.type}::author_type, ${userId}, ${agentId}::uuid, ${runId}::uuid, ${hop}, ${body},
          coalesce((select array_agg(id) from mentioned), '{}'::uuid[]),
          coalesce((select array_agg(user_id) from mentioned_people), '{}'::text[]),
          ${JSON.stringify(input.meta ?? {})}::jsonb
            || coalesce((select jsonb_build_object('answersQuestionId', id) from answered), '{}'::jsonb)
            -- Delivered to a task in progress: nobody routes it again (no second run).
            || coalesce((select jsonb_build_object('steeredRunIds', jsonb_agg(ac.id)) from active ac
                having count(*) > 0), '{}'::jsonb)
            -- Addressed the mission's agent without the right to: a suggestion the owner decides.
            || coalesce((select jsonb_build_object('missionSuggestion',
                  jsonb_build_object('status', 'pending', 'missionId', mu.mission_id))
                from muted mu where mu.agent_id in (select agent_id from addressed) limit 1), '{}'::jsonb)
        where (${threadId}::uuid is null or exists (
          select 1 from ${messages} r where r.id = ${threadId}::uuid and r.org_id = ${input.orgId}::uuid
            and r.channel_id = ${input.channelId}::uuid and r.thread_id is null))
          -- An archived thread is read only for people (ADR 0029); an agent's run already going still lands.
          and not exists (select 1 from archived)
        returning *
      ), reopened as (
        -- A person replying in a closed thread reopens it (one indexed update; no row = nothing to do).
        update ${threads} t set state = 'open', closed_by = null, closed_at = null, updated_at = now()
        where ${person}::boolean and ${threadId}::uuid is not null and t.org_id = ${input.orgId}::uuid
          and t.root_message_id = ${threadId}::uuid and t.state = 'closed' and exists (select 1 from m)
        returning t.id
      ), steered as (
        update ${agentRuns} r set pending_message_ids = array_append(r.pending_message_ids, ${id}::uuid),
          updated_at = now()
        from active a where r.id = a.id and exists (select 1 from m)
        returning r.id, r.agent_id
      ), runs as (
        insert into ${agentRuns} (id, org_id, agent_id, channel_id, thread_root_id, trigger_message_id, trigger, hop)
        select gen_random_uuid(), ${input.orgId}::uuid, an.agent_id, ${input.channelId}::uuid,
          coalesce(${threadId}::uuid, ${id}::uuid), ${id}::uuid, an.trig::agent_run_trigger, ${hop} + 1
        from answering an where exists (select 1 from m)
          and an.agent_id not in (select agent_id from active)
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
        coalesce((select json_agg(ad.agent_id) from addressed ad where not ad.allowed), '[]'::json) as blocked,
        coalesce((select json_agg(json_build_object('id', s.id, 'agentId', s.agent_id)) from steered s), '[]'::json)
          as steered,
        (select count(*) from jobs)::int as jobs,
        exists (select 1 from reopened) as reopened
      from m`),
  );
  const row = rows[0];
  if (!row) {
    // Only on the failure path: tell an archived thread from a wrong thread id.
    if (threadId && person && (await isThreadArchived(tx, input.orgId, threadId))) {
      throw new ConflictError("This thread is archived: unarchive it to reply", "thread.archived");
    }
    throw new ValidationError("threadId must be a top-level message of this channel");
  }
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
    mentionedUserIds: parseUuidArray(row.mentioned_user_ids),
    hop: row.hop,
    agentRunId: row.agent_run_id,
    meta: parseJson(row.meta, {}),
    editedAt: asDate(row.edited_at),
    deletedAt: asDate(row.deleted_at),
  };
  // `[[…]]` links become backlinks of the pages they name (D34).
  if (body.includes("[[")) {
    await syncWikiLinks(tx, input.orgId, { type: "message", id: message.id, channelId: input.channelId }, body);
  }
  return {
    message,
    runs: parseJson(row.runs, []),
    blocked: parseJson(row.blocked ?? null, [] as string[]),
    steered: parseJson(row.steered ?? null, [] as { id: string; agentId: string }[]),
    reopened: row.reopened === true || (row.reopened as unknown) === "t",
  };
}

/**
 * A person posts in a channel: org membership, channel membership and the
 * `post` permission are checked, then message + outbox event commit together,
 * then the message is published to real-time subscribers.
 */
export async function postPersonMessage(
  /** `judge`: tells a plain "stop" from a correction while an agent works (none = never a stop). */
  deps: { db: Database; pubsub: PubSub; judge?: Judge },
  userId: string,
  orgId: string,
  channelId: string,
  input: {
    body: string;
    threadId?: string | null;
    clientId?: string | null;
    /** Server-side attachments (e.g. `{ issueId }` when asking an agent to implement an issue). */
    meta?: Record<string, unknown>;
    /** Quote reply: the message this one answers (same channel). Stored as `meta.replyTo`. */
    replyTo?: string | null;
    /** Files (artifact ids) uploaded for this message, or files of this channel. Stored as `meta.artifacts`. */
    attachments?: string[];
  },
): Promise<MessageView> {
  // One access check (membership + channel) instead of two round trips.
  const { channel, membership } = await requireChannelAccess(deps.db, userId, orgId, channelId);
  if (!can(membership.role, "post")) throw new ForbiddenError();
  // A forum topic is written through the forum (its turns), never as a plain chat (D33).
  if (channel.kind === "forum")
    throw new ValidationError("Post in the forum from the topic's page", "forum.post_from_topic");
  const clientId = input.clientId?.trim().slice(0, 64) || null;
  // Quote and files: checked and resolved here, so the run's context reads them from the meta (no query there).
  const [replyTo, files] = await Promise.all([
    input.replyTo ? replyRefFor(deps.db, orgId, channelId, input.replyTo) : null,
    input.attachments?.length ? attachmentRefsFor(deps.db, userId, orgId, channelId, input.attachments) : null,
  ]);
  const meta =
    replyTo || files
      ? { ...(input.meta ?? {}), ...(replyTo ? { replyTo } : {}), ...(files ? { artifacts: files } : {}) }
      : input.meta;
  // One statement: the message, its jobs, and the runs of agents that will surely answer.
  const { message, runs, blocked, steered, reopened } = await insertMessageWithRuns(
    deps.db,
    {
      orgId,
      channelId,
      threadId: input.threadId,
      author: { type: "person", userId },
      body: input.body,
      meta: clientId || meta ? { ...(meta ?? {}), ...(clientId ? { clientId } : {}) } : undefined,
    },
    { startRuns: true },
  );
  const [view] = (await withWikiLinks(deps.db, orgId, [messageView(message)])) as [MessageView];
  // Right after the commit, before any routing: the sender's optimistic copy reconciles by `clientId`.
  await publishMessageCreated(deps.pubsub, view);
  // People mentioned by handle hear about it on their own topic (notifications).
  for (const mentioned of message.mentionedUserIds) {
    await publishUserEvent(deps.pubsub, orgId, mentioned, {
      type: "mention",
      channelId,
      messageId: message.id,
      threadId: message.threadId,
      byUserId: userId,
    });
  }
  if (reopened && message.threadId) {
    await publishChannelEvent(deps.pubsub, {
      type: "thread.updated",
      channelId,
      threadId: message.threadId,
      change: "reopened",
      state: "open",
    });
  }
  const answers = message.meta.answersQuestionId;
  if (typeof answers === "string") await afterReplyAnswered(deps, orgId, answers);
  // Agents this person can't talk to (D31): no run; only they hear why ("Theo only replies to …").
  if (blocked.length > 0) {
    view.notices = await notifyBlocked(deps, orgId, userId, {
      agentIds: blocked,
      channelId,
      threadId: message.threadId,
      messageId: message.id,
    });
  }
  if (steered.length > 0) {
    // Delivered to the agent's task in progress (it reads it at its next step); a plain "stop",
    // in any language, cancels it instead (the judge decides; short messages only).
    for (const s of steered) {
      const agentName = (await getAgentCached(deps.db, orgId, s.agentId))?.name ?? "the agent";
      const stop = deps.judge
        ? await isStopRequest(deps.judge, { orgId, text: message.body, agentName }).catch(() => false)
        : false;
      const [active] = await deps.db.select().from(agentRuns).where(eq(agentRuns.id, s.id));
      const threadId =
        active && !(channel.kind === "dm" && active.threadRootId === active.triggerMessageId)
          ? active.threadRootId
          : null;
      await publishChannelEvent(deps.pubsub, {
        type: "agent.run.steered",
        channelId,
        threadId,
        runId: s.id,
        agentId: s.agentId,
        messageId: message.id,
        ...(stop ? { stop: true } : {}),
      });
      if (stop) await cancelRun(deps, userId, orgId, s.id).catch(() => undefined);
    }
  }
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

/** The quoted message (one statement, with its author's name): it must be a live message of this channel. */
async function replyRefFor(db: Database, orgId: string, channelId: string, messageId: string): Promise<ReplyRef> {
  const [row] = await db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      threadId: messages.threadId,
      authorType: messages.authorType,
      authorUserId: messages.authorUserId,
      authorAgentId: messages.authorAgentId,
      body: messages.body,
      deletedAt: messages.deletedAt,
      userName: schema.users.name,
      agentName: agents.name,
    })
    .from(messages)
    .leftJoin(schema.users, eq(schema.users.id, messages.authorUserId))
    .leftJoin(agents, eq(agents.id, messages.authorAgentId))
    .where(and(eq(messages.id, messageId), eq(messages.orgId, orgId)));
  if (!row || row.deletedAt || row.channelId !== channelId) {
    throw new ValidationError("replyTo must be a message of this channel", "message.reply_not_found");
  }
  const person = row.authorType === "person";
  return {
    messageId: row.id,
    threadId: row.threadId,
    author: { type: row.authorType, id: person ? row.authorUserId : row.authorAgentId },
    authorName: (person ? row.userName : row.agentName) ?? "",
    excerpt: replyExcerpt(row.body),
  };
}

/** Files for a message: the person's own uploads or files of this channel, not deleted. */
async function attachmentRefsFor(db: Database, userId: string, orgId: string, channelId: string, ids: string[]) {
  const wanted = [...new Set(ids)];
  if (wanted.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new ValidationError(`At most ${MAX_MESSAGE_ATTACHMENTS} files per message`, "message.too_many_attachments", {
      max: MAX_MESSAGE_ATTACHMENTS,
    });
  }
  const a = schema.artifacts;
  const rows = await db
    .select({ id: a.id, title: a.title, version: a.currentVersion })
    .from(a)
    .where(
      and(
        eq(a.orgId, orgId),
        inArray(a.id, wanted),
        isNull(a.deletedAt),
        or(eq(a.channelId, channelId), and(eq(a.createdByType, "person"), eq(a.createdById, userId))),
      ),
    );
  if (rows.length !== wanted.length) {
    throw new ValidationError("Attach files you uploaded or files of this channel", "message.attachment_not_found");
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  return wanted.map((id) => {
    const r = byId.get(id) as (typeof rows)[number];
    return { id: r.id, version: r.version, title: r.title };
  });
}

/** Reactions on these messages, grouped like `listReactions`. */
async function reactionsFor(db: Database, orgId: string, ids: string[]): Promise<Map<string, ReactionCount[]>> {
  const out = new Map<string, ReactionCount[]>();
  if (ids.length === 0) return out;
  const r = schema.messageReactions;
  const rows = await db
    .select({ messageId: r.messageId, reaction: r.reaction, userId: r.userId })
    .from(r)
    .where(and(eq(r.orgId, orgId), inArray(r.messageId, ids)))
    .orderBy(asc(r.createdAt));
  for (const row of rows) {
    const list = out.get(row.messageId) ?? [];
    const found = list.find((x) => x.reaction === row.reaction);
    if (found) {
      found.count += 1;
      found.userIds.push(row.userId);
    } else list.push({ reaction: row.reaction, count: 1, userIds: [row.userId] });
    out.set(row.messageId, list);
  }
  return out;
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
  options: { threadId?: string; before?: Date; limit?: number; includeReplies?: boolean } = {},
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
  const views = await withReceipts(db, orgId, rows.reverse());
  return options.includeReplies ? withReplies(db, orgId, views) : views;
}

/** How many replies each thread has, when the last came, and the last three (with usage). */
async function withReplies(db: Database, orgId: string, roots: MessageView[]): Promise<MessageView[]> {
  const ids = roots.map((r) => r.id);
  if (ids.length === 0) return roots;
  const counts = await db
    .select({
      threadId: messages.threadId,
      n: sql<number>`count(*)::int`,
      last: sql<string>`max(${messages.createdAt})`,
    })
    .from(messages)
    .where(and(eq(messages.orgId, orgId), inArray(messages.threadId, ids), isNull(messages.deletedAt)))
    .groupBy(messages.threadId);
  const recent = await db
    .select()
    .from(messages)
    .where(and(eq(messages.orgId, orgId), inArray(messages.threadId, ids), isNull(messages.deletedAt)))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(Math.min(600, ids.length * 20));
  const latestByThread = new Map<string, Message[]>();
  for (const m of recent) {
    const list = latestByThread.get(m.threadId ?? "") ?? [];
    if (list.length < 3) list.push(m);
    latestByThread.set(m.threadId ?? "", list);
  }
  const latestViews = await withReceipts(db, orgId, [...latestByThread.values()].flat());
  const viewById = new Map(latestViews.map((v) => [v.id, v]));
  const countBy = new Map(counts.map((c) => [c.threadId ?? "", c]));
  return roots.map((r) => {
    const c = countBy.get(r.id);
    const latest = (latestByThread.get(r.id) ?? [])
      .reverse()
      .flatMap((m) => (viewById.has(m.id) ? [viewById.get(m.id) as MessageView] : []));
    return {
      ...r,
      replies: { count: c?.n ?? 0, lastAt: c?.last ? new Date(c.last).toISOString() : null, latest },
    };
  });
}

/** Tokens of the runs that wrote these agent messages. */
async function usageFor(db: Database, orgId: string, list: Message[]) {
  const runIds = [...new Set(list.flatMap((m) => (m.authorType === "agent" && m.agentRunId ? [m.agentRunId] : [])))];
  const out = new Map<string, MessageUsage>();
  if (runIds.length === 0) return out;
  const u = schema.usageRecords;
  const rows = await db
    .select({
      runId: u.runId,
      model: sql<string>`max(${u.model})`,
      input: sql<number>`coalesce(sum(${u.inputTokens} + ${u.cacheReadTokens} + ${u.cacheWriteTokens}), 0)::int`,
      output: sql<number>`coalesce(sum(${u.outputTokens}), 0)::int`,
    })
    .from(u)
    .where(and(eq(u.orgId, orgId), inArray(u.runId, runIds), eq(u.kind, "agent")))
    .groupBy(u.runId);
  for (const r of rows) {
    if (!r.runId) continue;
    out.set(r.runId, {
      model: r.model,
      inputTokens: Number(r.input),
      outputTokens: Number(r.output),
    });
  }
  return out;
}

async function withReceipts(db: Database, orgId: string, list: Message[]): Promise<MessageView[]> {
  const [receipts, usage, reactions] = await Promise.all([
    receiptsFor(
      db,
      orgId,
      list.filter((m) => m.authorType === "person"),
    ),
    usageFor(db, orgId, list),
    reactionsFor(
      db,
      orgId,
      list.map((m) => m.id),
    ),
  ]);
  const views = list.map((m) => {
    const runUsage = m.agentRunId ? usage.get(m.agentRunId) : undefined;
    const reacted = reactions.get(m.id);
    return {
      ...messageView(m),
      ...(receipts.has(m.id) ? { receipts: receipts.get(m.id) } : {}),
      ...(runUsage ? { usage: runUsage } : {}),
      ...(reacted ? { reactions: reacted } : {}),
    };
  });
  return withDeletedArtifacts(db, orgId, await withWikiLinks(db, orgId, views));
}
