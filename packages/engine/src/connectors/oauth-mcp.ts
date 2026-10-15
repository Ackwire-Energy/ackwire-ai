import { and, type Database, eq, schema } from "@agenteschat/db";
import { openSecret, sealSecret } from "../crypto";
import { ValidationError } from "../errors";
import { assertPublicHttpsUrl, type ResolveHost } from "../net-guard";
import type { ConnectorDeps } from "./connections";

const { oauthClients } = schema;

/**
 * MCP-native OAuth (MCP authorization spec): discovery from the server's
 * `401` (`WWW-Authenticate: Bearer resource_metadata=…`) or its
 * `/.well-known/oauth-protected-resource`, the authorization server's
 * metadata (RFC 8414, then OpenID discovery), Dynamic Client Registration
 * (RFC 7591), and PKCE S256 with the `resource` indicator (RFC 8707). Every
 * URL we fetch passes the SSRF guard.
 */
export interface McpOAuthDeps extends ConnectorDeps {
  resolveHost?: ResolveHost;
}

export type ServerProbe =
  /** Answered without credentials: no auth needed. */
  | { kind: "open" }
  /** Needs OAuth, and we know where. */
  | { kind: "oauth"; resource: string; issuer: string; scopes: string[] }
  /** Needs credentials we can't get by OAuth (or doesn't say): ask for an API key. */
  | { kind: "needs_key" };

export interface AuthServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

const http = (deps: McpOAuthDeps) => deps.http ?? fetch;

async function getJson(deps: McpOAuthDeps, url: string): Promise<Record<string, unknown> | null> {
  await assertPublicHttpsUrl(url, deps.resolveHost);
  try {
    const res = await http(deps)(url, { headers: { accept: "application/json" }, redirect: "error" });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The canonical resource URI of an MCP server (RFC 8707): no fragment, no trailing slash. */
export function canonicalResource(serverUrl: string) {
  const u = new URL(serverUrl);
  u.hash = "";
  return u.toString().replace(/\/$/, "");
}

/** Asks the server who it is without credentials and reads where its OAuth lives. */
export async function probeMcpServer(deps: McpOAuthDeps, serverUrl: string): Promise<ServerProbe> {
  await assertPublicHttpsUrl(serverUrl, deps.resolveHost);
  let res: Response;
  try {
    res = await http(deps)(serverUrl, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agentes.chat", version: "1" } },
      }),
    });
  } catch {
    throw new ValidationError("Não foi possível conectar ao servidor MCP.");
  }
  if (res.status !== 401 && res.status !== 403) {
    if (res.ok) return { kind: "open" };
    throw new ValidationError(`O servidor MCP respondeu ${res.status}.`);
  }
  const header = res.headers.get("www-authenticate") ?? "";
  const fromHeader = /resource_metadata="([^"]+)"/.exec(header)?.[1];
  const base = new URL(serverUrl);
  const path = base.pathname.replace(/\/$/, "");
  const candidates = [
    ...(fromHeader ? [fromHeader] : []),
    `${base.origin}/.well-known/oauth-protected-resource${path}`,
    `${base.origin}/.well-known/oauth-protected-resource`,
  ];
  for (const url of candidates) {
    const meta = await getJson(deps, url).catch(() => null);
    const servers = meta?.authorization_servers;
    if (Array.isArray(servers) && typeof servers[0] === "string") {
      const supported = meta?.scopes_supported;
      const scopes = Array.isArray(supported) ? supported.filter((x): x is string => typeof x === "string") : [];
      const resource = typeof meta?.resource === "string" ? meta.resource : canonicalResource(serverUrl);
      return { kind: "oauth", resource, issuer: servers[0], scopes };
    }
  }
  // No protected-resource metadata (older servers, e.g. Atlassian or Zapier): the MCP spec's fallback
  // is an authorization server at the server's own origin.
  if (/^bearer\b/i.test(header)) {
    const meta = await authServerMetadata(deps, base.origin).catch(() => null);
    if (meta?.registration_endpoint) {
      return { kind: "oauth", resource: canonicalResource(serverUrl), issuer: base.origin, scopes: [] };
    }
  }
  return { kind: "needs_key" };
}

