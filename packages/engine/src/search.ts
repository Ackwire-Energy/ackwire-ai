import type {
  MessageFilter,
  SearchDocument,
  SearchHit,
  SearchIndexResolver,
  SearchKind,
  SearchQuery,
} from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  type Executor,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  rowsOf,
  schema,
  sql,
} from "@agenteschat/db";
import { agentIdsSeen, isPlaybook } from "./audience";
import { caches } from "./cache";
import { personAgentDmKey } from "./dms";
import { cutText } from "./format";
import type { ModelGateway } from "./gateway";
import { mediaOf } from "./media";
import { readableBody, voiceOf } from "./message-preview";
import { replyExcerpt } from "./messages";
import { isAgentOnlyNotice } from "./notices";
import { can, requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { isRoutineRoomKey } from "./routine-brief";
import { adminChannelSql, taskSeenSql } from "./task-access";
import { visibleWikiPageIds } from "./wiki-links";

const { messages, channelMembers, channels, contextItems, organizationMembers, routines } = schema;

export interface SearchDeps {
  db: Database;
  search: SearchIndexResolver;
  gateway: Pick<ModelGateway, "embed">;
}

/** Builds the search document of one source, or null when it should not be in the index. */
export type DocumentBuilder = (db: Database, orgId: string, sourceId: string) => Promise<SearchDocument | null>;

const builders = new Map<SearchKind, DocumentBuilder>();

/** Registers how a kind of source becomes a search document (messages, context items, issues, files). */
export function registerDocumentBuilder(kind: SearchKind, builder: DocumentBuilder) {
  builders.set(kind, builder);
}

registerDocumentBuilder("message", async (db, orgId, id) => {
  const [m] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, id), eq(messages.orgId, orgId)));
  // A notice only its agent reads is nobody's to find.
  if (!m || m.deletedAt || isAgentOnlyNotice(m.meta)) return null;
  return { orgId, kind: "message", sourceId: m.id, channelIds: [m.channelId], body: m.body, createdAt: m.createdAt };
});

registerDocumentBuilder("context_item", async (db, orgId, id) => {
  const [c] = await db
    .select()
    .from(contextItems)
    .where(and(eq(contextItems.id, id), eq(contextItems.orgId, orgId)));
  // Archived and superseded items leave the index; `expand` still reaches them by id.
  if (c?.status !== "active" || c.supersededBy) return null;
  return {
    orgId,
    kind: "context_item",
    sourceId: c.id,
    channelIds: c.channelIds,
    title: `${c.kind}${c.title ? `: ${c.title}` : ""}`,
    body: c.content,
    createdAt: c.createdAt,
  };
});

/** Enqueues (re)indexing of one source, in the caller's transaction. */
export async function enqueueIndex(tx: Executor, input: { orgId: string; kind: SearchKind; sourceId: string }) {
  await enqueue(tx, {
    orgId: input.orgId,
    kind: "search.index",
    payload: { kind: input.kind, sourceId: input.sourceId },
  });
}

/** Job `search.index`: builds the document (or removes it), embeds it if possible, upserts. */
export async function indexSource(deps: SearchDeps, input: { orgId: string; kind: SearchKind; sourceId: string }) {
  const builder = builders.get(input.kind);
  if (!builder) return;
  const index = await deps.search.forOrg(input.orgId);
  const doc = await builder(deps.db, input.orgId, input.sourceId);
  if (!doc) {
    await index.delete([{ kind: input.kind, sourceId: input.sourceId }]);
    return;
  }
  await upsertWithEmbeddings(deps, input.orgId, [doc]);
}

async function upsertWithEmbeddings(deps: SearchDeps, orgId: string, docs: SearchDocument[]) {
  if (docs.length === 0) return;
  const embedded = await deps.gateway.embed({
    orgId,
    texts: docs.map((d) => cutText(`${d.title ? `${d.title}\n` : ""}${d.body}`, 8000)),
    inputType: "document",
  });
  const withVectors = docs.map((d, i) => ({
    ...d,
    embedding: embedded?.vectors[i] ?? null,
    embeddingModel: embedded?.model ?? null,
  }));
  await (await deps.search.forOrg(orgId)).upsert(withVectors);
}

