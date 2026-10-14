import { and, type Database, desc, inArray, isNull, schema, sql } from "@agenteschat/db";

export interface SearchDocument {
  id: string;
  orgId: string;
  kind: "message";
  /** Visibility travels with the document (docs/planejamento.md D11). */
  channelId: string;
  text: string;
  createdAt: Date;
}

export interface SearchQuery {
  text: string;
  /** Only documents in these channels are returned. Enforced by every implementation. */
  visibleChannelIds: string[];
  limit?: number;
}

export interface SearchHit {
  id: string;
  kind: "message";
  channelId: string;
  snippet: string;
  createdAt: Date;
}

/** A search backend for one organization: Postgres (core) or Turbopuffer (Cloud). */
export interface SearchIndex {
  readonly backend: string;
  upsert(docs: SearchDocument[]): Promise<void>;
  delete(ids: string[]): Promise<void>;
  query(q: SearchQuery): Promise<SearchHit[]>;
}

/**
 * Picks the search backend per organization (D18c). The core always answers
 * Postgres and knows nothing about plans; the Cloud billing module replaces
 * this resolver.
 */
export interface SearchIndexResolver {
  forOrg(orgId: string): Promise<SearchIndex>;
}

/**
 * STUB. Postgres search over `messages`, scoped to the org and to visible
 * channels. Indexing is a no-op because the messages table is the source; real
 * hybrid search (tsvector + pgvector, fed by the outbox) replaces this later.
 */
export function createPostgresSearchResolver(db: Database): SearchIndexResolver {
  return {
    async forOrg(orgId) {
      return {
        backend: "postgres",
        async upsert() {},
        async delete() {},
        async query(q) {
          if (q.visibleChannelIds.length === 0 || q.text.trim() === "") return [];
          const m = schema.messages;
          const rows = await db
            .select({ id: m.id, channelId: m.channelId, body: m.body, createdAt: m.createdAt })
            .from(m)
            .where(
              and(
                sql`${m.orgId} = ${orgId}`,
                inArray(m.channelId, q.visibleChannelIds),
                isNull(m.deletedAt),
                sql`${m.body} ilike ${`%${q.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`,
              ),
            )
            .orderBy(desc(m.createdAt))
            .limit(q.limit ?? 20);
          return rows.map((r) => ({
            id: r.id,
            kind: "message" as const,
            channelId: r.channelId,
            snippet: r.body.slice(0, 200),
            createdAt: r.createdAt,
          }));
        },
      };
    },
  };
}
