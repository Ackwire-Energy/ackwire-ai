import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents";
import { organizations } from "./tenancy";

/**
 * Each agent's computer (D30): one sandbox per agent, created on first use
 * and shared by all its conversations, so `/workspace` persists. The
 * provider stops it when idle and archives it after days stopped; it is
 * never deleted on its own. `deleted_at` marks rows whose sandbox is gone
 * (deleted by a person, or lost by the provider and recreated).
 */
export const sandboxes = pgTable(
  "sandboxes",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid().notNull(),
    /** `agent:{agentId}`. */
    key: text().notNull(),
    provider: text().notNull(),
    providerId: text().notNull(),
    /** `starting`, `running`, `stopping`, `stopped`, `archived`, `error` or `deleted` (last seen). */
    status: text().notNull(),
    /** `blocked`, `allowlist` or `provider-default`. */
    network: text().notNull().default("blocked"),
    cpu: integer().notNull(),
    memoryGib: integer().notNull(),
    diskGib: integer().notNull(),
    /** Why the last start or stop failed (shown with `status = 'error'`). */
    lastError: text(),
    /** When the org's network setting was last applied to this computer (re-applied on start if older). */
    networkAppliedAt: timestamp({ withTimezone: true }),
    /** Git proxy credential (D35): bumping it revokes every token issued to this computer. */
    gitTokenGen: integer().notNull().default(0),
    /** When the computer last got a fresh git proxy token (re-issued on start and every few hours). */
    gitTokenIssuedAt: timestamp({ withTimezone: true }),
    /** Last measured size of the workspace, in MiB. */
    diskUsedMib: integer().notNull().default(0),
    billedSeconds: integer().notNull().default(0),
    costNanoUsd: bigint({ mode: "number" }).notNull().default(0),
    lastUsedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex("sandboxes_one_live_per_key").on(t.orgId, t.key).where(sql`${t.deletedAt} is null`),
    index().on(t.orgId, t.lastUsedAt),
    foreignKey({ columns: [t.orgId, t.agentId], foreignColumns: [agents.orgId, agents.id] }).onDelete("cascade"),
  ],
);

/** The organization's sandbox settings (no row = defaults). */
export const orgSandboxSettings = pgTable("org_sandbox_settings", {
  orgId: uuid()
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  enabled: boolean().notNull().default(true),
  /** Domains sandboxes may reach (`pypi.org`, `*.npmjs.org`), for `network = 'allowlist'`. */
  allowDomains: jsonb().$type<string[]>().notNull().default([]),
  /** `blocked` (no internet), `allowlist` (only `allow_domains`) or `open` (full egress; still no secrets). */
  network: text().$type<"blocked" | "allowlist" | "open">().notNull().default("blocked"),
  /** Default timeout of one command, in seconds. */
  execTimeoutSeconds: integer().notNull().default(60),
  /** Sandbox minutes the whole organization may use per day (UTC). */
  dailyMinutes: integer().notNull().default(120),
  /** Every `run_code` / `run_skill_script` waits for a person's approval. */
  requireApproval: boolean().notNull().default(false),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Sandbox seconds used per organization and day (UTC), for the daily cap. */
export const sandboxUsageDays = pgTable(
  "sandbox_usage_days",
  {
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    day: date({ mode: "string" }).notNull(),
    seconds: integer().notNull().default(0),
    costNanoUsd: bigint({ mode: "number" }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.day] })],
);
