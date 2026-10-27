import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents, providerCredentials } from "./agents";
import { machines } from "./machines";
import { missions } from "./missions";
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
    /** Null for jobs that belong to no organization (e.g. a password-reset email). */
    orgId: uuid().references(() => organizations.id, { onDelete: "cascade" }),
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
 * `queued → running → ((waiting_approval | waiting_input) → running)* → done | failed`.
 * Suspending is a status change; resuming is enqueueing a new job.
 */
export const agentRunStatusEnum = pgEnum("agent_run_status", [
  "queued",
  "running",
  "waiting_approval",
  "waiting_input",
  "done",
  "failed",
  /** Stopped by a person (`POST …/runs/{id}/cancel`). */
  "canceled",
]);
export const agentRunTriggerEnum = pgEnum("agent_run_trigger", ["mention", "router", "dm", "forum"]);

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
    /**
     * The conversation sent to the model, appended to turn by turn (system,
     * messages, pending tool calls). Lets a run resume after an approval with
     * exactly the history it had (append-only, so provider thinking blocks and
     * prompt caches stay valid). See docs/adr/0015-tool-gateway-and-approvals.md.
     */
    transcript: jsonb().$type<Record<string, unknown>>(),
    /** Model calls made so far (capped by AGENT_MAX_TOOL_TURNS). */
    turns: integer().notNull().default(0),
    /**
     * People's messages for this run that arrived while it was active (one
     * active run per agent and conversation): delivered to the model at the
     * next call ("New message from …"), instead of starting a second run.
     */
    pendingMessageIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /**
     * The issue this run works on: set when someone asks the agent to
     * implement it, or when the run uses an issue tool on it. The issue shows
     * "working now" from a live run, and "stalled" when none is alive.
     */
    issueId: uuid(),
    /** Bumped by the worker while it executes the run; a stale one means the worker died (recovered on boot). */
    heartbeatAt: timestamp({ withTimezone: true }),
    /**
     * The computer this run waits for (`waiting_input` with a computer brain
     * and nothing to fall back on, ADR 0032 §5): queued again when it comes
     * back (`resumeRunsWaitingForMachine`). Null otherwise.
     */
    waitingMachineId: uuid(),
    /**
     * The computer brain's session this run thinks in (Claude Code/Codex):
     * kept for the whole run (a pause resumes it), carried to the next run in
     * the conversation while it is recent and small, else a fresh one
     * (`resolveBrain`). Null for the model brain.
     */
    brainSessionId: text(),
    /**
     * Background work (a routine's run): it holds no conversation's slot. People's messages
     * never join it and it never joins theirs; it posts no final reply (only cards and `hand_off`),
     * and its computer session is never carried to the conversation's next run.
     */
    background: boolean().notNull().default(false),
    /**
     * The brain this run actually thinks with (`model`, `claude_code`, `codex`): the agent's, a
     * mission's override or a fallback. Null until its first turn. Shared code reads this, never
     * the agent's stored brain.
     */
    brain: text(),
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
    // An agent's recent work across conversations (context: "Seu trabalho recente").
    index().on(t.orgId, t.agentId, t.createdAt),
    index().on(t.issueId, t.createdAt),
    // Runs waiting for a computer, found when it reconnects (only those rows are indexed).
    index("agent_runs_waiting_machine_idx").on(t.waitingMachineId).where(sql`${t.waitingMachineId} is not null`),
  ],
);

export const agentRunStepKindEnum = pgEnum("agent_run_step_kind", [
  "context",
  "model_call",
  "message",
  "error",
  "tool_call",
  "tool_result",
  "approval",
]);

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

export const usageKindEnum = pgEnum("usage_kind", ["agent", "router", "embedding", "summary", "sandbox"]);

/**
 * One row per model call, written by the Model Gateway only. Same numbers in
 * both editions; Cloud turns them into invoices and plan limits.
 * `agent_id` is null for calls made for the organization rather than an agent
 * (router, embeddings, summaries); `kind` tells them apart.
 */
export const usageRecords = pgTable(
  "usage_records",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    agentId: uuid(),
    kind: usageKindEnum().notNull().default("agent"),
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
    /**
     * The stream failed midway: tokens are what the provider reported before
     * failing, or counted/estimated (docs/adr/0012-budget-reservation-and-usage.md).
     */
    partial: boolean().notNull().default(false),
    /**
     * Who pays: `org` (its own key) or `platform` (the server's own keys: the
     * platform model key, or internal services such as Jev, with this server's
     * TypeSafe key). Org usage reports keep platform-billed rows apart.
     */
    billedTo: text().notNull().default("org"),
    /**
     * A plan row's computer and the account it spent (`machine_accounts.id`; null with a computer: that
     * computer's own sign-in). Null on API rows, and on plan rows from before accounts were recorded.
     * No foreign keys: the history outlives a removed account or computer.
     */
    machineId: uuid(),
    brainAccountId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    index().on(t.orgId, t.agentId, t.createdAt),
    index().on(t.orgId, t.createdAt),
  ],
);

