import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId)],
);