/**
 * Job `search.reindex`: rebuilds an organization's index (messages and
 * context items), in pages, embedding each page in one call.
 */
export async function reindexOrg(deps: SearchDeps, orgId: string, options: { pageSize?: number } = {}) {
  const page = options.pageSize ?? 200;
  let indexed = 0;
  let cursor = new Date(0);
  let cursorId = "";
  for (;;) {
    const rows = await deps.db
      .select({ id: messages.id, createdAt: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.orgId, orgId), isNull(messages.deletedAt), gt(messages.createdAt, cursor)))
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .limit(page);
    const docs: SearchDocument[] = [];
    for (const r of rows) {
      if (r.id === cursorId) continue;
      const doc = await builders.get("message")?.(deps.db, orgId, r.id);
      if (doc) docs.push(doc);
    }
    await upsertWithEmbeddings(deps, orgId, docs);
    indexed += docs.length;
    if (rows.length < page) break;
    const last = rows.at(-1);
    if (!last) break;
    cursor = new Date(last.createdAt.getTime() - 1);
    cursorId = last.id;
  }
  const items = await deps.db
    .select({ id: contextItems.id })
    .from(contextItems)
    .where(and(eq(contextItems.orgId, orgId), eq(contextItems.status, "active"), isNull(contextItems.supersededBy)));
  for (let i = 0; i < items.length; i += page) {
    const docs: SearchDocument[] = [];
    for (const it of items.slice(i, i + page)) {
      const doc = await builders.get("context_item")?.(deps.db, orgId, it.id);
      if (doc) docs.push(doc);
    }
    await upsertWithEmbeddings(deps, orgId, docs);
    indexed += docs.length;
  }
  for (const [kind, builder] of builders) {
    if (kind === "message" || kind === "context_item") continue;
    for (const id of (await extraSources.get(kind)?.(deps.db, orgId)) ?? []) {
      const doc = await builder(deps.db, orgId, id);
      if (doc) {
        await upsertWithEmbeddings(deps, orgId, [doc]);
        indexed++;
      }
    }
  }
  return indexed;
}

/** Lists the source ids of other kinds for reindexing (registered by their modules). */
const extraSources = new Map<SearchKind, (db: Database, orgId: string) => Promise<string[]>>();
export function registerReindexSource(kind: SearchKind, list: (db: Database, orgId: string) => Promise<string[]>) {
  extraSources.set(kind, list);
}

/** Channels an agent can see: the ones it belongs to (resolved at query time, ADR 0017). */
export async function agentVisibleChannels(db: Database, orgId: string, agentId: string): Promise<string[]> {
  return caches.scopes.getOrLoad(`${orgId}:${agentId}:visible`, () => loadAgentChannels(db, orgId, agentId)) as Promise<
    string[]
  >;
}

async function loadAgentChannels(db: Database, orgId: string, agentId: string) {
  const rows = await db
    .select({ id: channelMembers.channelId })
    .from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.agentId, agentId), isNull(channels.archivedAt)));
  return rows.map((r) => r.id);
}

/**
 * Channels an agent's explicit search (`search_context`, `expand`) may read:
 * its public channels plus the run's own channel. Other private channels and
 * DMs it belongs to stay out, so a question in one place can't pull private
 * conversations from another. A routine's room (ADR 0053 §4) is read only by
 * that routine's own runs: never by another routine's run or a conversation's.
 * A routine's run also reads the conversation it reports to, private or a DM,
 * while its creator is still in it (`routineReportChannel`).
 */
export async function agentSearchChannels(db: Database, orgId: string, agentId: string, currentChannelId: string) {
  const rows = (await caches.scopes.getOrLoad(`${orgId}:${agentId}:visible-kind`, async () =>
    db
      .select({
        id: channelMembers.channelId,
        visibility: channels.visibility,
        kind: channels.kind,
        dmKey: channels.dmKey,
      })
      .from(channelMembers)
      .innerJoin(channels, eq(channels.id, channelMembers.channelId))
      .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.agentId, agentId), isNull(channels.archivedAt))),
  )) as { id: string; visibility: string; kind: string; dmKey: string | null }[];
  const room = rows.find((r) => r.id === currentChannelId && isRoutineRoomKey(r.dmKey));
  const reports = room?.dmKey ? await routineReportChannel(db, orgId, agentId, room.dmKey) : null;
  return rows
    .filter(
      (r) =>
        r.id === currentChannelId ||
        r.id === reports ||
        (r.visibility === "public" && r.kind === "channel" && !isRoutineRoomKey(r.dmKey)),
    )
    .map((r) => r.id);
}

