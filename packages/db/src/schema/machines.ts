import { boolean, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";

/** What `hello` says about the coding CLIs on the machine (ADR 0025, protocol 7). */
export interface MachineExecutors {
  claude?: { version: string };
  codex?: { version: string };
  detectedAt?: string;
}

/**
 * Connected computers (ADR 0025): machines people paired, where our runner
 * keeps one outbound WebSocket open. The token is stored as SHA-256 only;
 * deleting a machine (soft) clears it, so the runner is refused at once.
 */
export const machines = pgTable(
  "machines",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    pairedByUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** SHA-256 (hex) of `agm_…`; null once deleted. */
    tokenHash: text().unique(),
    hostname: text().notNull().default(""),
    /** `linux`, `darwin`, `windows` or `other`. */
    os: text().notNull().default("other"),
    arch: text().notNull().default(""),
    runnerVersion: text().notNull().default(""),
    protocol: integer().notNull().default(1),
    /** Absolute path of the workspace on the machine (admins and the pairer only). */
    workspace: text().notNull().default(""),
    /** `false`: the runner was started with `--no-exec` (files and uploads only). */
    execAllowed: boolean().notNull().default(true),
    /**
     * Coding CLIs the runner found on the machine at its last `hello`
     * (`claude`, `codex`: their `--version`), and when it looked. Empty: an
     * older runner that doesn't report them.
     */
    executors: jsonb().$type<MachineExecutors>().notNull().default({}),
    /** A background task interrupted by the machine going away resumes by itself when it comes back (ADR 0029). */
    resumeTasks: boolean().notNull().default(true),
    /** Last known; trust it only with a recent `last_seen_at` (a replica may have died). */
    online: boolean().notNull().default(false),
    /** The server process holding its socket. */
    connectedReplica: text(),
    lastSeenAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [unique().on(t.orgId, t.id), index().on(t.orgId)],
);

/** One-time pairing codes (10 minutes, single use), stored as SHA-256 of the normalized code. */
export const machinePairings = pgTable(
  "machine_pairings",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    codeHash: text().notNull().unique(),
    name: text().notNull(),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    machineId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId, t.createdAt)],
);

/**
 * A request for a machine whose socket is on another replica: the caller
 * writes it here and signals the holder through pub/sub; the holder runs it
 * and writes the reply (NOTIFY payloads are too small for file bodies).
 */
export const machineRpc = pgTable(
  "machine_rpc",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: uuid().notNull(),
    request: jsonb().$type<Record<string, unknown>>().notNull(),
    reply: jsonb().$type<Record<string, unknown>>(),
    /** `pending`, `done` or `failed`. */
    status: text().notNull().default("pending"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    repliedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.createdAt)],
);
