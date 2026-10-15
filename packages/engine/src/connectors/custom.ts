import { createHash } from "node:crypto";
import { and, asc, type Database, eq, inArray, isNull, like, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { caches } from "../cache";
import { randomToken, sealSecret, sha256 } from "../crypto";
import { NotFoundError, ValidationError } from "../errors";
import { assertPublicHttpsUrl } from "../net-guard";
import { requirePermission } from "../organizations";
import {
  type ConnectionSecret,
  type ConnectorConnection,
  connectionHeaders,
  OAUTH_STATE_TTL_MS,
  oauthRedirectUri,
} from "./connections";
import type { McpConnect, McpTool } from "./mcp";
import { authServerMetadata, ensureOAuthClient, type McpOAuthDeps, probeMcpServer } from "./oauth-mcp";

const { connectorConnections, customTools, oauthStates, agentScopes, agents } = schema;

export const CUSTOM_PREFIX = "custom:";
export const isCustom = (c: Pick<ConnectorConnection, "connector">) => c.connector.startsWith(CUSTOM_PREFIX);
export type ToolAccess = "read" | "write" | "approval";
const ACCESS: readonly ToolAccess[] = ["read", "write", "approval"];

/** The scope a classified tool needs: reading, or writing (also for tools that always ask approval). */
export const customScope = (connectionId: string, access: ToolAccess) =>
  `custom:${connectionId}:${access === "read" ? "read" : "write"}`;

/**
 * What we suggest for a tool before an admin decides: read-only → read;
 * destructive or write-like names (create, update, delete, send, post,
 * merge, deploy…) → approval; anything else → write.
 */
export function suggestAccess(tool: { name: string; readOnlyHint?: boolean | null; destructiveHint?: boolean | null }) {
  if (tool.readOnlyHint === true) return "read" as const;
  const writeLike =
    /(^|[_-])(create|update|delete|remove|send|post|merge|deploy|publish|write|set|cancel|close|archive|drop|refund|pay)([_-]|$)/i;
  if (tool.destructiveHint === true || writeLike.test(tool.name)) return "approval" as const;
  return "write" as const;
}

export interface CustomToolView {
  name: string;
  description: string;
  readOnlyHint: boolean | null;
  /** Our suggestion until an admin decides (`accept-suggestion` applies it). */
  suggestedAccess: ToolAccess | null;
  access: ToolAccess | null;
  label: string;
  firstSeenAt: string;
}

export interface CustomServerView {
  id: string;
  serverUrl: string;
  label: string;
  authType: "oauth" | "api_key";
  tools: CustomToolView[];
  reviewedAt: string | null;
  createdAt: string;
}

export type CustomConnectStart =
  | { status: "connected"; server: CustomServerView }
  | { status: "oauth"; authorizeUrl: string }
  | { status: "needs_key" };

export interface CustomDeps extends McpOAuthDeps {
  /** How to open MCP sessions (tests: in-process servers). */
  connect?: McpConnect;
}

const aadFor = (orgId: string, id: string) => `connector-connection|${orgId}|${id}`;
const stateAad = (orgId: string, id: string) => `oauth-state|${orgId}|${id}`;

/** "list_open_issues" → "List open issues" (a starting label people can change). */
const humanize = (name: string) => {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

async function toolRows(db: Database, connectionIds: string[]) {
  if (connectionIds.length === 0) return [];
  return db
    .select()
    .from(customTools)
    .where(and(inArray(customTools.connectionId, connectionIds), isNull(customTools.removedAt)))
    .orderBy(asc(customTools.name));
}

function view(c: ConnectorConnection, tools: (typeof customTools.$inferSelect)[]): CustomServerView {
  return {
    id: c.id,
    serverUrl: c.serverUrl,
    label: c.label,
    authType: c.authType === "oauth" ? "oauth" : "api_key",
    tools: tools
      .filter((t) => t.connectionId === c.id)
      .map((t) => ({
        name: t.name,
        description: t.description,
        readOnlyHint: t.readOnlyHint,
        suggestedAccess: ACCESS.includes(t.suggestedAccess as ToolAccess) ? (t.suggestedAccess as ToolAccess) : null,
        access: ACCESS.includes(t.access as ToolAccess) ? (t.access as ToolAccess) : null,
        label: t.label,
        firstSeenAt: t.firstSeenAt.toISOString(),
      })),
    reviewedAt: c.reviewedAt ? c.reviewedAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
  };
}

async function loadCustom(db: Database, orgId: string, id: string) {
  const [c] = await db
    .select()
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.id, id),
        eq(connectorConnections.orgId, orgId),
        like(connectorConnections.connector, `${CUSTOM_PREFIX}%`),
        isNull(connectorConnections.revokedAt),
      ),
    );
  if (!c) throw new NotFoundError("Server not found");
  return c;
}