/**
 * Per-agent spend counter for one calendar month (UTC). The Model Gateway
 * reserves the worst-case cost of a call here (row lock) before calling and
 * settles to the actual cost after, so concurrent runs can't overshoot the
 * budget (docs/adr/0012-budget-reservation-and-usage.md).
 */
export const agentBudgetPeriods = pgTable(
  "agent_budget_periods",
  {
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    periodStart: date({ mode: "string" }).notNull(),
    spentNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    reservedNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.agentId, t.periodStart] }),
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
  ],
);

/** An open reservation. Released on settle, or when it expires (a worker died mid-call). */
export const budgetReservations = pgTable(
  "budget_reservations",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    periodStart: date({ mode: "string" }).notNull(),
    amountNanoUsd: bigint({ mode: "number" }).notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    index().on(t.agentId, t.expiresAt),
  ],
);

/**
 * What the router decided for one message without mentions (docs/adr/0013-router.md):
 * which strategy ranked the candidates, every candidate's score, and who was
 * picked after policy (threshold, at most 2, hop limit). Kept to compare
 * strategies over time.
 */
export const routingDecisions = pgTable(
  "routing_decisions",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    channelId: uuid().notNull(),
    messageId: uuid().notNull(),
    /**
     * Who decided (ADR 0074): `jev`, `llm:<model>`, `plan:<kind>`, `rule:<name>`, `none` (nobody could read
     * it), `no_ai`, a mention's judge, or another implementation's name.
     */
    strategy: text().notNull(),
    candidates: jsonb().$type<{ agentId: string; score: number }[]>().notNull(),
    /** Need-any-agent probability, when the strategy reports one. */
    needsAgentScore: real(),
    selectedAgentIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** Code's markers first (`follow-up`), then the deciding step's words after its name (`jev: …`). */
    reason: text(),
    /** The router's steps that failed before one decided (`jev: TypeSafe answered 529`), or `no_ai`. */
    error: text(),
    usageRecordId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.messageId), index().on(t.orgId, t.createdAt)],
);

export const approvalStatusEnum = pgEnum("approval_status", [
  "pending",
  "approved",
  "refused",
  "expired",
  /** Its run was canceled. */
  "canceled",
]);

/**
 * A sensitive action an agent wants to take (docs/adr/0015). Bound to the
 * exact action: `action_hash` = SHA-256 of the canonical JSON of (tool,
 * scope, connection, params); only that is ever executed. Who may decide:
 * the agent's owner (`owner_user_id`, snapshot at creation) and org admins.
 */
export const approvals = pgTable(
  "approvals",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    /** The run that asked; null for a mission's executor asking through the `agentes` MCP server (ADR 0029). */
    runId: uuid().references(() => agentRuns.id, { onDelete: "cascade" }),
    /** Asked by a mission's executor (`request_approval`): the decision resumes that task's session, not a run. */
    missionId: uuid(),
    missionTaskId: uuid(),
    agentId: uuid().notNull(),
    channelId: uuid().notNull(),
    threadRootId: uuid().notNull(),
    /** The chat message showing the request (a card). */
    messageId: uuid(),
    /** Tool-use id in the run's transcript, to answer the model. */
    toolUseId: text().notNull(),
    tool: text().notNull(),
    scope: text().notNull(),
    connectionId: uuid(),
    params: jsonb().$type<Record<string, unknown>>().notNull(),
    actionHash: text().notNull(),
    /** Human summary, e.g. "Merge PR #42 into main". */
    title: text().notNull(),
    detail: text().notNull().default(""),
    /** The agent's own reason, required on every request (ADR 0053): what it found and why this action. */
    why: text().notNull().default(""),
    /**
     * Asked while nobody was watching (ADR 0053): `{ kind: "routine" | "unattended", routineId?,
     * routineName? }`. The card and the notification say so. Null when a person was behind the run.
     */
    origin: jsonb().$type<Record<string, unknown>>(),
    status: approvalStatusEnum().notNull().default("pending"),
    ownerUserId: text(),
    decidedByUserId: text(),
    decidedAt: timestamp({ withTimezone: true }),
    /** Why it was refused (fed back to the model and to agent lessons). */
    reason: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    /** When approvers were last emailed about it (reminder digest). */
    remindedAt: timestamp({ withTimezone: true }),
    /** Set once when the approved action runs: never twice. */
    executedAt: timestamp({ withTimezone: true }),
    result: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    unique().on(t.runId, t.toolUseId),
    index().on(t.orgId, t.status, t.createdAt),
    index().on(t.expiresAt).where(sql`${t.status} = 'pending'`),
  ],
);

