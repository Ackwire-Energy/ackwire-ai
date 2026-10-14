import { bigint, index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";

/**
 * API keys of model providers, owned by the organization (BYOK). Never
 * returned to any client. Envelope encryption (docs/adr/0007-provider-credentials.md):
 * the secret is encrypted with a random per-credential data key (AES-256-GCM),
 * and the data key is wrapped by the key-encryption key named in `kekId`
 * (self-host: derived from AGENTES_SECRET; Cloud: a KMS key, via the
 * `KeyWrapper` adapter). Both ciphertexts are bound to (org_id, id).
 */
export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Provider id from `PROVIDERS` in `@agenteschat/providers` (text, so new providers need no migration). */
    provider: text().notNull(),
    label: text().notNull(),
    /** `v1.<iv>.<ciphertext>.<tag>` of the API key, under the data key. */
    secretCiphertext: text().notNull(),
    /** The data key, wrapped by the key-encryption key. */
    wrappedDataKey: text().notNull(),
    /** Which key-encryption key wrapped the data key, e.g. `local:v1`. Enables rotation. */
    kekId: text().notNull(),
    /** Last 4 characters of the key, so people can tell keys apart. */
    keyHint: text().notNull(),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.orgId)],
);

/**
 * An AI agent: a member of the organization that is not a person. Agents are
 * not Better Auth users; messages have a polymorphic author instead.
 */
export const agents = pgTable(
  "agents",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** Lower-case handle used in @mentions, unique per organization. */
    handle: text().notNull(),
    /** Short job title, e.g. "Developer" or "Support". */
    role: text().notNull().default(""),
    /** Standing instructions, part of the system prompt. */
    instructions: text().notNull().default(""),
    /** Model id from the catalog in `@agenteschat/providers`. */
    model: text().notNull(),
    /**
     * Provider credential this agent bills to. Null = the platform key, which
     * only exists when a module (Cloud) provides one; otherwise calls fail.
     */
    credentialId: uuid().references(() => providerCredentials.id, { onDelete: "set null" }),
    /** Person accountable for this agent (receives approvals, budget alerts). */
    ownerUserId: text().references(() => users.id, { onDelete: "set null" }),
    /** Spend cap per calendar month (UTC) in nano-USD (1e-9 USD). Null = no cap. */
    monthlyBudgetNanoUsd: bigint({ mode: "number" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [unique().on(t.orgId, t.handle), unique().on(t.orgId, t.id)],
);

/**
 * Organization-wide settings that reference other tables (kept out of
 * `organizations` to avoid a schema import cycle). One row per organization,
 * created on first write.
 */
export const organizationSettings = pgTable("organization_settings", {
  orgId: uuid()
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /**
   * Credential that pays for calls made for the organization rather than an
   * agent: router, summaries. Null = newest active credential of the provider,
   * then the platform key (Cloud).
   */
  defaultCredentialId: uuid().references(() => providerCredentials.id, { onDelete: "set null" }),
  /** Router model for this organization (catalog id). Null = `ROUTER_MODEL` of the deployment. */
  routerModel: text(),
  /** Model that writes thread/period summaries. Null = `SUMMARY_MODEL` of the deployment. */
  summaryModel: text(),
  /** IANA time zone used as the default for routines, e.g. `America/Sao_Paulo`. */
  timezone: text().notNull().default("UTC"),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