export async function listCustomServers(db: Database, actorId: string, orgId: string): Promise<CustomServerView[]> {
  await requirePermission(db, actorId, orgId, "read");
  const rows = await db
    .select()
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.orgId, orgId),
        like(connectorConnections.connector, `${CUSTOM_PREFIX}%`),
        isNull(connectorConnections.revokedAt),
      ),
    )
    .orderBy(asc(connectorConnections.createdAt));
  const tools = await toolRows(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => view(r, tools));
}

/** Stores a custom server's connection (its own row; several servers per org). */
export async function storeCustomConnection(
  deps: CustomDeps,
  input: {
    orgId: string;
    actorId: string;
    serverUrl: string;
    label: string;
    authType: "oauth" | "api_key" | "none";
    secret: ConnectionSecret | null;
    tokenExpiresAt?: Date | null;
    oauthClientId?: string | null;
  },
) {
  const wrapper = deps.keyWrappers[0];
  if (!wrapper) throw new Error("no key wrapper");
  const id = crypto.randomUUID();
  const sealed = input.secret ? await sealSecret(wrapper, JSON.stringify(input.secret), aadFor(input.orgId, id)) : null;
  const [row] = await deps.db
    .insert(connectorConnections)
    .values({
      id,
      orgId: input.orgId,
      connector: `${CUSTOM_PREFIX}${id}`,
      label: input.label.slice(0, 80),
      serverUrl: input.serverUrl,
      authType: input.authType,
      secretCiphertext: sealed?.ciphertext ?? null,
      wrappedDataKey: sealed?.wrappedDataKey ?? null,
      kekId: sealed?.kekId ?? null,
      tokenExpiresAt: input.tokenExpiresAt ?? null,
      oauthClientId: input.oauthClientId ?? null,
      createdByUserId: input.actorId,
    })
    .returning();
  if (!row) throw new Error("connection insert returned nothing");
  caches.connections.delete(`${input.orgId}:active`);
  await recordAudit(deps.db, {
    orgId: input.orgId,
    actor: { type: "person", id: input.actorId },
    action: "connector.custom_connected",
    target: { type: "connector_connection", id: row.id },
    details: { serverUrl: input.serverUrl, authType: input.authType },
  });
  return row;
}

/**
 * Lists the server's tools again: new ones come in unclassified (hidden from
 * agents until an admin classifies them), gone ones are marked removed.
 */
export async function syncCustomTools(deps: CustomDeps, c: ConnectorConnection) {
  if (!deps.connect) throw new Error("no MCP connect configured");
  const session = await deps.connect(c, await connectionHeaders(deps, c));
  let listed: McpTool[];
  try {
    listed = await session.listTools();
  } finally {
    await session.close().catch(() => {});
  }
  const existing = await deps.db.select().from(customTools).where(eq(customTools.connectionId, c.id));
  const byName = new Map(existing.map((t) => [t.name, t]));
  const seen = new Set<string>();
  for (const tool of listed) {
    seen.add(tool.name);
    const old = byName.get(tool.name);
    const description = (tool.description ?? "").slice(0, 2000);
    if (old) {
      await deps.db
        .update(customTools)
        .set({
          description,
          readOnlyHint: tool.readOnlyHint ?? null,
          destructiveHint: tool.destructiveHint ?? null,
          suggestedAccess: suggestAccess(tool),
          removedAt: null,
        })
        .where(eq(customTools.id, old.id));
    } else {
      await deps.db.insert(customTools).values({
        orgId: c.orgId,
        connectionId: c.id,
        name: tool.name,
        description,
        readOnlyHint: tool.readOnlyHint ?? null,
        destructiveHint: tool.destructiveHint ?? null,
        suggestedAccess: suggestAccess(tool),
        access: null,
        label: humanize(tool.name).slice(0, 120),
      });
    }
  }
  const gone = existing.filter((t) => !seen.has(t.name) && !t.removedAt).map((t) => t.id);
  if (gone.length > 0) {
    await deps.db.update(customTools).set({ removedAt: new Date() }).where(inArray(customTools.id, gone));
  }
  await deps.db.update(connectorConnections).set({ updatedAt: new Date() }).where(eq(connectorConnections.id, c.id));
  caches.connections.delete(`${c.orgId}:active`);
}

