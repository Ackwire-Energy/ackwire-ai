import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { users } from "./auth";
import { organizations } from "./tenancy";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/**
 * The core search index (D11, D15; docs/adr/0017-search-and-context.md):
 * one row per searchable thing (message, context item, issue, forum post,
 * file), fed by the outbox. Hybrid: full-text (`tsv`, `simple` config so
 * Portuguese and English both work) + pgvector (`embedding`, optional).
 * Visibility travels with the document: `channel_ids` are ALL required (the
 * most restrictive of the sources); empty = visible to the whole org.
 */
export const searchDocuments = pgTable(
  "search_documents",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    sourceId: uuid().notNull(),
    channelIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    title: text().notNull().default(""),
    body: text().notNull(),
    tsv: tsvector().generatedAlwaysAs(sql`to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(body, ''))`),
    embedding: vector({ dimensions: 1024 }),
    embeddingModel: text(),
    /** When the source was created (recency ranking). */
    sourceCreatedAt: timestamp({ withTimezone: true }).notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique().on(t.kind, t.sourceId),
    index().on(t.orgId, t.kind),
    index("search_documents_tsv_idx").using("gin", t.tsv),
    index("search_documents_embedding_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ],
);

export const contextKindEnum = pgEnum("context_kind", [
  "thread_summary",
  "period_summary",
  "decision",
  "fact",
  "preference",
  "open_question",
  "entity_profile",
  "note",
  "lesson",
]);
export const trustEnum = pgEnum("context_trust", ["high", "low"]);
export const contextStatusEnum = pgEnum("context_status", ["active", "archived"]);

/** One piece of evidence behind an item. Weight order: outcome > human > agent > self. */
export interface ContextEvidence {
  type: "outcome" | "human" | "agent" | "self";
  /** Message id, outcome id or approval id. */
  ref: string;
  /** For `agent`/`self`: the agent that made the claim. */
  agentId?: string;
  at: string;
}

/**
 * Derived context (D13) and agent memories, in one table
 * (docs/adr/0017-search-and-context.md). Summaries, decisions, facts,
 * preferences, open questions, entity profiles; notes and lessons belong to
 * an agent (`agent_id`) or, with `agent_id` null and kind `lesson`, to the
 * team (playbook). Never overwritten: a new version supersedes the old one
 * (`superseded_by`). Visibility is inherited from the sources (most
 * restrictive): every channel in `channel_ids` is required.
 */
export const contextItems = pgTable(
  "context_items",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    kind: contextKindEnum().notNull(),
    /** `thread`, `channel`, `org`, `agent` or `entity`. */
    scopeType: text().notNull(),
    scopeId: text(),
    /** Owner agent of notes and lessons; null = shared. */
    agentId: uuid(),
    /** Normalized subject, for dedupe and contradiction detection. */
    subjectKey: text().notNull().default(""),
    title: text().notNull().default(""),
    content: text().notNull(),
    sourceIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    channelIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    trust: trustEnum().notNull().default("high"),
    /** `verified` needs an observed outcome or a person; agent claims alone stay `unverified`. */
    verified: boolean().notNull().default(true),
    evidence: jsonb().$type<ContextEvidence[]>().notNull().default([]),
    confidence: real().notNull().default(0.7),
    /** Grows when retrieved and used, decays with age and disuse. */
    relevance: real().notNull().default(0.5),
    useCount: integer().notNull().default(0),
    /** Times the same lesson/fact was seen again. */
    recurrence: integer().notNull().default(1),
    lastUsedAt: timestamp({ withTimezone: true }),
    pinned: boolean().notNull().default(false),
    /** Items the judge found on the same topic but kept apart (related, or in conflict) (ADR 0028). */
    relatedIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** Another item contradicts this one; shown to models as disputed until a person resolves it. */
    disputed: boolean().notNull().default(false),
    status: contextStatusEnum().notNull().default("active"),
    supersededBy: uuid(),
    version: integer().notNull().default(1),
    /** Summaries: the newest source they cover. */
    coversUntil: timestamp({ withTimezone: true }),
    /** `job`, `agent` or `person`. */
    createdByKind: text().notNull().default("job"),
    createdById: text(),
    /** A proposal was already made from this item. */
    proposedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    index().on(t.orgId, t.kind, t.status),
    index().on(t.orgId, t.scopeType, t.scopeId),
    index().on(t.agentId, t.status),
    index().on(t.orgId, t.subjectKey),
  ],
);

/** Which items a run's context included: feeds relevance (and feedback). */
export const contextUsage = pgTable(
  "context_usage",
  {
    orgId: uuid().notNull(),
    runId: uuid().notNull(),
    itemId: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.itemId] }), index().on(t.itemId)],
);

export const proposalTargetEnum = pgEnum("proposal_target", ["agent_instructions", "org_context"]);
export const proposalStatusEnum = pgEnum("proposal_status", ["pending", "accepted", "rejected", "stale"]);

/**
 * A proposed change to an agent's instructions or the org context, made from
 * a recurring or high-confidence verified item. Stored as a diff; never
 * applied without a person: the agent's owner (instructions) or an admin
 * (org context). Stale when the text changed since.
 */
export const contextProposals = pgTable(
  "context_proposals",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    target: proposalTargetEnum().notNull(),
    agentId: uuid(),
    /** SHA-256 of the text the diff applies to. */
    baseHash: text().notNull(),
    proposedText: text().notNull(),
    diff: text().notNull(),
    rationale: text().notNull(),
    itemIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    status: proposalStatusEnum().notNull().default("pending"),
    decidedByUserId: text().references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    index().on(t.orgId, t.status),
  ],
);

/**
 * Ground truth about what an agent's actions led to (tests, CI, merges,
 * reverts, deploys, rollbacks, error spikes, reopened issues, refused
 * approvals), tied back to the run when known. Fed by tool results,
 * approvals and webhooks; the strongest evidence for lessons.
 */
export const outcomes = pgTable(
  "outcomes",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid(),
    runId: uuid(),
    stepSeq: integer(),
    kind: text().notNull(),
    /** `positive` or `negative`. */
    polarity: text().notNull(),
    /** What it is about, e.g. `acme/app#42` or `deploy:prod`. */
    subject: text().notNull().default(""),
    summary: text().notNull().default(""),
    details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    /** `tool`, `approval`, `webhook`. */
    source: text().notNull(),
    channelId: uuid(),
    threadRootId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId, t.agentId, t.createdAt), index().on(t.orgId, t.subject)],
);

/** Reactions on messages (thumbs up/down on agent replies feed agent lessons and relevance). */
export const messageReactions = pgTable(
  "message_reactions",
  {
    orgId: uuid().notNull(),
    messageId: uuid().notNull(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `+1`, `-1` or an emoji. */
    reaction: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.reaction] }), index().on(t.orgId, t.messageId)],
);

/** Reflection bookkeeping per thread: bounded runs, never twice over the same messages. */
export const threadReflections = pgTable(
  "thread_reflections",
  {
    orgId: uuid().notNull(),
    threadRootId: uuid().primaryKey(),
    channelId: uuid().notNull(),
    runs: integer().notNull().default(0),
    /** Newest message covered by the last reflection. */
    coveredUntil: timestamp({ withTimezone: true }),
    lastAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.orgId)],
);
