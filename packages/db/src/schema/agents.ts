import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth";
import { machineAccounts, machines } from "./machines";
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
 * A named group of the workspace's agents, shared by everyone in it (ADR 0080): the sidebar's sections.
 * An agent is in at most one (`agents.group_id`).
 */
export const agentGroups = pgTable(
  "agent_groups",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** Order among the workspace's groups. */
    position: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId, t.position)],
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
     * Who can talk to it: `everyone`, `people` (`audience_user_ids`,
     * plus the owner) or `owner`. Enforced wherever a person's message can
     * start a run; nothing else is restricted (it still reads the channel).
     */
    audienceMode: text().$type<"everyone" | "people" | "owner">().notNull().default("everyone"),
    audienceUserIds: text().array().notNull().default(sql`'{}'::text[]`),
    /** Its look in the app (color, eyes, accessory from a fixed allow-list). Null = the default look. */
    appearance: jsonb().$type<{ color: string; eyes: string; accessory: string }>(),
    /**
     * Its computer (ADR 0025): the connected machine it works on; null = none yet (the workspace's own computer
     * takes the agents with none once it connects).
     */
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
    /**
     * The account its computer brain runs with (ADR 0041), on its machine and
     * of its brain's kind (checked in code); null = the computer's own sign-in.
     * Cleared when the agent changes computer or brain kind, or the account goes.
     * An account thinks for one agent at most (ADR 0059 §2).
     */
    brainAccountId: uuid(),
    /** How hard its computer brain thinks (`low`…`max`, ADR 0041); null = the CLI's default. */
    brainEffort: text(),
    /** Sites its browser may open (ADR 0040, `*.example.com` matches the domain too); null = any site. */
    browserAllowedDomains: text().array(),
    /**
     * The connected computer its browser last ran on (ADR 0040): a mission's
     * or its own. The live view, take over and Stop follow it.
     */
    browserMachineId: uuid(),
    /**
     * Held by the people who run this server (operator API, ADR 0056): it starts nothing, the rest of the
     * workspace works (`standing.ts`). The reason is theirs: the workspace only reads that it is paused.
     */
    operatorHoldAt: timestamp({ withTimezone: true }),
    operatorHoldReason: text(),
    /** Its group in the sidebar (ADR 0080); null = none. Deleting the group sets it back to null. */
    groupId: uuid().references(() => agentGroups.id, { onDelete: "set null" }),
    /** Order inside its group. */
    groupPosition: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp({ withTimezone: true }),
    /**
     * Deleted for good (ADR 0082): a tombstone, archived too, keeping only its name, role and look for what it
     * left behind (messages, usage, audit). Its handle becomes `deleted-<id>`, longer than any handle people
     * pick, so the old one is free again.
     */
    deletedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique().on(t.orgId, t.handle),
    unique().on(t.orgId, t.id),
    // Machines are only soft-deleted (and `deleteMachine` clears this column first).
    foreignKey({ columns: [t.orgId, t.machineId], foreignColumns: [machines.orgId, machines.id] }),
    // No action (a composite SET NULL would null `org_id` too): code clears it before an account row goes.
    foreignKey({
      columns: [t.orgId, t.brainAccountId],
      foreignColumns: [machineAccounts.orgId, machineAccounts.id],
    }),
    uniqueIndex("agents_brain_account_unique")
      .on(t.orgId, t.brainAccountId)
      .where(sql`${t.brainAccountId} is not null and ${t.archivedAt} is null`),
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
  /** Agents check what the team already did before an outside action (ADR 0064). On unless an admin turns it off. */
  actionCheck: boolean().notNull().default(true),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
