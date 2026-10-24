import { createHash } from "node:crypto";
import type { KeyWrapper } from "@agenteschat/adapters";
import { and, asc, type Database, eq, isNull, schema, sql } from "@agenteschat/db";
import { caches } from "../cache";
import { openSecret, randomToken, sealSecret, sha256 } from "../crypto";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { ResolveHost } from "../net-guard";
import { requirePermission } from "../organizations";
import { CONNECTOR_CATALOG, type ConnectorDefinition } from "./catalog";
import { beginMcpOAuth, storeCustomConnection } from "./custom";
import { clientCredentials, getOAuthClient, type McpOAuthDeps, probeMcpServer } from "./oauth-mcp";
import { oauthReturnTo } from "./oauth-return";

const { connectorConnections, oauthStates, agentScopes } = schema;

export type ConnectorConnection = typeof connectorConnections.$inferSelect;

/** OAuth app credentials per connector (from env; real apps are configured per deployment). */
export type OAuthApps = Record<string, { clientId: string; clientSecret: string } | undefined>;

/** What's stored (encrypted) for a connection. Never returned by any API. */
export interface ConnectionSecret {
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
}

export interface ConnectorDeps {
  db: Database;
  /** Current wrapper first (seals), then legacy ones (open only). */
  keyWrappers: KeyWrapper[];
  oauthApps?: OAuthApps;
  /** Public base URL, for the OAuth redirect URI. */
  publicUrl: string;
  /** Injected in tests; real network otherwise. */
  http?: typeof fetch;
  /** DNS for the SSRF guard (tests: fake). */
  resolveHost?: ResolveHost;
  now?: () => Date;
}

const aadFor = (orgId: string, id: string) => `connector-connection|${orgId}|${id}`;
const stateAad = (orgId: string, id: string) => `oauth-state|${orgId}|${id}`;
export const OAUTH_STATE_TTL_MS = 10 * 60_000;
export const oauthRedirectUri = (publicUrl: string) =>
  `${publicUrl.replace(/\/$/, "")}/api/app/connectors/oauth/callback`;

export function connectorDefinition(id: string): ConnectorDefinition {
  const def = CONNECTOR_CATALOG[id];
  if (!def) throw new ValidationError(`Unknown connector ${id}`);
  return def;
}

/** Public view: no secrets. */
export const connectionView = (c: ConnectorConnection) => ({
  id: c.id,
  connector: c.connector,
  label: c.label,
  serverUrl: c.serverUrl,
  authType: c.authType,
  accountLabel: c.accountLabel,
  tokenExpiresAt: c.tokenExpiresAt ? c.tokenExpiresAt.toISOString() : null,
  createdAt: c.createdAt.toISOString(),
  revokedAt: c.revokedAt ? c.revokedAt.toISOString() : null,
});

function checkServerUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError("serverUrl must be a URL");
  }
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && parsed.hostname === "localhost")) {
    throw new ValidationError("serverUrl must use https");
  }
  return parsed.toString();
}

async function storeConnection(
  deps: ConnectorDeps,
  input: {
    orgId: string;
    actorId: string;
    connector: string;
    authType: "oauth" | "api_key" | "none";
    serverUrl: string;
    label?: string;
    secret: ConnectionSecret | null;
    tokenExpiresAt?: Date | null;
    accountLabel?: string | null;
    oauthClientId?: string | null;
  },
): Promise<ConnectorConnection> {
  const def = connectorDefinition(input.connector);
  const wrapper = deps.keyWrappers[0];
  if (!wrapper) throw new Error("no key wrapper");
  const id = crypto.randomUUID();
  const sealed = input.secret ? await sealSecret(wrapper, JSON.stringify(input.secret), aadFor(input.orgId, id)) : null;
  return deps.db.transaction(async (tx) => {
    // One active connection per connector: a new one replaces the old (grants move over).
    const [previous] = await tx
      .update(connectorConnections)
      .set({ revokedAt: deps.now?.() ?? new Date() })
      .where(
        and(
          eq(connectorConnections.orgId, input.orgId),
          eq(connectorConnections.connector, input.connector),
          isNull(connectorConnections.revokedAt),
        ),
      )
      .returning();
    const [row] = await tx
      .insert(connectorConnections)
      .values({
        id,
        orgId: input.orgId,
        connector: input.connector,
        label: input.label?.trim() || def.label,
        serverUrl: input.serverUrl,
        authType: input.authType,
        secretCiphertext: sealed?.ciphertext ?? null,
        wrappedDataKey: sealed?.wrappedDataKey ?? null,
        kekId: sealed?.kekId ?? null,
        tokenExpiresAt: input.tokenExpiresAt ?? null,
        accountLabel: input.accountLabel ?? null,
        oauthClientId: input.oauthClientId ?? null,
        createdByUserId: input.actorId,
      })
      .returning();
    if (!row) throw new Error("connection insert returned nothing");
    if (previous) {
      await tx.update(agentScopes).set({ connectionId: row.id }).where(eq(agentScopes.connectionId, previous.id));
    }
    caches.connections.delete(`${input.orgId}:active`);
    caches.scopes.deletePrefix(`${input.orgId}:`);
    return row;
  });
}

