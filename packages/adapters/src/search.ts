import { and, type Database, desc, eq, inArray, rowsOf, schema, sql } from "@agenteschat/db";

export type SearchKind =
  | "message"
  | "context_item"
  | "issue"
  | "forum_topic"
  | "forum_reply"
  | "file"
  | "wiki"
  | "action";

export interface SearchDocument {
  orgId: string;
  kind: SearchKind;
  sourceId: string;
  /**
   * Visibility travels with the document (ADR 0017): a reader must see EVERY
   * channel listed (most restrictive of the sources). Empty = whole org.
   */
  channelIds: string[];
  title?: string;
  body: string;
  /** Optional vector (EMBEDDING_DIMENSIONS); without it the doc is full-text only. */
  embedding?: number[] | null;
  embeddingModel?: string | null;
  createdAt: Date;
}

export interface SearchQuery {
  text: string;
  /** Query vector, when an embedding provider is configured. */
  embedding?: number[] | null;
  /** Channels the reader can see. Enforced by every implementation. */
  visibleChannelIds: string[];
  kinds?: SearchKind[];
  limit?: number;
  /** `all` (default): every word must match (websearch syntax). `any`: at least one word (retrieval). */
  match?: "all" | "any";
  /** Vector hits farther than this cosine distance are dropped (default 0.75, i.e. similarity < 0.25). */
  maxDistance?: number;
}

export interface SearchHit {
  kind: SearchKind;
  sourceId: string;
  channelIds: string[];
  title: string;
  snippet: string;
  /** Fused rank score (higher is better); comparable only within one query. */
  score: number;
  createdAt: Date;
}

/** A search backend for one organization: Postgres (core) or Turbopuffer (Cloud). */
export interface SearchIndex {
  readonly backend: string;
  upsert(docs: SearchDocument[]): Promise<void>;
  delete(refs: { kind: SearchKind; sourceId: string }[]): Promise<void>;
  query(q: SearchQuery): Promise<SearchHit[]>;
}

/**
 * Picks the search backend per organization (ADR 0002). The core always answers
 * Postgres and knows nothing about plans; the Cloud billing module replaces
 * this resolver.
 */
export interface SearchIndexResolver {
  forOrg(orgId: string): Promise<SearchIndex>;
}

/** Reciprocal-rank fusion constant: dampens the weight of top ranks. */
const RRF_K = 60;

const vectorLiteral = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;

/**
 * Hybrid search on Postgres (`search_documents`): full-text with
 * `websearch_to_tsquery('simple', …)` and, when vectors exist, cosine
 * distance with pgvector; the two rankings are fused with reciprocal-rank
 * fusion, plus a small recency bonus. Every query is scoped to the org and
 * filtered by visibility in SQL (`channel_ids <@ visible`).
 */
export function createPostgresSearchResolver(db: Database): SearchIndexResolver {
  const t = schema.searchDocuments;
  return {
    async forOrg(orgId) {
      return {
        backend: "postgres",
        async upsert(docs) {
          for (const d of docs) {
            if (d.orgId !== orgId) throw new Error("document belongs to another organization");
            const values = {
              orgId,
              kind: d.kind,
              sourceId: d.sourceId,
              channelIds: d.channelIds,
              title: d.title ?? "",
              body: d.body,
              embedding: d.embedding ?? null,
              embeddingModel: d.embedding ? (d.embeddingModel ?? null) : null,
              sourceCreatedAt: d.createdAt,
              updatedAt: new Date(),
            };
            await db
              .insert(t)
              .values(values)
              .onConflictDoUpdate({ target: [t.kind, t.sourceId], set: values });
          }
        },
        async delete(refs) {
          for (const r of refs) {
            await db.delete(t).where(and(eq(t.orgId, orgId), eq(t.kind, r.kind), eq(t.sourceId, r.sourceId)));
          }
        },
        async query(q) {
          const limit = Math.min(q.limit ?? 20, 100);
          const text = q.text.trim();
          if (!text && !q.embedding) return [];
          const visible = sql`${t.channelIds} <@ ${sql`${`{${q.visibleChannelIds.join(",")}}`}::uuid[]`}`;
          const kinds = q.kinds && q.kinds.length > 0 ? inArray(t.kind, q.kinds) : undefined;
          const scope = and(eq(t.orgId, orgId), visible, kinds);

          const ranks = new Map<string, { score: number; row: typeof t.$inferSelect }>();
          const add = (rows: (typeof t.$inferSelect)[]) => {
            rows.forEach((row, i) => {
              const hit = ranks.get(row.id) ?? { score: 0, row };
              hit.score += 1 / (RRF_K + i + 1);
              ranks.set(row.id, hit);
            });
          };
          const anyWords = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 30);
          const useAny = q.match === "any" && anyWords.length > 0;
          // Full-text and vector rankings run in parallel (one round trip each, not in sequence).
          const textRows =
            text && (q.match !== "any" || useAny)
              ? (() => {
                  const query = useAny
                    ? sql`to_tsquery('simple', ${anyWords.join(" | ")})`
                    : sql`websearch_to_tsquery('simple', ${text})`;
                  return db
                    .select()
                    .from(t)
                    .where(and(scope, sql`${t.tsv} @@ ${query}`))
                    .orderBy(desc(sql`ts_rank_cd(${t.tsv}, ${query})`), desc(t.sourceCreatedAt))
                    .limit(50);
                })()
              : Promise.resolve([]);
          const vectorRows = q.embedding
            ? (async () => {
                const vec = sql`${vectorLiteral(q.embedding ?? [])}::vector`;
                // One statement: nearest ids with their rows (no second fetch).
                const ids = rowsOf<{ id: string }>(
                  await db.execute(sql`select ${t.id} as id from ${t}
                    where ${scope} and ${t.embedding} is not null
                      and ${t.embedding} <=> ${vec} < ${q.maxDistance ?? 0.75}
                    order by ${t.embedding} <=> ${vec} limit 50`),
                ).map((r) => r.id);
                if (ids.length === 0) return [];
                const full = await db.select().from(t).where(inArray(t.id, ids));
                const byId = new Map(full.map((r) => [r.id, r]));
                return ids.flatMap((id) => (byId.get(id) ? [byId.get(id) as typeof t.$inferSelect] : []));
              })()
            : Promise.resolve([]);
          const [byText, byVector] = await Promise.all([textRows, vectorRows]);
          add(byText);
          add(byVector);
          const now = Date.now();
          return [...ranks.values()]
            .map(({ score, row }) => {
              // Up to +10% for recent items (half-life ~30 days).
              const ageDays = (now - row.sourceCreatedAt.getTime()) / 86_400_000;
              return { score: score * (1 + 0.1 * 0.5 ** (ageDays / 30)), row };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(({ score, row }) => ({
              kind: row.kind as SearchKind,
              sourceId: row.sourceId,
              channelIds: row.channelIds,
              title: row.title,
              snippet: row.body.slice(0, 300),
              score,
              createdAt: row.sourceCreatedAt,
            }));
        },
      };
    },
  };
}
