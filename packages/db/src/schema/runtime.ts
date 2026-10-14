import { sql } from "drizzle-orm";
import {
  bigint,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { agents, providerCredentials } from "./agents";
import { organizations } from "./tenancy";

export const outboxStatusEnum = pgEnum("outbox_status", ["pending", "processing", "done", "failed"]);

/**
 * Transactional outbox and job queue in one (docs/adr/0005-postgres-outbox.md).
 * Rows are written in the same transaction as the change that causes them;
 * in-process workers claim due rows with `FOR UPDATE SKIP LOCKED` plus a
 * lease, and retry with backoff. No Redis, no BullMQ.
 */
export const outbox = pgTable(
  "outbox",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Handler name, e.g. `message.posted` or `agent_run.execute`. */
    kind: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    status: outboxStatusEnum().notNull().default("pending"),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(8),
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** While `processing`, other workers leave the row alone until this passes (crash recovery). */
    lockedUntil: timestamp({ withTimezone: true }),
    lockedBy: text(),
    lastError: text(),
    /** Optional idempotency key: enqueueing the same key twice is a no-op. */
    dedupeKey: text().unique(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index("outbox_due_idx").on(t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
    index("outbox_leased_idx").on(t.lockedUntil).where(sql`${t.status} = 'processing'`),
  ],
);

/**
 * Durable state machine of one agent turn (docs/adr/0008-agent-runs.md):
 * `queued → running → (waiting_approval → running)* → done | failed`.
 * Suspending is a status change; resuming is enqueueing a new job.
 */
export const agentRunStatusEnum = pgEnum("agent_run_status", [
  "queued",
  "running",
  "waiting_approval",
  "done",
  "failed",
]);
export const agentRunTriggerEnum = pgEnum("agent_run_trigger", ["mention"]);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    channelId: uuid().notNull(),
    /** Thread the agent answers in (the trigger's thread, or the trigger itself when it is top-level). */
    threadRootId: uuid().notNull(),
    triggerMessageId: uuid().notNull(),
    trigger: agentRunTriggerEnum().notNull(),
    /** Hop of the reply this run will post (trigger hop + 1). */
    hop: integer().notNull(),
    status: agentRunStatusEnum().notNull().default("queued"),
    error: text(),
    replyMessageId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    // One run per (trigger, agent): redelivered outbox events can't double-answer.
    unique().on(t.triggerMessageId, t.agentId),
    index().on(t.orgId, t.status),
    index().on(t.threadRootId),
  ],
);

export const agentRunStepKindEnum = pgEnum("agent_run_step_kind", ["context", "model_call", "message", "error"]);

/** What a run did, step by step: audit trail and the base for resuming after approvals. */
export const agentRunSteps = pgTable(
  "agent_run_steps",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    runId: uuid()
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    kind: agentRunStepKindEnum().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.runId, t.seq)],
);

/**
 * One row per model call, written by the Model Gateway only. Same numbers in
 * both editions; Cloud turns them into invoices and plan limits.
 */
export const usageRecords = pgTable(
  "usage_records",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    runId: uuid().references(() => agentRuns.id, { onDelete: "set null" }),
    /** Null when the platform key paid (Cloud). */
    credentialId: uuid().references(() => providerCredentials.id, { onDelete: "set null" }),
    provider: text().notNull(),
    /** Model that actually answered (may differ from the requested one after a server-side fallback). */
    model: text().notNull(),
    requestedModel: text().notNull(),
    inputTokens: integer().notNull(),
    outputTokens: integer().notNull(),
    cacheReadTokens: integer().notNull().default(0),
    cacheWriteTokens: integer().notNull().default(0),
    /** Cost in nano-USD (1e-9 USD), computed from `MODEL_CATALOG` at call time. */
    costNanoUsd: bigint({ mode: "number" }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    index().on(t.orgId, t.agentId, t.createdAt),
  ],
);
