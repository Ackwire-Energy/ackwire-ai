import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, desc, type Executor, eq, inArray, isNull, lt, schema } from "@agenteschat/db";
import { requireChannelAccess } from "./channels";
import { dmAgents } from "./dms";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishMessageCreated } from "./events";
import { can } from "./organizations";
import { enqueue } from "./outbox";

const { messages, agents, channelMembers } = schema;

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
  handled: { agentId: string; status: "queued" | "running" | "waiting_approval" | "done" | "failed" }[];
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
  const body = input.body.trim();
  if (body === "") throw new ValidationError("Message is empty");
  if (body.length > MAX_MESSAGE_LENGTH)
    throw new ValidationError(`Message is longer than ${MAX_MESSAGE_LENGTH} characters`);

  if (input.threadId) {
    const [root] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.id, input.threadId),
          eq(messages.orgId, input.orgId),
          eq(messages.channelId, input.channelId),
          isNull(messages.threadId),
        ),
      );
    if (!root) throw new ValidationError("threadId must be a top-level message of this channel");
  }

  const handles = parseMentionHandles(body);
  const mentioned =
    handles.length === 0
      ? []
      : await tx
          .select({ id: agents.id })
          .from(agents)
          .innerJoin(
            channelMembers,
            and(eq(channelMembers.agentId, agents.id), eq(channelMembers.channelId, input.channelId)),
          )
          .where(and(eq(agents.orgId, input.orgId), inArray(agents.handle, handles), isNull(agents.archivedAt)));
  const self = input.author.type === "agent" ? input.author.agentId : null;
  const mentionedAgentIds = mentioned.map((a) => a.id).filter((id) => id !== self);

  const [message] = await tx
    .insert(messages)
    .values({
      orgId: input.orgId,
      channelId: input.channelId,
      threadId: input.threadId ?? null,
      authorType: input.author.type,
      authorUserId: input.author.type === "person" ? input.author.userId : null,
      authorAgentId: input.author.type === "agent" ? input.author.agentId : null,
      agentRunId: input.author.type === "agent" ? input.author.runId : null,
      hop: input.author.type === "agent" ? input.author.hop : 0,
      body,
      mentionedAgentIds,
      meta: input.meta ?? {},
    })
    .returning();
  if (!message) throw new Error("message insert returned nothing");

  await enqueue(tx, {
    orgId: input.orgId,
    kind: "search.index",
    payload: { kind: "message", sourceId: message.id },
    dedupeKey: `search.index:message:${message.id}`,
  });
  // Mentions start runs; a person's message without mentions goes to the router.
  if (mentionedAgentIds.length > 0 || input.author.type === "person") {
    await enqueue(tx, {
      orgId: input.orgId,
      kind: "message.posted",
      payload: { messageId: message.id },
      dedupeKey: `message.posted:${message.id}`,
    });
  }
  return message;
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
  const message = await deps.db.transaction((tx) =>
    insertMessage(tx, {
      orgId,
      channelId,
      threadId: input.threadId,
      author: { type: "person", userId },
      body: input.body,
      meta: clientId ? { clientId } : undefined,
    }),
  );
  const view = messageView(message);
  // Right after the commit, before any routing: the sender's optimistic copy reconciles by `clientId`.
  await publishMessageCreated(deps.pubsub, view);
  // Agents that will surely answer show "thinking" at once (the run doesn't exist yet: runId null).
  const threadId = message.threadId ?? message.id;
  const answering = message.mentionedAgentIds.length
    ? message.mentionedAgentIds
    : channel.kind === "dm"
      ? (await dmAgents(deps.db, orgId, channelId)).map((a) => a.id)
      : [];
  for (const agentId of answering) {
    await publishChannelEvent(deps.pubsub, { type: "agent.thinking", channelId, threadId, agentId, runId: null });
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