/**
 * Act with undo (ADR 0037 round 2): an internal, reversible change an agent
 * made with a tool (an issue, a memory, a routine, a channel member, a wiki
 * page, a thread). Written with the change; linked to the run's reply
 * (`message_id`) so the message shows it as a receipt with "Desfazer".
 * `before`/`after`: what is needed to invert and to detect someone else's
 * change since. `undone_at` set = currently undone (redo clears it);
 * `undoable_until` moves forward on every undo or redo.
 */
export const agentActions = pgTable(
  "agent_actions",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    /** The run that made the change (no foreign key: receipts outlive pruned runs). */
    runId: uuid(),
    agentId: uuid().notNull(),
    channelId: uuid().notNull(),
    /** The run's reply (set when it is posted). */
    messageId: uuid(),
    /** The person the agent worked for (the trigger message's author); null for routines and agents. */
    requestedByUserId: text(),
    kind: text().notNull(),
    targetType: text().notNull(),
    targetId: text().notNull(),
    /** Label of the target for the receipt (`number`, `title`, `name`…) and the summary's params. */
    target: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    params: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    before: jsonb().$type<Record<string, unknown>>(),
    after: jsonb().$type<Record<string, unknown>>(),
    /** Bookkeeping of undo/redo (e.g. the wiki version an undo wrote). */
    state: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    undoableUntil: timestamp({ withTimezone: true }).notNull(),
    undoneAt: timestamp({ withTimezone: true }),
    undoneByUserId: text(),
    redoneAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    index().on(t.orgId, t.messageId),
    index().on(t.runId),
  ],
);

/**
 * What an agent may do: one row per granted scope (docs/adr/0015, 0016).
 * `connection_id` null = a built-in tool scope (e.g. `context:read`);
 * otherwise a scope of one org connector connection (e.g. `github:pr.merge`).
 * The Tool Gateway checks this table on every call; prompts never matter.
 */
export const agentScopes = pgTable(
  "agent_scopes",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    connectionId: uuid(),
    scope: text().notNull(),
    grantedByUserId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    unique().on(t.agentId, t.connectionId, t.scope).nullsNotDistinct(),
  ],
);

/**
 * The GitHub repositories an agent may use (`owner/name`, or `owner/*` for a
 * whole account), in order: the first is where it starts when nobody names
 * one. No rows = every repository the organization's GitHub reaches. The git
 * proxy and the Tool Gateway check it on every call (reads included).
 */
export const agentRepositories = pgTable(
  "agent_repositories",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    repo: text().notNull(),
    position: integer().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    unique().on(t.agentId, t.repo),
  ],
);

export const agentQuestionStatusEnum = pgEnum("agent_question_status", [
  "open",
  "answered",
  "expired",
  /** Its run was canceled. */
  "canceled",
]);

/**
 * A question an agent asked a person (`ask_user`). The run waits
 * (`waiting_input`) until someone answers in the thread or through the API,
 * or the question expires; the answer goes back to the model as the tool
 * result.
 */
export const agentQuestions = pgTable(
  "agent_questions",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    runId: uuid()
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    channelId: uuid().notNull(),
    /** Thread it was asked in; null = the main timeline (flat DMs). */
    threadId: uuid(),
    /** The chat message carrying the question. */
    messageId: uuid(),
    toolUseId: text().notNull(),
    text: text().notNull(),
    choices: text().array(),
    status: agentQuestionStatusEnum().notNull().default("open"),
    answer: text(),
    answeredByUserId: text(),
    answeredAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    unique().on(t.runId, t.toolUseId),
    index().on(t.channelId, t.status),
    index().on(t.expiresAt).where(sql`${t.status} = 'open'`),
  ],
);

export const agentConsultationStatusEnum = pgEnum("agent_consultation_status", [
  "open",
  "answered",
  "expired",
  "failed",
]);

/**
 * One agent asking another (`ask_agent`, ADR 0034): the question goes to a
 * private DM between the two agents, the consulted agent runs there, and its
 * reply resumes the asking run (the tool call's `waitId`).
 */
