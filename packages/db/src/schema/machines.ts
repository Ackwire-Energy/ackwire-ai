import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";

/** What `hello` says about the coding CLIs on the machine (ADR 0025, protocol 7) and its browser (protocol 12). */
export interface MachineExecutors {
  /** `loggedIn`/`authMethod`/`plan`: from `claude auth status` (protocol 8; absent = unknown). */
  claude?: { version: string; loggedIn?: boolean; authMethod?: string; plan?: string };
  codex?: { version: string };
  /** `hello.browser` (ADR 0040): whether the agent browser can run there; absent = not reported. */
  browser?: { available: boolean; version?: string; chrome?: string; reason?: string };
  detectedAt?: string;
}

/**
 * What the machine allows beyond the agents' own folders (ADR 0036 §8,
 * protocol 10), as its runner last reported it (`hello.access`,
 * `access.changed`). The same shape as `RunnerAccess` in the machine protocol.
 */
export interface MachineAccess {
  folders: { path: string; agents: string[] }[];
  tools: { claude: boolean; codex: boolean; commands: boolean; browser?: boolean };
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
    /**
     * The owner paused this computer (ADR 0036 §6, protocol 9): no new work
     * goes to it. `paused_until` null with `paused`: until they resume. A
     * past `paused_until` means it is no longer paused.
     */
    paused: boolean().notNull().default(false),
    pausedUntil: timestamp({ withTimezone: true }),
    /** Folders and tools the machine allows (protocol 10); null: its runner doesn't report them. */
    access: jsonb().$type<MachineAccess>(),
    /** A background task interrupted by the machine going away resumes by itself when it comes back (ADR 0029). */
    resumeTasks: boolean().notNull().default(true),
    /**
     * Agents that used this computer when it was removed (set by the removal,
     * which points them back to the cloud). Reconnecting the same computer
     * gives it back to those that still have none, then clears this.
     */
    previousAgentIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
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

/**
 * Accounts of the computer brains on a machine (ADR 0041): a folder on the
 * computer (`<runner home>/accounts/<kind>/<id>`) where Claude Code or Codex
 * keeps its own sign-in. Nothing secret here: what the CLI's status command
 * says (email, plan) and whether it is still signed in. `id` is the folder's
 * name (made by the server, or by the desktop app's runner), so it is unique
 * per organization; the runner's `hello.accounts` keeps the rows in sync.
 */
export const machineAccounts = pgTable(
  "machine_accounts",
  {
    id: uuid().notNull(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: uuid().notNull(),
    /** `claude_code` or `codex` (validated in code). */
    kind: text().notNull(),
    /** What people call it ("Trabalho"); the email when nobody named it. */
    label: text().notNull(),
    email: text(),
    /** `pro`, `max`, `team`, `plus`… as the CLI says. */
    plan: text(),
    /** `active` or `signed_out` (the CLI refused the sign-in, or said it isn't signed in). */
    status: text().notNull().default("active"),
    /** Who added it from the app; null when the runner reported it first (the desktop app). */
    createdBy: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.id] }),
    foreignKey({ columns: [t.orgId, t.machineId], foreignColumns: [machines.orgId, machines.id] }).onDelete("cascade"),
    index().on(t.orgId, t.machineId),
  ],
);

/**
 * Connecting a computer (ADR 0036 §5, a device-code flow): the computer asks
 * for a code (`POST /api/machines/device`), a signed-in person confirms it on
 * the site for one of their organizations, and the computer polls until it
 * gets its token, once. `device_code` is stored as SHA-256 only; `user_code`
 * is only compared by people. `org_id` is set on confirm (null while pending).
 */
export const machineDeviceCodes = pgTable(
  "machine_device_codes",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    /** The organization chosen on confirm; null until then. */
    orgId: uuid().references(() => organizations.id, { onDelete: "cascade" }),
    deviceCodeHash: text().notNull().unique(),
    /** 6 characters, normalized (no separator). Unique among pending codes. */
    userCode: text().notNull(),
    /** `pending`, `confirmed`, `denied` or `redeemed` (expiry comes from `expires_at`). */
    status: text().notNull().default("pending"),
    /** What the computer said about itself. */
    name: text().notNull().default(""),
    os: text().notNull().default("other"),
    arch: text().notNull().default(""),
    hostname: text().notNull().default(""),
    runnerVersion: text().notNull().default(""),
    /** Optional extras a runner may send (copied to the machine row). */
    protocol: integer(),
    workspace: text(),
    execAllowed: boolean(),
    /** Where the request came from (rate limits, the confirm page). */
    requesterIp: text().notNull().default(""),
    approxLocation: text(),
    confirmedByUserId: text().references(() => users.id, { onDelete: "set null" }),
    /**
     * The computer asks to come back as this machine (it was refused: removed
     * or its token revoked). Honoured on confirm only for a machine of the
     * chosen organization that the confirming person may manage; else a new one.
     */
    previousMachineId: uuid(),
    /** The machine made (or reconnected) on confirm; its token is issued when the computer polls. */
    machineId: uuid(),
    lastPolledAt: timestamp({ withTimezone: true }),
    decidedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("machine_device_codes_pending_user_code").on(t.userCode).where(sql`${t.status} = 'pending'`),
    index().on(t.requesterIp, t.createdAt),
  ],
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
