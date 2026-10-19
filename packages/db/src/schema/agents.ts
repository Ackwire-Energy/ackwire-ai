import { sql } from "drizzle-orm";
import { bigint, boolean, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { machines } from "./machines";
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
    /**
     * Provider account scoping sent with every call, e.g. Anthropic's
     * `anthropic-workspace-id` for keys not scoped to a workspace. Not secret.
     */
    workspaceId: text(),
    /** Other provider options sent with calls, e.g. OpenAI `{ organization, project }`. Not secret. */
    options: jsonb().$type<{ organization?: string; project?: string }>().notNull().default({}),
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
    /** Spend cap per calendar month (UTC) in nano-USD (1e-9 USD). Null = the organization's default (`organization_settings.default_agent_budget_nano_usd`). */
    monthlyBudgetNanoUsd: bigint({ mode: "number" }),
    /**
     * Who can talk to it (D31): `everyone`, `people` (`audience_user_ids`,
     * plus the owner) or `owner`. Enforced wherever a person's message can
     * start a run; nothing else is restricted (it still reads the channel).
     */
    audienceMode: text().$type<"everyone" | "people" | "owner">().notNull().default("everyone"),
    audienceUserIds: text().array().notNull().default(sql`'{}'::text[]`),
    /** Its look in the app (color, eyes, accessory from a fixed allow-list). Null = the default look. */
    appearance: jsonb().$type<{ color: string; eyes: string; accessory: string }>(),
    /** Its computer (ADR 0025): null = the cloud computer (Daytona); set = that connected machine. */
    machineId: uuid(),
    /**
     * The autonomy its new missions start with (`always | low_risk_auto |
     * never`, validated in code; "Usar como padrão"). Null = `low_risk_auto`.
     */
    missionCommandApproval: text(),
    /**
     * Who thinks for it (ADR 0032): `model` (the API, default), `claude_code`
     * or `codex` on its computer; validated in code (`brain-settings.ts`).
     */
    brain: text().notNull().default("model"),
    /** The computer brain's model (`opus`, `sonnet`, `haiku`, a Codex model); null = the brain's default. */
    brainModel: text(),
    /** When the computer brain can't answer, answer through the API (counts against the budget). */
    brainFallback: boolean().notNull().default(true),
    /** Sites its browser may open (ADR 0040, `*.example.com` matches the domain too); null = any site. */
    browserAllowedDomains: text().array(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique().on(t.orgId, t.handle),
    unique().on(t.orgId, t.id),
    // Machines are only soft-deleted (and `deleteMachine` clears this column first).
    foreignKey({ columns: [t.orgId, t.machineId], foreignColumns: [machines.orgId, machines.id] }),
  ],
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
  /** The default key per provider (`{ anthropic: id, openai: id }`); wins over `default_credential_id`. */
  defaultCredentialIds: jsonb().$type<Partial<Record<string, string>>>().notNull().default({}),
  /** Router model for this organization (catalog id). Null = `ROUTER_MODEL` of the deployment. */
  routerModel: text(),
  /** Model that writes thread/period summaries. Null = `SUMMARY_MODEL` of the deployment. */
  summaryModel: text(),
  /** IANA time zone used as the default for routines, e.g. `America/Sao_Paulo`. */
  timezone: text().notNull().default("UTC"),
  /** From onboarding: `solo`, `small`, `medium` or `large`. */
  teamSize: text(),
  /**
   * Monthly budget of every agent without one of its own (`agents.monthly_budget_nano_usd`
   * null), in nano-USD. Set by admins; members only ever see percentages.
   */
  defaultAgentBudgetNanoUsd: bigint({ mode: "number" }).notNull().default(50_000_000_000),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