export const agentConsultations = pgTable(
  "agent_consultations",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    /** The asking run, paused on `waitId` until the answer. */
    askerRunId: uuid()
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    askerAgentId: uuid().notNull(),
    targetAgentId: uuid().notNull(),
    /** The private DM between the two agents. */
    channelId: uuid().notNull(),
    /** The question as posted there (the consulted run's trigger). */
    messageId: uuid().notNull(),
    targetRunId: uuid(),
    waitId: text().notNull(),
    question: text().notNull(),
    /** Agents already in this chain of consultations (no cycles). */
    chain: uuid().array().notNull(),
    status: agentConsultationStatusEnum().notNull().default("open"),
    answer: text(),
    answeredAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.askerAgentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    foreignKey({ columns: [t.orgId, t.targetAgentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    unique().on(t.messageId),
    index().on(t.askerRunId),
    index().on(t.expiresAt).where(sql`${t.status} = 'open'`),
  ],
);

export const secretRequestStatusEnum = pgEnum("secret_request_status", [
  "pending",
  "delivered",
  "declined",
  "expired",
  "canceled",
]);

/**
 * An agent asked a person for a secret for its computer (ADR 0027). The value
 * never comes here: the browser seals it to `publicKey` (made on the
 * computer, which keeps the private key) and we only relay the box. No column
 * holds the value or the box, on purpose.
 */
export const secretRequests = pgTable(
  "secret_requests",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    runId: uuid()
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    channelId: uuid().notNull(),
    /** Thread it was asked in; null = the main timeline (flat DMs). */
    threadId: uuid(),
    /** The chat message carrying the card. */
    messageId: uuid(),
    toolUseId: text().notNull(),
    /** The only person who may answer: whoever started the run. */
    requestedForUserId: text().notNull(),
    /** `GITHUB_TOKEN`… */
    name: text().notNull(),
    purpose: text().notNull(),
    targetKind: text().notNull().$type<"env" | "file">(),
    targetPath: text(),
    /** The connected machine holding the key; null = the agent's cloud computer. */
    machineId: uuid(),
    /**
     * For a password the agent's browser types (ADR 0040): the only site
     * (`https://host[:port]`) it may be typed on. Shown to the person.
     */
    site: text(),
    /** The computer's public key for this request (raw P-256, base64). */
    publicKey: text().notNull(),
    status: secretRequestStatusEnum().notNull().default("pending"),
    deliveredAt: timestamp({ withTimezone: true }),
    deliveredSize: integer(),
    /** Removed from the computer (the row stays for the record). */
    removedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    unique().on(t.runId, t.toolUseId),
    index().on(t.agentId, t.status),
    index().on(t.expiresAt).where(sql`${t.status} = 'pending'`),
  ],
);

/**
 * Background tasks on a connected machine (ADR 0029 section 4): started by an
 * agent's `start_task`, run detached by the runner, and finished by its
 * `task.done`, which wakes the conversation. `interrupted`: the process went
 * away without an exit (the machine went offline); `ended_at` null means it
 * may still come back or be resumed, set means that was final.
 */
export const machineTaskStatusEnum = pgEnum("machine_task_status", [
  "queued",
  "running",
  "interrupted",
  "done",
  "failed",
  "canceled",
]);

export const machineTasks = pgTable(
  "machine_tasks",
  {
    /** Also the runner's task id. */
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    machineId: uuid()
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    channelId: uuid().notNull(),
    /** The thread it reports to; null = the main timeline (a flat DM). */
    threadRootId: uuid(),
    /** The run whose `start_task` started it (null: resumed by the server). */
    runId: uuid().references(() => agentRuns.id, { onDelete: "set null" }),
    /** The person behind that run (who the agent works for); null for routines and other agents' chains. */
    requestedByUserId: text(),
    /** A mission's task (its main session or an item's): its end goes to the mission, not to an agent run. */
    missionId: uuid().references(() => missions.id, { onDelete: "set null" }),
    title: text().notNull(),
    /** `claude`, `codex` or `shell`. */
    executor: text().notNull(),
    /** What the runner ran (capped); never secrets of ours. */
    command: text().notNull().default(""),
    /** The prompt for an executor (kept to resume it); capped. */
    prompt: text(),
    /** Claude Code's session (the thread id), resumed after an interruption. */
    sessionId: text(),
    branch: text(),
    /** Where it ran, relative to the agent's folder. */
    cwd: text(),
    status: machineTaskStatusEnum().notNull().default("queued"),
    exitCode: integer(),
    signal: text(),
    seconds: integer(),
    lastLine: text(),
    /**
     * The latest human lines (at most 50, oldest first), from `task.event`:
     * "Ver saída" when the computer is offline. Throttled like the events.
     */
    recentLines: jsonb().$type<string[]>().notNull().default([]),
    /** A pull request the task opened (from the executor's tools or its output). */
    prUrl: text(),
    /** Files it touched (relative paths, at most 50). */
    files: jsonb().$type<string[]>().notNull().default([]),
    /** The executor's final answer or the last lines of output (capped). */
    result: text(),
    /** `agent:<runId>` or a person's id, when someone canceled it. */
    canceledBy: text(),
    /** The task this one resumes after an interruption, and how many resumes the chain had. */
    resumedFromId: uuid(),
    resumedTaskId: uuid(),
    resumeCount: integer().notNull().default(0),
    /**
     * A mission task's executor stopped to wait for people (a blocking
     * `ask_decision`, `request_review` or `request_approval`): `decision`,
     * `review` or `approval`. Its end then means "waiting", not "done".
     */
    waitingFor: text(),
    /**
     * A mission task's kind (ADR 0044): `write` (one at a time in the
     * mission's folder, ending in a commit), `read` (in parallel, read only)
     * or `setup` (prepares the folder); null for other tasks. Validated in code.
     */
    mode: text(),
    /** `HEAD` when a write item started and after its commit at the end (equal: nothing changed). */
    startSha: text(),
    endSha: text(),
    /**
     * A task waiting in our queue (status `queued`): what to send the runner
     * when it may start (its mission's folder is free, the computer has a
     * slot or is back). Cleared when it is claimed to start.
     */
    startRequest: jsonb().$type<Record<string, unknown>>(),
    /** The conversation was woken for its end (the `machine.task_done` job ran). */
    wokeAt: timestamp({ withTimezone: true }),
    startedAt: timestamp({ withTimezone: true }),
    endedAt: timestamp({ withTimezone: true }),
    lastEventAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    index().on(t.machineId, t.status),
    index().on(t.orgId, t.agentId, t.createdAt),
    index().on(t.orgId, t.channelId, t.threadRootId),
    index().on(t.missionId),
    // One live task per mission session: two resumes of the same session never run at once (ADR 0029).
    uniqueIndex("machine_tasks_live_session")
      .on(t.missionId, t.sessionId)
      .where(sql`${t.missionId} is not null and ${t.sessionId} is not null and ${t.endedAt} is null`),
  ],
);

/**
 * An agent's request for a folder on its connected computer (ADR 0036 §8,
 * `request_folder_access`). The person decides on the machine; the runner
 * reports `access.decided`, and the server posts the outcome in the thread
 * the request came from and wakes the agent there (`woke_at`, once).
 */
export const machineAccessRequests = pgTable(
  "machine_access_requests",
  {
    /** Also the runner's request id. */
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid().notNull(),
    agentId: uuid().notNull(),
    machineId: uuid()
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    /** Where the agent asked: the outcome is posted there and wakes it there. */
    channelId: uuid().notNull(),
    /** The thread; null = the main timeline (a flat DM). */
    threadRootId: uuid(),
    runId: uuid().references(() => agentRuns.id, { onDelete: "set null" }),
    /** The person the agent worked for (the woken run's audience). */
    requestedByUserId: text(),
    /** Absolute path on the machine, as the agent asked for it. */
    path: text().notNull(),
    reason: text().notNull().default(""),
    /** `pending`, `granted`, `denied`, `expired` or `failed` (never reached the machine). */
    status: text().notNull().default("pending"),
    /** `agent` or `all` when granted. */
    scope: text(),
    decidedAt: timestamp({ withTimezone: true }),
    /** The outcome was posted and the agent woken (the `machine.access_decided` job ran). */
    wokeAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
    index().on(t.machineId, t.status),
    index().on(t.orgId, t.agentId, t.createdAt),
  ],
);

/**
 * Tokens of the runner's `agentes` MCP bridge (ADR 0032): issued when a
 * computer-brain run or a mission task starts, bound to the org, agent,
 * machine and that run (or task). The runner sends it with every tool call;
 * the server checks the hash, the machine, the expiry and that the run (or
 * task) is still live. Stored as SHA-256 only.
 */
export const runToolTokens = pgTable(
  "run_tool_tokens",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    machineId: uuid()
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    /** The run it acts for (a computer-brain turn); null for a mission task started by the server. */
    runId: uuid().references(() => agentRuns.id, { onDelete: "cascade" }),
    /** The mission task it acts for (its tools are the mission's); null for a run. */
    taskId: uuid().references(() => machineTasks.id, { onDelete: "cascade" }),
    /** SHA-256 (hex) of `agr_…`. */
    tokenHash: text().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.runId), index().on(t.taskId)],
);
