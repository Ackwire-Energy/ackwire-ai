import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, desc, type Executor, eq, inArray, isNull, lt, schema } from "@agenteschat/db";
import { requireChannelAccess } from "./channels";
import { NotFoundError, ValidationError } from "./errors";
import { publishMessageCreated } from "./events";
import { requirePermission } from "./organizations";
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
  createdAt: m.createdAt.toISOString(),
});

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
    })
    .returning();
  if (!message) throw new Error("message insert returned nothing");

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
  input: { body: string; threadId?: string | null },
): Promise<MessageView> {
  await requirePermission(deps.db, userId, orgId, "post");
  await requireChannelAccess(deps.db, userId, orgId, channelId);
  const message = await deps.db.transaction((tx) =>
    insertMessage(tx, {
      orgId,
      channelId,
      threadId: input.threadId,
      author: { type: "person", userId },
      body: input.body,
    }),
  );
  const view = messageView(message);
  await publishMessageCreated(deps.pubsub, view);
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
    return [root, ...replies].map(messageView);
  }
  const rows = await db
    .select()
    .from(messages)
    .where(and(scope, isNull(messages.threadId), options.before ? lt(messages.createdAt, options.before) : undefined))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit);
  return rows.reverse().map(messageView);
}
