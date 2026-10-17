import { sql } from "drizzle-orm";
import { bigint, boolean, index, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";
import { organizations } from "./tenancy";

/**
 * An organization's connection to an MCP server (layer 1 of D7: the org
 * connects once; agents get subsets of its scopes in `agent_scopes`).
 * `connector` is a key of the catalog in `@agenteschat/engine`
 * (`CONNECTOR_CATALOG`), which maps each tool to one of our scopes.
 * Credentials (OAuth tokens or an API key, as JSON) are envelope-encrypted
 * like provider credentials and bound to (org_id, id). One active connection
 * per connector per organization.
 */
export const connectorConnections = pgTable(
  "connector_connections",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connector: text().notNull(),
    label: text().notNull(),
    serverUrl: text().notNull(),
    /** `oauth`, `api_key` or `none`. */
    authType: text().notNull(),
    secretCiphertext: text(),
    wrappedDataKey: text(),
    kekId: text(),
    /** When the OAuth access token expires (refreshed before calls). */
    tokenExpiresAt: timestamp({ withTimezone: true }),
    /** Account on the other side, e.g. the GitHub org, for display. */
    accountLabel: text(),
    /** Custom servers: when an admin last saved the tool classification (null = nothing exposed yet). */
    reviewedAt: timestamp({ withTimezone: true }),
    /** MCP-native OAuth: the client registered with the server's authorization server (`oauth_clients`). */
    oauthClientId: uuid(),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex("connector_connections_one_active").on(t.orgId, t.connector).where(sql`${t.revokedAt} is null`),
    index().on(t.orgId),
  ],
);

/**
 * In-flight OAuth authorizations (state + PKCE). Only the SHA-256 of `state`
 * is stored; the PKCE verifier is sealed. Single use, 10-minute lifetime, and
 * bound to the person who started it.
 */
export const oauthStates = pgTable(
  "oauth_states",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connector: text().notNull(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    stateHash: text().notNull().unique(),
    verifierCiphertext: text().notNull(),
    wrappedDataKey: text().notNull(),
    kekId: text().notNull(),
    /** MCP endpoint to store on the connection (connectors without a default URL). */
    serverUrl: text(),
    /** Where the web app wants to land afterwards (a path on our origin). */
    returnTo: text().notNull().default("/"),
    /** MCP-native OAuth: the registered client, the protected resource (RFC 8707) and the label to give the connection. */
    oauthClientId: uuid(),
    resource: text(),
    label: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId)],
);

/**
 * OAuth clients agentes.chat registered with an MCP server's authorization
 * server (Dynamic Client Registration, RFC 7591), one per org and issuer.
 * A client secret, when the server issues one, is sealed like other secrets.
 */
export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    issuer: text().notNull(),
    authorizationEndpoint: text().notNull(),
    tokenEndpoint: text().notNull(),
    clientId: text().notNull(),
    secretCiphertext: text(),
    wrappedDataKey: text(),
    kekId: text(),
    /** Scopes to ask for (from the protected resource metadata), space separated. */
    scope: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("oauth_clients_org_issuer").on(t.orgId, t.issuer)],
);

/**
 * Tools of a custom MCP server and how an admin classified each one:
 * `read`, `write`, or `approval` (write that always asks a person). Null =
 * not classified yet: never shown to agents.
 */
export const customTools = pgTable(
  "custom_tools",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid().notNull(),
    connectionId: uuid()
      .notNull()
      .references(() => connectorConnections.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text().notNull().default(""),
    readOnlyHint: boolean(),
    /** The server's `destructiveHint` annotation, when it sends one. */
    destructiveHint: boolean(),
    /** What we suggest before an admin decides: `read`, `write` or `approval`. */
    suggestedAccess: text(),
    access: text(),
    /** Shown to people (approval cards, permissions), in pt-BR. */
    label: text().notNull().default(""),
    firstSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** The server stopped listing it. */
    removedAt: timestamp({ withTimezone: true }),
    /**
     * Where the suggestion came from: `annotation` (the server's hints), `verb`
     * (the tool's name), `preset` (a one-click server's read-only list),
     * `judge` (the name was ambiguous; the judge's answer, kept as a cache) or
     * `judge_failed` (asked again on the next listing).
     */
    suggestionSource: text(),
    /** A short reason code for the suggestion (the web says it in the person's language). */
    suggestionReason: text(),
    /** Deletes, sends, pays, publishes…: may only ask for approval or be off. */
    sensitive: boolean().notNull().default(false),
    /** A person confirmed the level of an ambiguous tool (until then it waits in "needs your decision"). */
    confirmedAt: timestamp({ withTimezone: true }),
  },
  (t) => [unique().on(t.connectionId, t.name), index().on(t.orgId)],
);

/**
 * Installations of our GitHub App (git and pull requests), each bound to the
 * one organization that installed it from the app. The app is public, so a
 * repository's installation only yields tokens for the org it belongs to;
 * an installation made outside our install flow binds to nobody.
 */
export const githubAppInstallations = pgTable(
  "github_app_installations",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** GitHub's installation id: one installation belongs to one organization. */
    installationId: bigint({ mode: "number" }).notNull().unique(),
    /** The GitHub account it's installed on (user or organization), for display. */
    accountLogin: text().notNull(),
    /** `User` or `Organization`. */
    accountType: text().notNull(),
    /** `all` or `selected`. */
    repositorySelection: text().notNull().default("selected"),
    /** Suspended on GitHub: no tokens until it's unsuspended. */
    suspendedAt: timestamp({ withTimezone: true }),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId)],
);