/** Connects with an API key (or a server that needs no auth). Admins only. */
export async function createApiKeyConnection(
  deps: ConnectorDeps,
  actorId: string,
  orgId: string,
  input: { connector: string; apiKey?: string; serverUrl?: string; label?: string },
) {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const def = connectorDefinition(input.connector);
  const serverUrl = checkServerUrl(input.serverUrl ?? def.serverUrl ?? "");
  const apiKey = input.apiKey?.trim();
  if (apiKey !== undefined && apiKey.length < 8) throw new ValidationError("apiKey looks too short");
  return storeConnection(deps, {
    orgId,
    actorId,
    connector: input.connector,
    authType: apiKey ? "api_key" : "none",
    serverUrl,
    label: input.label,
    secret: apiKey ? { apiKey } : null,
  });
}

export async function listConnections(db: Database, actorId: string, orgId: string) {
  await requirePermission(db, actorId, orgId, "read");
  return db
    .select()
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.orgId, orgId),
        isNull(connectorConnections.revokedAt),
        // Custom servers have their own endpoints (`…/connectors/custom`).
        sql`${connectorConnections.connector} not like 'custom:%'`,
      ),
    )
    .orderBy(asc(connectorConnections.createdAt));
}

/** Disconnects: the secret stays sealed but unused; agents lose the connection's scopes. */
/**
 * Best effort: tells the provider to drop our grant too (GitHub OAuth apps:
 * `DELETE /applications/{client_id}/grant`). Never blocks disconnecting.
 */
export async function revokeAtProvider(deps: ConnectorDeps, orgId: string, connectionId: string) {
  const [c] = await deps.db
    .select()
    .from(connectorConnections)
    .where(and(eq(connectorConnections.id, connectionId), eq(connectorConnections.orgId, orgId)));
  if (!c || c.revokedAt || c.connector !== "github" || c.authType !== "oauth") return false;
  const app = deps.oauthApps?.github;
  const secret = await openConnectionSecret(deps.keyWrappers, c).catch(() => null);
  if (!app || !secret?.accessToken) return false;
  const res = await (deps.http ?? fetch)(
    `https://api.github.com/applications/${encodeURIComponent(app.clientId)}/grant`,
    {
      method: "DELETE",
      headers: {
        authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ access_token: secret.accessToken }),
    },
  ).catch(() => null);
  return Boolean(res && (res.status === 204 || res.status === 404));
}

export async function revokeConnection(db: Database, actorId: string, orgId: string, connectionId: string) {
  await requirePermission(db, actorId, orgId, "manage_connectors");
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(connectorConnections)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(connectorConnections.id, connectionId),
          eq(connectorConnections.orgId, orgId),
          isNull(connectorConnections.revokedAt),
        ),
      )
      .returning();
    if (!row) throw new NotFoundError("Connection not found");
    await tx.delete(agentScopes).where(eq(agentScopes.connectionId, connectionId));
  });
  caches.connections.delete(`${orgId}:active`);
  caches.scopes.deletePrefix(`${orgId}:`);
}

export async function activeConnections(db: Database, orgId: string) {
  return caches.connections.getOrLoad(`${orgId}:active`, () => loadActiveConnections(db, orgId)) as Promise<
    ConnectorConnection[]
  >;
}

async function loadActiveConnections(db: Database, orgId: string) {
  return db
    .select()
    .from(connectorConnections)
    .where(and(eq(connectorConnections.orgId, orgId), isNull(connectorConnections.revokedAt)));
}

/** Decrypts a connection's secret. Backend only (the MCP client is its only caller). */
export async function openConnectionSecret(
  keyWrappers: KeyWrapper[],
  c: ConnectorConnection,
): Promise<ConnectionSecret | null> {
  if (!c.secretCiphertext || !c.wrappedDataKey || !c.kekId) return null;
  const json = await openSecret(
    keyWrappers,
    { ciphertext: c.secretCiphertext, wrappedDataKey: c.wrappedDataKey, kekId: c.kekId },
    aadFor(c.orgId, c.id),
  );
  return JSON.parse(json) as ConnectionSecret;
}

