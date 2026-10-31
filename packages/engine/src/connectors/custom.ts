import { createHash } from "node:crypto";
import type { BlobStore } from "@agenteschat/adapters";
import { and, asc, type Database, eq, inArray, isNull, like, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { caches } from "../cache";
import { randomToken, sealSecret, sha256 } from "../crypto";
import { NotFoundError, ValidationError } from "../errors";
import type { Judge } from "../judge";
import { assertPublicHttpsUrl } from "../net-guard";
import { requirePermission } from "../organizations";
import {
  classifyByRules,
  classifyTools,
  describeToolName,
  type ReasonCode,
  type SuggestionSource,
  sharedPrefix,
  type ToolClass,
  type ToolNameParts,
  type ToolToClassify,
  UNKNOWN_CLASS,
} from "./classify";
import {
  type ConnectionSecret,
  type ConnectorConnection,
  connectionHeaders,
  grantToEveryAgent,
  OAUTH_STATE_TTL_MS,
  oauthRedirectUri,
} from "./connections";
import type { McpConnect, McpTool } from "./mcp";
import { authServerMetadata, ensureOAuthClient, type McpOAuthDeps, probeMcpServer } from "./oauth-mcp";
import { oauthReturnTo } from "./oauth-return";
import { presetForServer } from "./presets";
import { type McpServerInfo, refreshServerIcon } from "./server-icon";

const { connectorConnections, customTools, oauthStates, agentScopes, agents } = schema;

export const CUSTOM_PREFIX = "custom:";
export const isCustom = (c: Pick<ConnectorConnection, "connector">) => c.connector.startsWith(CUSTOM_PREFIX);
export type ToolAccess = "read" | "write" | "approval";
const ACCESS: readonly ToolAccess[] = ["read", "write", "approval"];
/** An admin's decision on a tool: how it may be used, or `off` (never offered to agents, not asked again). */
export type ToolDecision = ToolAccess | "off";
const DECISIONS: readonly ToolDecision[] = [...ACCESS, "off"];

/** The scope a classified tool needs: reading, or writing (also for tools that always ask approval). */
export const customScope = (connectionId: string, access: ToolAccess) =>
  `custom:${connectionId}:${access === "read" ? "read" : "write"}`;

/**
 * Our suggestion by the rules alone (annotations, then the verb in the name;
 * see `classify.ts`). Ambiguous names, which the judge answers when listing,
 * get approval here.
 */
export function suggestAccess(tool: ToolToClassify): ToolAccess {
  return (classifyByRules(tool) ?? UNKNOWN_CLASS).level;
}

/** Our suggestion, except tools the server itself keeps read-only (a preset's `readTools`). */
export function suggestFor(tool: ToolToClassify, readTools: readonly string[] = []): ToolAccess {
  return (classifyByRules(tool, readTools) ?? UNKNOWN_CLASS).level;
}

export interface CustomToolView {
  name: string;
  description: string;
  readOnlyHint: boolean | null;
  /** Our suggestion until an admin decides (`accept-suggestion` applies it). */
  suggestedAccess: ToolAccess | null;
  /** Null = not decided yet (hidden from agents, waits for review). */
  access: ToolDecision | null;
  /** What the tool does now: the decision, else the suggestion. */
  level: ToolDecision;
  /** Where the suggestion came from (annotations, the verb, the judge…). */
  suggestionSource: SuggestionSource | null;
  /** Why we suggest it, as a code the web translates (`spends_money`, `unknown`…). */
  suggestionReason: ReasonCode | null;
  /** Deletes, sends, pays…: may only ask for approval or be off. */
  sensitive: boolean;
  /** The name couldn't decide it and no one confirmed the suggestion yet ("Precisam da sua decisão"). */
  pending: boolean;
  /** Off: never offered to agents. */
  off: boolean;
  /** The readable name's parts (the web says them in the person's language). */
  nameParts: ToolNameParts;
  /** The resource it is about (`campaign`, `ticket`), from the name: tools are grouped by it. */
  subject: string;
  label: string;
  firstSeenAt: string;
}

export interface CustomServerView {
  id: string;
  serverUrl: string;
  label: string;
  authType: "oauth" | "api_key";
  /** The server's own icon, served by us (`/api/app/connector-icons/…`); null = a monogram. */
  iconUrl: string | null;
  tools: CustomToolView[];
  reviewedAt: string | null;
  createdAt: string;
}

export type CustomConnectStart =
  | { status: "connected"; server: CustomServerView }
  | { status: "oauth"; authorizeUrl: string }
  /** `not_approved`: it has OAuth but only lets in apps it approved, and agentes.chat isn't one yet. */
  | { status: "needs_key"; reason?: "not_approved" };

export interface CustomDeps extends McpOAuthDeps {
  /** How to open MCP sessions (tests: in-process servers). */
  connect?: McpConnect;
  /** Suggests a level for tools whose name doesn't say (none: they suggest approval). */
  judge?: Judge;
  /** Where servers' icons are kept (the platform store); none: no icons. */
  blobs?: BlobStore;
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

type ToolRow = typeof customTools.$inferSelect;
const AMBIGUOUS: readonly string[] = ["judge", "judge_failed"];
const isPending = (t: ToolRow) => AMBIGUOUS.includes(t.suggestionSource ?? "") && t.confirmedAt === null;

function toolView(t: ToolRow, prefix: string | null): CustomToolView {
  const suggestedAccess = ACCESS.includes(t.suggestedAccess as ToolAccess) ? (t.suggestedAccess as ToolAccess) : null;
  const access = DECISIONS.includes(t.access as ToolDecision) ? (t.access as ToolDecision) : null;
  const { subject, ...nameParts } = describeToolName(t.name, prefix);
  return {
    name: t.name,
    description: t.description,
    readOnlyHint: t.readOnlyHint,
    suggestedAccess,
    access,
    level: access ?? suggestedAccess ?? suggestAccess(t),
    suggestionSource: (t.suggestionSource as SuggestionSource | null) ?? null,
    suggestionReason: (t.suggestionReason as ReasonCode | null) ?? null,
    sensitive: t.sensitive,
    pending: isPending(t),
    off: access === "off",
    nameParts,
    subject,
    label: t.label,
    firstSeenAt: t.firstSeenAt.toISOString(),
  };
}

function view(c: ConnectorConnection, tools: ToolRow[]): CustomServerView {
  const mine = tools.filter((t) => t.connectionId === c.id);
  const prefix = sharedPrefix(mine.map((t) => t.name));
  return {
    id: c.id,
    serverUrl: c.serverUrl,
    label: c.label,
    authType: c.authType === "oauth" ? "oauth" : "api_key",
    iconUrl: c.icon,
    tools: mine.map((t) => toolView(t, prefix)),
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

/**
 * Stores a custom server's connection (its own row; several servers per org).
 * Connecting the same address again is a reconnect: the active row gets the
 * new credentials in place, so agents keep their grants and the tools keep
 * their classification. A new server is every agent's (`grantToEveryAgent`).
 */
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
  const [existing] = await deps.db
    .select()
    .from(connectorConnections)
    .where(
      and(
        eq(connectorConnections.orgId, input.orgId),
        like(connectorConnections.connector, `${CUSTOM_PREFIX}%`),
        eq(connectorConnections.serverUrl, input.serverUrl),
        isNull(connectorConnections.revokedAt),
      ),
    )
    .orderBy(asc(connectorConnections.createdAt))
    .limit(1);
  const id = existing?.id ?? crypto.randomUUID();
  const sealed = input.secret ? await sealSecret(wrapper, JSON.stringify(input.secret), aadFor(input.orgId, id)) : null;
  if (existing) {
    const [row] = await deps.db
      .update(connectorConnections)
      .set({
        authType: input.authType,
        secretCiphertext: sealed?.ciphertext ?? null,
        wrappedDataKey: sealed?.wrappedDataKey ?? null,
        kekId: sealed?.kekId ?? null,
        tokenExpiresAt: input.tokenExpiresAt ?? null,
        oauthClientId: input.oauthClientId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(connectorConnections.id, existing.id))
      .returning();
    if (!row) throw new Error("connection update returned nothing");
    caches.connections.delete(`${input.orgId}:active`);
    caches.scopes.deletePrefix(`${input.orgId}:`);
    await recordAudit(deps.db, {
      orgId: input.orgId,
      actor: { type: "person", id: input.actorId },
      action: "connector.custom_reconnected",
      target: { type: "connector_connection", id: row.id },
      details: { serverUrl: input.serverUrl, authType: input.authType },
    });
    return row;
  }
  const row = await deps.db.transaction(async (tx) => {
    const [row] = await tx
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
    await recordAudit(tx, {
      orgId: input.orgId,
      actor: { type: "person", id: input.actorId },
      action: "connector.custom_connected",
      target: { type: "connector_connection", id: row.id },
      details: { serverUrl: input.serverUrl, authType: input.authType },
    });
    await grantToEveryAgent(tx, input.orgId, input.actorId, row);
    return row;
  });
  caches.connections.delete(`${input.orgId}:active`);
  caches.scopes.deletePrefix(`${input.orgId}:`);
  return row;
}

/**
 * Lists the server's tools again: new ones come in unclassified (hidden from
 * agents until an admin classifies them), gone ones are marked removed. Each
 * gets a suggestion (annotations, the verb, else the judge: its answers are
 * kept per tool name and not asked again). A tool that turns out sensitive
 * can't stay free: its read/write decision becomes approval.
 */
export async function syncCustomTools(deps: CustomDeps, c: ConnectorConnection) {
  if (!deps.connect) throw new Error("no MCP connect configured");
  const session = await deps.connect(c, await connectionHeaders(deps, c));
  let listed: McpTool[];
  let info: McpServerInfo | null = null;
  try {
    listed = await session.listTools();
    info = session.serverInfo?.() ?? null;
  } finally {
    await session.close().catch(() => {});
  }
  const existing = await deps.db.select().from(customTools).where(eq(customTools.connectionId, c.id));
  const byName = new Map(existing.map((t) => [t.name, t]));
  const preset = presetForServer(c.serverUrl);
  const cached = new Map<string, ToolClass>();
  for (const t of existing) {
    if (t.suggestionSource === "judge" && ACCESS.includes(t.suggestedAccess as ToolAccess)) {
      cached.set(t.name, {
        level: t.suggestedAccess as ToolAccess,
        source: "judge",
        reason: (t.suggestionReason as ReasonCode | null) ?? "unknown",
        sensitive: false,
      });
    }
  }
  const classes = await classifyTools(listed, {
    orgId: c.orgId,
    server: c.label,
    judge: deps.judge,
    readTools: preset?.readTools,
    cached,
  });
  const seen = new Set<string>();
  for (const tool of listed) {
    seen.add(tool.name);
    const old = byName.get(tool.name);
    const description = (tool.description ?? "").slice(0, 2000);
    const cls = classes.get(tool.name) ?? classifyByRules(tool, preset?.readTools) ?? UNKNOWN_CLASS;
    const suggestion = {
      suggestedAccess: cls.level,
      suggestionSource: cls.source,
      suggestionReason: cls.reason,
      sensitive: cls.sensitive,
    };
    if (old) {
      const unsafe = cls.sensitive && (old.access === "read" || old.access === "write");
      await deps.db
        .update(customTools)
        .set({
          description,
          readOnlyHint: tool.readOnlyHint ?? null,
          destructiveHint: tool.destructiveHint ?? null,
          ...suggestion,
          ...(unsafe ? { access: "approval" } : {}),
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
        ...suggestion,
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
  await refreshServerIcon(deps, c, info).catch(() => {});
}

/** The server as stored now (a listing may have just changed its icon). */
async function serverView(db: Database, orgId: string, id: string) {
  return view(await loadCustom(db, orgId, id), await toolRows(db, [id]));
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
    return { status: "connected", server: await serverView(deps.db, c.orgId, c.id) };
  }
  const probe = await probeMcpServer(deps, serverUrl);
  if (probe.kind === "open") {
    const c = await storeCustomConnection(deps, { orgId, actorId, serverUrl, label, authType: "none", secret: null });
    await syncCustomTools(deps, c).catch(() => {});
    return { status: "connected", server: await serverView(deps.db, c.orgId, c.id) };
  }
  if (probe.kind === "needs_key") return { status: "needs_key" };
  return beginMcpOAuth(deps, actorId, orgId, {
    connector: "custom",
    serverUrl,
    label,
    resource: probe.resource,
    issuer: probe.issuer,
    scopes: probe.scopes,
    returnTo: input.returnTo,
  });
}

/**
 * Starts an MCP-native OAuth authorization: authorization server metadata,
 * a registered client (DCR), state + PKCE S256 + `resource`. `needs_key` when
 * the server can't do it, with `not_approved` when it only registers clients
 * it approved.
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
): Promise<Exclude<CustomConnectStart, { status: "connected" }>> {
  const meta = await authServerMetadata(deps, input.issuer);
  if (!meta) return { status: "needs_key" };
  const redirectUri = oauthRedirectUri(deps.publicUrl);
  const client = await ensureOAuthClient(deps, orgId, input.issuer, meta, { redirectUri, scopes: input.scopes });
  if (client === "not_approved") return { status: "needs_key", reason: "not_approved" };
  if (!client) return { status: "needs_key" };
  const state = randomToken(32);
  const verifier = randomToken(48);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const wrapper = deps.keyWrappers[0];
  if (!wrapper) throw new Error("no key wrapper");
  const id = crypto.randomUUID();
  const sealed = await sealSecret(wrapper, verifier, stateAad(orgId, id));
  const returnTo = oauthReturnTo(input.returnTo);
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
  return { status: "oauth", authorizeUrl: url.toString() };
}

/** Lists the tools again (admins). */
export async function refreshCustomServer(deps: CustomDeps, actorId: string, orgId: string, id: string) {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const c = await loadCustom(deps.db, orgId, id);
  await syncCustomTools(deps, c);
  return serverView(deps.db, c.orgId, c.id);
}

/** A person's decision on one tool. `confirmed: false` = the suggestion applies, but it still waits for a decision. */
export interface ToolDecisionInput {
  name: string;
  access: ToolDecision;
  label: string;
  confirmed?: boolean;
}

/**
 * Saves the label and each tool's classification (admins). Only classified
 * tools are offered to agents; `approval` tools always ask a person; `off`
 * tools are never offered and don't wait for review. Sensitive tools may
 * only ask for approval or be off.
 */
export async function saveCustomTools(
  deps: CustomDeps,
  actorId: string,
  orgId: string,
  id: string,
  input: { label: string; tools: ToolDecisionInput[] },
) {
  await requirePermission(deps.db, actorId, orgId, "manage_connectors");
  const c = await loadCustom(deps.db, orgId, id);
  const known = new Map((await toolRows(deps.db, [c.id])).map((t) => [t.name, t]));
  for (const t of input.tools) {
    if (!DECISIONS.includes(t.access)) throw new ValidationError(`Invalid access for ${t.name}`);
    const row = known.get(t.name);
    if (!row) throw new ValidationError(`Unknown tool ${t.name}`);
    if (row.sensitive && (t.access === "read" || t.access === "write")) {
      throw new ValidationError(
        `${t.name} is sensitive: it can only ask for approval or be off`,
        "connector.sensitive_tool",
        { tool: t.name },
      );
    }
  }
  const now = new Date();
  await deps.db.transaction(async (tx) => {
    for (const t of input.tools) {
      const row = known.get(t.name);
      if (!row) continue;
      await tx
        .update(customTools)
        .set({
          access: t.access,
          label: t.label.trim().slice(0, 120) || row.label,
          ...(t.confirmed === false ? {} : { confirmedAt: row.confirmedAt ?? now }),
        })
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
  return serverView(deps.db, orgId, id);
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
  const tools = rows.map((t): ToolDecisionInput => {
    let access = (
      DECISIONS.includes(t.access as ToolDecision)
        ? t.access
        : ACCESS.includes(t.suggestedAccess as ToolAccess)
          ? t.suggestedAccess
          : suggestAccess(t)
    ) as ToolDecision;
    if (t.sensitive && (access === "read" || access === "write")) access = "approval";
    // Accepting applies the suggestion; ambiguous tools still wait for a person's decision.
    return { name: t.name, access, label: t.label, confirmed: false };
  });
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
