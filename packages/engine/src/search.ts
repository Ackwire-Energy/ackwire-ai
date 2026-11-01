import type { SearchDocument, SearchHit, SearchIndexResolver, SearchKind } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, gt, inArray, isNull, schema } from "@agenteschat/db";
import { caches } from "./cache";
import type { ModelGateway } from "./gateway";
import { isAgentOnlyNotice } from "./notices";
import { requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { isRoutineRoomKey } from "./routine-brief";

const { messages, channelMembers, channels, contextItems } = schema;

export interface SearchDeps {
  db: Database;
  search: SearchIndexResolver;
  gateway: Pick<ModelGateway, "embed">;
}

/** Builds the search document of one source, or null when it should not be in the index. */
export type DocumentBuilder = (db: Database, orgId: string, sourceId: string) => Promise<SearchDocument | null>;

const builders = new Map<SearchKind, DocumentBuilder>();

/** Registers how a kind of source becomes a search document (messages, context items, issues, forum, files). */
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
    texts: docs.map((d) => `${d.title ? `${d.title}\n` : ""}${d.body}`.slice(0, 8000)),
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
  return rows
    .filter(
      (r) =>
        r.id === currentChannelId || (r.visibility === "public" && r.kind === "channel" && !isRoutineRoomKey(r.dmKey)),
    )
    .map((r) => r.id);
}

/** Channels a person can read: the ones they belong to. */
export async function userVisibleChannels(db: Database, orgId: string, userId: string) {
  const rows = await db
    .select({ id: channelMembers.channelId })
    .from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.userId, userId), isNull(channels.archivedAt)));
  return rows.map((r) => r.id);
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
  },
): Promise<SearchHit[]> {
  const embedded = input.text.trim()
    ? await deps.gateway.embed({ orgId: input.orgId, texts: [input.text], inputType: "query" })
    : null;
  const index = await deps.search.forOrg(input.orgId);
  return index.query({
    text: input.text,
    embedding: embedded?.vectors[0] ?? null,
    visibleChannelIds: input.visibleChannelIds,
    kinds: input.kinds,
    limit: input.limit,
    match: input.match,
  });
}

/** A person's search across what they can read. */
export async function searchForUser(
  deps: SearchDeps,
  userId: string,
  orgId: string,
  input: { text: string; kinds?: SearchKind[]; limit?: number },
) {
  await requirePermission(deps.db, userId, orgId, "read");
  return searchVisible(deps, { orgId, ...input, visibleChannelIds: await userVisibleChannels(deps.db, orgId, userId) });
}

export interface HitSource {
  /** Message hits: the message, its thread (null = main timeline) and its author. */
  messageId: string | null;
  threadId: string | null;
  author: { type: "person" | "agent"; id: string; name: string } | null;
}

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
        author: { type: "agent" as const, id: a.agentId, name: a.agentName ?? "" },
      };
    }
    const m = h.kind === "message" ? byId.get(h.sourceId) : undefined;
    if (!m) return { ...h, messageId: null, threadId: null, author: null };
    const author =
      m.authorType === "agent" && m.agentId
        ? { type: "agent" as const, id: m.agentId, name: m.agentName ?? "" }
        : m.userId
          ? { type: "person" as const, id: m.userId, name: m.userName ?? "" }
          : null;
    return { ...h, messageId: m.id, threadId: m.threadId, author };
  });
}