// ── OAuth (authorization code + state + PKCE S256) ───────────────────────────

const base64url = (buf: Buffer) => buf.toString("base64url");

/**
 * Starts connecting a connector over OAuth. Returns the provider's authorize
 * URL. State is random and single use (only its hash is stored); the PKCE
 * verifier is sealed. Admins only.
 */
export async function startOAuth(
  deps: ConnectorDeps,
  actorId: string,
  orgId: string,
  connector: string,
  options: { returnTo?: string; serverUrl?: string } = {},
): Promise<{ authorizeUrl: string; state: string }> {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const def = connectorDefinition(connector);
  const app = deps.oauthApps?.[connector];
  const serverUrl = checkServerUrl(options.serverUrl ?? def.serverUrl ?? "");
  if (!def.oauth || !app) {
    // A catalog entry without a fixed OAuth app uses the server's own MCP OAuth (discovery + registration).
    const native =
      def.auth.includes("oauth") && !def.oauth
        ? await nativeAuthorizeUrl(deps, actorId, orgId, connector, serverUrl, options.returnTo)
        : null;
    if (native) return { authorizeUrl: native, state: "" };
    throw new ValidationError(`OAuth for ${def.label} is not configured on this server`);
  }
  const returnTo = oauthReturnTo(options.returnTo);
  const state = randomToken(32);
  const verifier = randomToken(48);
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const wrapper = deps.keyWrappers[0];
  if (!wrapper) throw new Error("no key wrapper");
  const id = crypto.randomUUID();
  const sealed = await sealSecret(wrapper, verifier, stateAad(orgId, id));
  await deps.db.insert(oauthStates).values({
    id,
    orgId,
    connector,
    userId: actorId,
    stateHash: sha256(state),
    verifierCiphertext: sealed.ciphertext,
    wrappedDataKey: sealed.wrappedDataKey,
    kekId: sealed.kekId,
    serverUrl,
    returnTo,
    expiresAt: new Date((deps.now?.() ?? new Date()).getTime() + OAUTH_STATE_TTL_MS),
  });
  const url = new URL(def.oauth.authorizeUrl);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", oauthRedirectUri(deps.publicUrl));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", def.oauth.scopes.join(def.oauth.scopeSeparator ?? " "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (connector === "drive") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  }
  return { authorizeUrl: url.toString(), state };
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function tokenRequest(
  deps: ConnectorDeps,
  url: string,
  form: Record<string, string | undefined>,
): Promise<TokenResponse> {
  const http = deps.http ?? fetch;
  const res = await http(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(
      Object.entries(form).filter((e): e is [string, string] => typeof e[1] === "string"),
    ).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || body.error || !body.access_token) {
    throw new ValidationError(
      `The provider refused the authorization: ${body.error_description ?? body.error ?? res.status}`,
    );
  }
  return body;
}

/**
 * What a state stands for, without using it up: who started it, in which organization, and where it lands.
 * Null when it is unknown, used or expired. The callback reads it to know whether the phone app started
 * the authorization (the app then finishes it with its own session).
 */
export async function peekOAuthState(
  deps: Pick<ConnectorDeps, "db" | "now">,
  state: string,
): Promise<{ orgId: string; userId: string; returnTo: string } | null> {
  const at = deps.now?.() ?? new Date();
  const [row] = await deps.db
    .select({
      orgId: oauthStates.orgId,
      userId: oauthStates.userId,
      returnTo: oauthStates.returnTo,
      usedAt: oauthStates.usedAt,
      expiresAt: oauthStates.expiresAt,
    })
    .from(oauthStates)
    .where(eq(oauthStates.stateHash, sha256(state)));
  if (!row || row.usedAt || row.expiresAt <= at) return null;
  return { orgId: row.orgId, userId: row.userId, returnTo: row.returnTo };
}

/**
 * OAuth callback: checks state (exists, unused, not expired, same person),
 * exchanges the code with the PKCE verifier, and stores the tokens sealed.
 */
export async function completeOAuth(
  deps: ConnectorDeps,
  user: { id: string },
  input: { state: string; code: string },
): Promise<{ connection: ConnectorConnection; returnTo: string }> {
  const at = deps.now?.() ?? new Date();
  const [row] = await deps.db
    .select()
    .from(oauthStates)
    .where(eq(oauthStates.stateHash, sha256(input.state)));
  if (!row || row.usedAt || row.expiresAt <= at)
    throw new ConflictError("This authorization link is invalid or expired");
  if (row.userId !== user.id) throw new ForbiddenError("Finish connecting with the account that started it");
  const claimed = await deps.db
    .update(oauthStates)
    .set({ usedAt: at })
    .where(and(eq(oauthStates.id, row.id), isNull(oauthStates.usedAt)))
    .returning({ id: oauthStates.id });
  if (claimed.length === 0) throw new ConflictError("This authorization link was already used");
  // Still an admin? (Roles can change during the round trip.)
  await requirePermission(deps.db, user.id, row.orgId, "manage_connectors");

  if (row.oauthClientId) return completeMcpOAuth(deps, user, row, input.code, at);
  const def = connectorDefinition(row.connector);
  const app = deps.oauthApps?.[row.connector];
  if (!def.oauth || !app) throw new ValidationError(`OAuth for ${def.label} is not configured on this server`);
  const verifier = await openSecret(
    deps.keyWrappers,
    { ciphertext: row.verifierCiphertext, wrappedDataKey: row.wrappedDataKey, kekId: row.kekId },
    stateAad(row.orgId, row.id),
  );
  const token = await tokenRequest(deps, def.oauth.tokenUrl, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: oauthRedirectUri(deps.publicUrl),
    client_id: app.clientId,
    client_secret: app.clientSecret,
    code_verifier: verifier,
  });
  const connection = await storeConnection(deps, {
    orgId: row.orgId,
    actorId: user.id,
    connector: row.connector,
    authType: "oauth",
    serverUrl: checkServerUrl(row.serverUrl ?? def.serverUrl ?? ""),
    secret: { accessToken: token.access_token, refreshToken: token.refresh_token },
    tokenExpiresAt: token.expires_in ? new Date(at.getTime() + token.expires_in * 1000) : null,
  });
  return { connection, returnTo: row.returnTo };
}