/**
 * The conversation the routine of this room reports to, when its creator is still a member of it and of the
 * workspace: its runs summarize it, so they read what the creator reads there and nothing else. Null otherwise.
 */
async function routineReportChannel(db: Database, orgId: string, agentId: string, roomKey: string) {
  const routineId = roomKey.match(/\|r:([^|]+)$/)?.[1];
  if (!routineId) return null;
  const [routine] = await db
    .select({ target: routines.target, creator: routines.createdByUserId })
    .from(routines)
    .where(
      and(
        eq(routines.orgId, orgId),
        eq(routines.id, routineId),
        eq(routines.agentId, agentId),
        isNull(routines.deletedAt),
      ),
    );
  const creator = routine?.creator;
  if (!creator) return null;
  const target = routine.target as { type?: unknown; channelId?: unknown };
  const channelId =
    (target.type === "channel" || target.type === "conversation") && typeof target.channelId === "string"
      ? target.channelId
      : target.type === "dm"
        ? (
            await db
              .select({ id: channels.id })
              .from(channels)
              .where(and(eq(channels.orgId, orgId), eq(channels.dmKey, personAgentDmKey(creator, agentId))))
          )[0]?.id
        : undefined;
  if (!channelId) return null;
  const [reads] = await db
    .select({ id: channelMembers.id })
    .from(channelMembers)
    .innerJoin(
      organizationMembers,
      and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, channelMembers.userId)),
    )
    .where(
      and(eq(channelMembers.orgId, orgId), eq(channelMembers.channelId, channelId), eq(channelMembers.userId, creator)),
    );
  return reads ? channelId : null;
}