/** Authorization server metadata: RFC 8414 (with path insertion), then OpenID discovery. */
export async function authServerMetadata(deps: McpOAuthDeps, issuer: string): Promise<AuthServerMetadata | null> {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, "");
  const candidates = [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    ...(path ? [`${u.origin}${path}/.well-known/openid-configuration`] : []),
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}/.well-known/oauth-authorization-server`,
  ];
  for (const url of candidates) {
    const meta = await getJson(deps, url).catch(() => null);
    if (meta && typeof meta.authorization_endpoint === "string" && typeof meta.token_endpoint === "string") {
      await assertPublicHttpsUrl(meta.authorization_endpoint, deps.resolveHost);
      await assertPublicHttpsUrl(meta.token_endpoint, deps.resolveHost);
      return meta as unknown as AuthServerMetadata;
    }
  }
  return null;
}

const clientAad = (orgId: string, id: string) => `oauth-client|${orgId}|${id}`;

/**
 * The client agentes.chat registered with this issuer for this org, or a new
 * one (Dynamic Client Registration). Null when the server doesn't offer
 * registration or PKCE S256.
 */
export async function ensureOAuthClient(
  deps: McpOAuthDeps,
  orgId: string,
  issuer: string,
  meta: AuthServerMetadata,
  input: { redirectUri: string; scopes: string[] },
) {
  const [existing] = await deps.db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.orgId, orgId), eq(oauthClients.issuer, issuer)));
  if (existing) return existing;
  const methods = meta.code_challenge_methods_supported;
  if (methods && !methods.includes("S256")) return null;
  if (!meta.registration_endpoint) return null;
  await assertPublicHttpsUrl(meta.registration_endpoint, deps.resolveHost);
  const res = await http(deps)(meta.registration_endpoint, {
    method: "POST",
    redirect: "error",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "agentes.chat",
      redirect_uris: [input.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(input.scopes.length > 0 ? { scope: input.scopes.join(" ") } : {}),
    }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => ({}))) as { client_id?: string; client_secret?: string };
  if (!body.client_id) return null;
  const id = crypto.randomUUID();
  const wrapper = deps.keyWrappers[0];
  if (!wrapper) throw new Error("no key wrapper");
  const sealed = body.client_secret ? await sealSecret(wrapper, body.client_secret, clientAad(orgId, id)) : null;
  const [row] = await deps.db
    .insert(oauthClients)
    .values({
      id,
      orgId,
      issuer,
      authorizationEndpoint: meta.authorization_endpoint,
      tokenEndpoint: meta.token_endpoint,
      clientId: body.client_id,
      secretCiphertext: sealed?.ciphertext ?? null,
      wrappedDataKey: sealed?.wrappedDataKey ?? null,
      kekId: sealed?.kekId ?? null,
      scope: input.scopes.length > 0 ? input.scopes.join(" ") : null,
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [raced] = await deps.db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.orgId, orgId), eq(oauthClients.issuer, issuer)));
  return raced ?? null;
}

export type OAuthClientRow = typeof oauthClients.$inferSelect;

/** Client id and (if any) secret for the token endpoint. */
export async function clientCredentials(keyWrappers: ConnectorDeps["keyWrappers"], c: OAuthClientRow) {
  const secret =
    c.secretCiphertext && c.wrappedDataKey && c.kekId
      ? await openSecret(
          keyWrappers,
          { ciphertext: c.secretCiphertext, wrappedDataKey: c.wrappedDataKey, kekId: c.kekId },
          clientAad(c.orgId, c.id),
        )
      : null;
  return { client_id: c.clientId, ...(secret ? { client_secret: secret } : {}) };
}

export async function getOAuthClient(db: Database, id: string) {
  const [row] = await db.select().from(oauthClients).where(eq(oauthClients.id, id));
  return row ?? null;
}