/**
 * Credentials to call a connection's MCP server, refreshing an OAuth token
 * that expires within a minute. Returns the HTTP headers to send.
 */
export async function connectionHeaders(deps: ConnectorDeps, c: ConnectorConnection): Promise<Record<string, string>> {
  const secret = await openConnectionSecret(deps.keyWrappers, c);
  if (!secret) return {};
  if (secret.apiKey) return { authorization: `Bearer ${secret.apiKey}` };
  const at = deps.now?.() ?? new Date();
  const expiring = c.tokenExpiresAt && c.tokenExpiresAt.getTime() - at.getTime() < 60_000 && secret.refreshToken;
  if (expiring && c.oauthClientId && secret.refreshToken) {
    const client = await getOAuthClient(deps.db, c.oauthClientId);
    if (client) {
      const token = await tokenRequest(deps, client.tokenEndpoint, {
        grant_type: "refresh_token",
        refresh_token: secret.refreshToken,
        ...(await clientCredentials(deps.keyWrappers, client)),
      });
      const next: ConnectionSecret = {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? secret.refreshToken,
      };
      await resealTokens(deps, c, next, token.expires_in, at);
      return { authorization: `Bearer ${next.accessToken}` };
    }
  }
  if (expiring && secret.refreshToken && !c.connector.startsWith("custom:")) {
    const def = connectorDefinition(c.connector);
    const app = deps.oauthApps?.[c.connector];
    if (def.oauth && app) {
      const token = await tokenRequest(deps, def.oauth.tokenUrl, {
        grant_type: "refresh_token",
        refresh_token: secret.refreshToken,
        client_id: app.clientId,
        client_secret: app.clientSecret,
      });
      const next: ConnectionSecret = {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? secret.refreshToken,
      };
      const wrapper = deps.keyWrappers[0];
      if (!wrapper) throw new Error("no key wrapper");
      const sealed = await sealSecret(wrapper, JSON.stringify(next), aadFor(c.orgId, c.id));
      await deps.db
        .update(connectorConnections)
        .set({
          secretCiphertext: sealed.ciphertext,
          wrappedDataKey: sealed.wrappedDataKey,
          kekId: sealed.kekId,
          tokenExpiresAt: token.expires_in ? new Date(at.getTime() + token.expires_in * 1000) : null,
          updatedAt: at,
        })
        .where(eq(connectorConnections.id, c.id));
      caches.connections.delete(`${c.orgId}:active`);
      return { authorization: `Bearer ${next.accessToken}` };
    }
  }
  return secret.accessToken ? { authorization: `Bearer ${secret.accessToken}` } : {};
}