async function serverView(db: Database, c: ConnectorConnection) {
  return view(c, await toolRows(db, [c.id]));
}

/**
 * Connects an https MCP server by URL (admins). With an API key: stored and
 * connected. Without: if it answers openly, connected; if it speaks MCP
 * OAuth with dynamic registration, the authorize URL comes back; otherwise
 * `needs_key`.
 */
export async function connectCustomServer(
  deps: CustomDeps,
  actorId: string,
  orgId: string,
  input: { serverUrl: string; apiKey?: string; label?: string; returnTo?: string },
): Promise<CustomConnectStart> {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const url = await assertPublicHttpsUrl(input.serverUrl.trim(), deps.resolveHost);
  const serverUrl = url.toString();
  const label = input.label?.trim() || url.hostname;
  const apiKey = input.apiKey?.trim();
  if (apiKey) {
    if (apiKey.length < 8) throw new ValidationError("The key looks too short", "connector.key_too_short");
    const c = await storeCustomConnection(deps, {
      orgId,
      actorId,
      serverUrl,
      label,
      authType: "api_key",
      secret: { apiKey },
    });
    await syncCustomTools(deps, c).catch(() => {});
    return { status: "connected", server: await serverView(deps.db, c) };
  }
  const probe = await probeMcpServer(deps, serverUrl);
  if (probe.kind === "open") {
    const c = await storeCustomConnection(deps, { orgId, actorId, serverUrl, label, authType: "none", secret: null });
    await syncCustomTools(deps, c).catch(() => {});
    return { status: "connected", server: await serverView(deps.db, c) };
  }
  if (probe.kind === "needs_key") return { status: "needs_key" };
  const authorizeUrl = await beginMcpOAuth(deps, actorId, orgId, {
    connector: "custom",
    serverUrl,
    label,
    resource: probe.resource,
    issuer: probe.issuer,
    scopes: probe.scopes,
    returnTo: input.returnTo,
  });
  return authorizeUrl ? { status: "oauth", authorizeUrl } : { status: "needs_key" };
}

/**
 * Starts an MCP-native OAuth authorization: authorization server metadata,
 * a registered client (DCR), state + PKCE S256 + `resource`. Null when the
 * server can't do it (no registration or no S256).
 */