/** Channels a person can read: the ones they belong to and, for an administrator, every channel (never a DM). */
export async function userVisibleChannels(
  db: Database,
  orgId: string,
  userId: string,
  options: { archived?: boolean } = {},
) {
  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .leftJoin(channelMembers, and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, userId)))
    .where(
      and(
        eq(channels.orgId, orgId),
        options.archived ? undefined : isNull(channels.archivedAt),
        or(isNotNull(channelMembers.id), adminChannelSql(sql`${orgId}::uuid`, sql`${userId}::text`)),
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * The tasks a person sees outside what `userVisibleChannels` gives them, as the ids their search documents carry: one
 * limited to people is its own scope, one tied to a conversation that conversation (for an administrator, a DM it never
 * reads). Only tasks' documents are searched with them (`visibleIssueScopes`).
 */
async function issueSearchScopes(db: Database, orgId: string, userId: string) {
  const rows = rowsOf<{ scope: string }>(
    await db.execute(sql`select coalesce(i.channel_id, i.id) as scope from ${schema.issues} i
      where i.org_id = ${orgId}::uuid and (i.restricted or i.channel_id is not null)
        and ${taskSeenSql("i", sql`${userId}::text`)}`),
  );
  return [...new Set(rows.map((r) => r.scope))];
}

/** Hybrid search with the query embedded when possible (else full-text only). */
export async function searchVisible(
  deps: SearchDeps,
  input: {
    orgId: string;
    text: string;
    visibleChannelIds: string[];
    kinds?: SearchKind[];
    limit?: number;
    match?: "all" | "any";
  } & Pick<SearchQuery, "after" | "before" | "messages" | "sort" | "visibleIssueScopes">,
): Promise<SearchHit[]> {
  // A list by date ranks by no vector: no embedding to pay for.
  const embedded =
    input.text.trim() && (input.sort ?? "relevance") === "relevance"
      ? await deps.gateway.embed({ orgId: input.orgId, texts: [input.text], inputType: "query" })
      : null;
  const index = await deps.search.forOrg(input.orgId);
  return index.query({
    text: input.text,
    embedding: embedded?.vectors[0] ?? null,
    visibleChannelIds: input.visibleChannelIds,
    visibleIssueScopes: input.visibleIssueScopes,
    kinds: input.kinds,
    limit: input.limit,
    match: input.match,
    after: input.after,
    before: input.before,
    messages: input.messages,
    sort: input.sort,
  });
}

/** A person's search filters (ADR 0123): what `searchForUser` takes besides the words. */
export interface UserSearchFilters extends Pick<SearchQuery, "after" | "before" | "sort"> {
  /** Only these channels and DMs (`in:`); the ones the person can't read are dropped, never searched. */
  channelIds?: string[];
  /** What an agent reads for them, in place of `userVisibleChannels` (`personReach`). */
  reach?: string[];
  messages?: MessageFilter;
}

/** A person's search across what they can read. */
export async function searchForUser(
  deps: SearchDeps,
  userId: string,
  orgId: string,
  input: { text: string; kinds?: SearchKind[]; limit?: number } & UserSearchFilters,
) {
  const membership = await requirePermission(deps.db, userId, orgId, "read");
  const { channelIds, reach, ...rest } = input;
  let visible = reach ?? (await userVisibleChannels(deps.db, orgId, userId));
  if (channelIds) {
    const wanted = new Set(channelIds);
    visible = visible.filter((id) => wanted.has(id));
    if (visible.length === 0) return [];
  }
  // A channel scope or a message filter searches messages alone (a workspace-wide wiki page is in no channel).
  const kinds = channelIds || input.messages ? (["message"] satisfies SearchKind[]) : input.kinds;
  const messages = input.messages ?? (channelIds ? {} : undefined);
  const visibleIssueScopes = channelIds ? [] : await issueSearchScopes(deps.db, orgId, userId);
  let hits = await searchVisible(deps, {
    orgId,
    ...rest,
    kinds,
    messages,
    visibleChannelIds: visible,
    visibleIssueScopes,
  });
  // A task's document follows a change of who sees it a moment later: the task itself decides.
  const tasks = hits.filter((h) => h.kind === "issue").map((h) => h.sourceId);
  if (tasks.length > 0) {
    const shown = await deps.db
      .select({ id: schema.issues.id })
      .from(schema.issues)
      .where(and(inArray(schema.issues.id, tasks), taskSeenSql("issues", sql`${userId}::text`)));
    const seen = new Set(shown.map((t) => t.id));
    hits = hits.filter((h) => h.kind !== "issue" || seen.has(h.sourceId));
  }
  // Memory is indexed by channel only: the same rule as `listContextItems` for an agent's and a person's items.
  const items = hits.filter((h) => h.kind === "context_item").map((h) => h.sourceId);
  if (items.length > 0) {
    const [rows, agentsSeen] = await Promise.all([
      deps.db
        .select({
          id: contextItems.id,
          agentId: contextItems.agentId,
          scopeType: contextItems.scopeType,
          scopeId: contextItems.scopeId,
          kind: contextItems.kind,
          createdByKind: contextItems.createdByKind,
        })
        .from(contextItems)
        .where(and(eq(contextItems.orgId, orgId), inArray(contextItems.id, items))),
      agentIdsSeen(deps.db, userId, orgId),
    ]);
    const reviews = can(membership, "review_memory");
    const shown = new Set(
      rows
        .filter(
          (r) =>
            (!r.agentId || agentsSeen.details.has(r.agentId)) &&
            (!isPlaybook(r) || agentsSeen.playbook.has(r.agentId ?? "")) &&
            (reviews || r.scopeType !== "person" || r.scopeId === userId),
        )
        .map((r) => r.id),
    );
    hits = hits.filter((h) => h.kind !== "context_item" || shown.has(h.sourceId));
  }
  // Wiki pages are indexed for the whole workspace; a restricted one only reaches its audience.
  const pages = hits.filter((h) => h.kind === "wiki").map((h) => h.sourceId);
  if (pages.length === 0) return hits;
  const seen = await visibleWikiPageIds(deps.db, userId, pages);
  return hits.filter((h) => h.kind !== "wiki" || seen.has(h.sourceId));
}

export interface HitSource {
  /** Message hits: the message, its thread (null = main timeline) and its author. */
  messageId: string | null;
  threadId: string | null;
  /** Message hits in a thread: its title, else its root message's first line; null on the main timeline. */
  threadTitle: string | null;
  author: { type: "person" | "agent"; id: string; name: string } | null;
  /**
   * Message hits: a voice message (its snippet is empty: people hear it, ADR 0100), a GIF or a sticker (ADR 0091), so
   * the app says what it was where no words show. A search by filters alone lists messages with no words too.
   */
  mediaKind?: "voice" | "gif" | "sticker";
}

/** A thread named by its root's first line: as long as a search result's heading holds. */
const THREAD_TITLE_LENGTH = 80;

/** Adds where a message hit lives and who wrote it (an action hit: the agent that did it), so the app can jump to it. */
export async function describeHits<H extends SearchHit>(
  db: Database,
  orgId: string,
  hits: H[],
): Promise<(H & HitSource)[]> {
  const ids = hits.filter((h) => h.kind === "message").map((h) => h.sourceId);
  const rows = ids.length
    ? await db
        .select({
          id: messages.id,
          meta: messages.meta,
          threadId: messages.threadId,
          authorType: messages.authorType,
          userId: messages.authorUserId,
          agentId: messages.authorAgentId,
          userName: schema.users.name,
          agentName: schema.agents.name,
        })
        .from(messages)
        .leftJoin(schema.users, eq(schema.users.id, messages.authorUserId))
        .leftJoin(schema.agents, eq(schema.agents.id, messages.authorAgentId))
        .where(and(eq(messages.orgId, orgId), inArray(messages.id, ids)))
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Replies: their thread's title, else its root message's first line.
  const rootIds = [...new Set(rows.flatMap((r) => (r.threadId && r.threadId !== r.id ? [r.threadId] : [])))];
  const roots = rootIds.length
    ? await db
        .select({ id: messages.id, body: messages.body, meta: messages.meta, title: schema.threads.title })
        .from(messages)
        .leftJoin(schema.threads, and(eq(schema.threads.orgId, orgId), eq(schema.threads.rootMessageId, messages.id)))
        .where(and(eq(messages.orgId, orgId), inArray(messages.id, rootIds)))
    : [];
  const threadTitles = new Map(
    roots.map((r) => [r.id, r.title?.trim() || replyExcerpt(readableBody(r.body, r.meta), THREAD_TITLE_LENGTH)]),
  );
  // The team's outside actions (ADR 0064): the agent that did it.
  const actionIds = hits.filter((h) => h.kind === "action").map((h) => h.sourceId);
  const actionRows = actionIds.length
    ? await db
        .select({ id: schema.teamActions.id, agentId: schema.teamActions.agentId, agentName: schema.agents.name })
        .from(schema.teamActions)
        .leftJoin(schema.agents, eq(schema.agents.id, schema.teamActions.agentId))
        .where(and(eq(schema.teamActions.orgId, orgId), inArray(schema.teamActions.id, actionIds)))
    : [];
  const actionsById = new Map(actionRows.map((r) => [r.id, r]));
  return hits.map((h) => {
    const a = h.kind === "action" ? actionsById.get(h.sourceId) : undefined;
    if (a) {
      return {
        ...h,
        messageId: null,
        threadId: null,
        threadTitle: null,
        author: { type: "agent" as const, id: a.agentId, name: a.agentName ?? "" },
      };
    }
    const m = h.kind === "message" ? byId.get(h.sourceId) : undefined;
    if (!m) return { ...h, messageId: null, threadId: null, threadTitle: null, author: null };
    // A voice message is found by its words, and shows as its audio (ADR 0100).
    const snippet = readableBody(h.snippet, m.meta);
    const media = mediaOf(m.meta);
    const mediaKind = voiceOf(m.meta) ? ("voice" as const) : media?.kind;
    const author =
      m.authorType === "agent" && m.agentId
        ? { type: "agent" as const, id: m.agentId, name: m.agentName ?? "" }
        : m.userId
          ? { type: "person" as const, id: m.userId, name: m.userName ?? "" }
          : null;
    const threadTitle = m.threadId && m.threadId !== m.id ? (threadTitles.get(m.threadId) ?? null) : null;
    return {
      ...h,
      snippet,
      messageId: m.id,
      threadId: m.threadId,
      threadTitle,
      author,
      ...(mediaKind ? { mediaKind } : {}),
    };
  });
}