/** Validates a connector grant: the connection is active in the org and the scope is in its catalog. */
export const connectorGrantValidator = async (
  db: Database,
  orgId: string,
  grant: { connectionId: string | null; scope: string },
): Promise<string | null> => {
  if (!grant.connectionId) return null;
  const [c] = await db
    .select()
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.id, grant.connectionId),
        eq(connectorConnections.orgId, orgId),
        isNull(connectorConnections.revokedAt),
      ),
    );
  if (!c) return "connectionId is not an active connection of this organization";
  if (c.connector.startsWith("custom:")) {
    return grant.scope === `custom:${c.id}:read` || grant.scope === `custom:${c.id}:write`
      ? null
      : `Unknown scope ${grant.scope} for this server`;
  }
  const def = CONNECTOR_CATALOG[c.connector];
  const [prefix, scope] = grant.scope.split(":");
  if (!def || prefix !== c.connector || !scope || !def.scopes[scope]) {
    return `Unknown scope ${grant.scope} for ${c.connector}`;
  }
  return null;
};

async function resealTokens(
  deps: ConnectorDeps,
  c: ConnectorConnection,
  next: ConnectionSecret,
  expiresIn: number | undefined,
  at: Date,
) {
  const wrapper = deps.keyWrappers[0];
  if (!wrapper) throw new Error("no key wrapper");
  const sealed = await sealSecret(wrapper, JSON.stringify(next), aadFor(c.orgId, c.id));
  await deps.db
    .update(connectorConnections)
    .set({
      secretCiphertext: sealed.ciphertext,
      wrappedDataKey: sealed.wrappedDataKey,
      kekId: sealed.kekId,
      tokenExpiresAt: expiresIn ? new Date(at.getTime() + expiresIn * 1000) : null,
      updatedAt: at,
    })
    .where(eq(connectorConnections.id, c.id));
  caches.connections.delete(`${c.orgId}:active`);
}

/** Catalog connector without a registered app: the server's own MCP OAuth, if it has one. */
async function nativeAuthorizeUrl(
  deps: ConnectorDeps & McpOAuthDeps,
  actorId: string,
  orgId: string,
  connector: string,
  serverUrl: string,
  returnTo?: string,
) {
  const probe = await probeMcpServer(deps, serverUrl).catch(() => null);
  if (probe?.kind !== "oauth") return null;
  return beginMcpOAuth(deps, actorId, orgId, {
    connector,
    serverUrl,
    resource: probe.resource,
    issuer: probe.issuer,
    scopes: probe.scopes,
    returnTo,
  });
}

/** Callback of an MCP-native authorization: token with PKCE and `resource`, then the connection. */
async function completeMcpOAuth(
  deps: ConnectorDeps,
  user: { id: string },
  row: typeof oauthStates.$inferSelect,
  code: string,
  at: Date,
): Promise<{ connection: ConnectorConnection; returnTo: string }> {
  const client = row.oauthClientId ? await getOAuthClient(deps.db, row.oauthClientId) : null;
  if (!client) throw new ValidationError("The authorization server registration is missing");
  const verifier = await openSecret(
    deps.keyWrappers,
    { ciphertext: row.verifierCiphertext, wrappedDataKey: row.wrappedDataKey, kekId: row.kekId },
    stateAad(row.orgId, row.id),
  );
  const token = await tokenRequest(deps, client.tokenEndpoint, {
    grant_type: "authorization_code",
    code,
    redirect_uri: oauthRedirectUri(deps.publicUrl),
    code_verifier: verifier,
    ...(row.resource ? { resource: row.resource } : {}),
    ...(await clientCredentials(deps.keyWrappers, client)),
  });
  const secret = { accessToken: token.access_token, refreshToken: token.refresh_token };
  const tokenExpiresAt = token.expires_in ? new Date(at.getTime() + token.expires_in * 1000) : null;
  const serverUrl = row.serverUrl ?? "";
  if (row.connector === "custom") {
    const connection = await storeCustomConnection(deps, {
      orgId: row.orgId,
      actorId: user.id,
      serverUrl,
      label: row.label ?? new URL(serverUrl).hostname,
      authType: "oauth",
      secret,
      tokenExpiresAt,
      oauthClientId: client.id,
    });
    return { connection, returnTo: row.returnTo };
  }
  const connection = await storeConnection(deps, {
    orgId: row.orgId,
    actorId: user.id,
    connector: row.connector,
    authType: "oauth",
    serverUrl: checkServerUrl(serverUrl),
    secret,
    tokenExpiresAt,
    oauthClientId: client.id,
  });
  return { connection, returnTo: row.returnTo };
}