export async function beginMcpOAuth(
  deps: McpOAuthDeps,
  actorId: string,
  orgId: string,
  input: {
    connector: string;
    serverUrl: string;
    label?: string;
    resource: string;
    issuer: string;
    scopes: string[];
    returnTo?: string;
  },
): Promise<string | null> {
  const meta = await authServerMetadata(deps, input.issuer);
  if (!meta) return null;
  const redirectUri = oauthRedirectUri(deps.publicUrl);
  const client = await ensureOAuthClient(deps, orgId, input.issuer, meta, { redirectUri, scopes: input.scopes });
  if (!client) return null;
  const state = randomToken(32);
  const verifier = randomToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const wrapper = deps.keyWrappers[0];
  if (!wrapper) throw new Error("no key wrapper");
  const id = crypto.randomUUID();
  const sealed = await sealSecret(wrapper, verifier, stateAad(orgId, id));
  const returnTo = input.returnTo?.startsWith("/") && !input.returnTo.startsWith("//") ? input.returnTo : "/";
  await deps.db.insert(oauthStates).values({
    id,
    orgId,
    connector: input.connector,
    userId: actorId,
    stateHash: sha256(state),
    verifierCiphertext: sealed.ciphertext,
    wrappedDataKey: sealed.wrappedDataKey,
    kekId: sealed.kekId,
    serverUrl: input.serverUrl,
    returnTo,
    oauthClientId: client.id,
    resource: input.resource,
    label: input.label ?? null,
    expiresAt: new Date((deps.now?.() ?? new Date()).getTime() + OAUTH_STATE_TTL_MS),
  });
  const url = new URL(client.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", input.resource);
  if (client.scope) url.searchParams.set("scope", client.scope);
  return url.toString();
}

/** Lists the tools again (admins). */
export async function refreshCustomServer(deps: CustomDeps, actorId: string, orgId: string, id: string) {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const c = await loadCustom(deps.db, orgId, id);
  await syncCustomTools(deps, c);
  return serverView(deps.db, c);
}

/**
 * Saves the label and each tool's classification (admins). Only classified
 * tools are offered to agents; `approval` tools always ask a person.
 */
export async function saveCustomTools(
  deps: CustomDeps,
  actorId: string,
  orgId: string,
  id: string,
  input: { label: string; tools: { name: string; access: ToolAccess; label: string }[] },
) {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const c = await loadCustom(deps.db, orgId, id);
  const known = new Map((await toolRows(deps.db, [c.id])).map((t) => [t.name, t]));
  for (const t of input.tools) {
    if (!ACCESS.includes(t.access)) throw new ValidationError(`Invalid access for ${t.name}`);
    if (!known.has(t.name)) throw new ValidationError(`Unknown tool ${t.name}`);
  }
  const now = new Date();
  await deps.db.transaction(async (tx) => {
    for (const t of input.tools) {
      const row = known.get(t.name);
      if (!row) continue;
      await tx
        .update(customTools)
        .set({ access: t.access, label: t.label.trim().slice(0, 120) || row.label })
        .where(eq(customTools.id, row.id));
    }
    await tx
      .update(connectorConnections)
      .set({ label: input.label.trim().slice(0, 80) || c.label, reviewedAt: now, updatedAt: now })
      .where(eq(connectorConnections.id, c.id));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "connector.custom_tools_classified",
      target: { type: "connector_connection", id: c.id },
      details: { tools: input.tools.map((t) => ({ name: t.name, access: t.access })) },
    });
  });
  caches.connections.delete(`${orgId}:active`);
  caches.scopes.deletePrefix(`${orgId}:`);
  return serverView(deps.db, await loadCustom(deps.db, orgId, id));
}

/** Classified, still-listed tools of a custom connection (the tool source exposes only these). */
export async function classifiedTools(db: Database, connectionId: string) {
  const rows = await toolRows(db, [connectionId]);
  return rows.filter((t) => ACCESS.includes(t.access as ToolAccess));
}

/**
 * Applies our suggestion to every tool not classified yet (admins), in one
 * call. Returns the server and the agents that don't have access to it yet,
 * so the app can offer to grant it.
 */
export async function acceptCustomSuggestion(deps: CustomDeps, actorId: string, orgId: string, id: string) {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const c = await loadCustom(deps.db, orgId, id);
  const rows = await toolRows(deps.db, [c.id]);
  const tools = rows.map((t) => ({
    name: t.name,
    access: (ACCESS.includes(t.access as ToolAccess)
      ? t.access
      : ACCESS.includes(t.suggestedAccess as ToolAccess)
        ? t.suggestedAccess
        : suggestAccess(t)) as ToolAccess,
    label: t.label,
  }));
  const server = await saveCustomTools(deps, actorId, orgId, id, { label: c.label, tools });
  const grants = await deps.db
    .select({ agentId: agentScopes.agentId, scope: agentScopes.scope, connectionId: agentScopes.connectionId })
    .from(agentScopes)
    .where(eq(agentScopes.orgId, orgId));
  const withAccess = new Set(
    grants
      .filter((g) => g.scope === "*" || (g.connectionId === c.id && g.scope !== "" && !g.scope.startsWith("deny:")))
      .map((g) => g.agentId),
  );
  const agentRows = await deps.db
    .select({ id: agents.id, name: agents.name, handle: agents.handle })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)));
  return {
    server,
    agentsWithoutAccess: agentRows.filter((a) => !withAccess.has(a.id)),
    /** Body for `PUT …/agents/{id}/access` that adds this server whole (merge with the agent's current access). */
    suggestedGrant: { connectors: { [c.id]: true } },
  };
}
