import type { AccessInput, AccessScope, AgentAccess, ConnectorDef, ScopeGrant, ToolRef } from "@/api/types";

/**
 * One access level per agent and connection ("Quem pode usar"), mapped onto
 * the existing grants of `PUT …/agents/{id}/access`:
 * - `none`: no grant on the connection;
 * - `read`: its read scopes (a catalog connector's `*.read` scopes, or a
 *   custom server's `custom:{id}:read`), so read tools added later come too;
 * - `write`: the whole connection (`connector:*`), now and later.
 * Sensitive tools (merge, deploy, "Pede aprovação sempre") keep asking a
 * person whatever the level: approvals don't depend on grants.
 */
export type ConnectorLevel = "none" | "read" | "write";

export const LEVELS: ConnectorLevel[] = ["none", "read", "write"];

const on = (state: string) => state === "granted" || state === "inherited";

const key = (connectionId: string | null, scope: string) => `${connectionId ?? ""}|${scope}`;

/** Every scope the tree shows (the ones a level replaces). */
function treeScopes(access: AgentAccess) {
  const out = new Set(access.builtins.map((s) => key(null, s.scope)));
  for (const c of access.connectors) for (const s of c.scopes) out.add(key(c.connectionId, s.scope));
  return out;
}

/** Grant rows that aren't plain scopes (`*`, `connector:*`, `tool:…`, `deny:…`): the tree already says them. */
const special = (scope: string) =>
  scope === "*" || scope === "connector:*" || scope.startsWith("tool:") || scope.startsWith("deny:");

/**
 * The agent's current grants as a PUT body, read back from the tree: explicit
 * scopes, connectors and per-tool allows/denials (what's only inherited is
 * left out, as it comes from a broader grant that is kept). `raw` (the
 * agent's grant rows) keeps scopes the tree doesn't show, such as GitHub
 * repository limits.
 */
export function inputFromAccess(access: AgentAccess, raw: ScopeGrant[] = []): AccessInput {
  const input: AccessInput = { all: access.all, connectors: {}, scopes: [], tools: { allow: [], deny: [] } };
  const take = (connectionId: string | null, scopes: AccessScope[]) => {
    for (const s of scopes) {
      const scopeGranted = s.scope !== "" && s.state === "granted";
      if (scopeGranted) input.scopes.push({ connectionId, scope: s.scope });
      for (const t of s.tools) {
        const ref: ToolRef = { connectionId, name: t.name };
        if (t.state === "denied") input.tools.deny.push(ref);
        else if (t.state === "granted" && !scopeGranted) input.tools.allow.push(ref);
      }
    }
  };
  take(null, access.builtins);
  for (const c of access.connectors) {
    if (c.state === "granted") input.connectors[c.connectionId] = true;
    take(c.connectionId, c.scopes);
  }
  const known = treeScopes(access);
  const active = new Set(access.connectors.map((c) => c.connectionId));
  for (const g of raw) {
    // Only active connections: the server refuses grants on anything else.
    if (!g.connectionId || !active.has(g.connectionId) || special(g.scope)) continue;
    if (!known.has(key(g.connectionId, g.scope))) input.scopes.push(g);
  }
  return input;
}

/** The agent's level on a connection, from its access tree. */
export function levelOf(access: AgentAccess | undefined, connectionId: string): ConnectorLevel {
  const c = access?.connectors.find((x) => x.connectionId === connectionId);
  if (!c) return "none";
  if (on(c.state)) return "write";
  const tools = c.scopes.flatMap((s) => s.tools).filter((t) => on(t.state));
  if (tools.some((t) => !t.readOnly)) return "write";
  if (tools.length > 0 || c.scopes.some((s) => s.state === "granted")) return "read";
  return "none";
}

/**
 * The PUT body that sets one connection to a level and keeps everything
 * else (other connectors, built-ins, explicit denials, repository limits).
 */
export function withLevel(
  access: AgentAccess,
  connectionId: string,
  readScopes: string[],
  level: ConnectorLevel,
  raw: ScopeGrant[] = [],
): AccessInput {
  const input = inputFromAccess(access, raw);
  delete input.connectors[connectionId];
  // Repository limits (`github:git.repo:owner/name`) narrow access whatever the level: they stay.
  input.scopes = input.scopes.filter((s) => s.connectionId !== connectionId || s.scope.includes(":git.repo:"));
  input.tools.allow = input.tools.allow.filter((t) => t.connectionId !== connectionId);
  if (level === "write") input.connectors[connectionId] = true;
  if (level === "read") for (const scope of readScopes) input.scopes.push({ connectionId, scope });
  return input;
}

/** The read scopes of a connection: a catalog connector's `*.read` scopes, or a custom server's read scope. */
export function readScopesOf(target: { connectionId: string; def: ConnectorDef | null; custom: boolean }) {
  if (target.custom) return [`custom:${target.connectionId}:read`];
  return (target.def?.scopes ?? []).filter((s) => !s.sensitive && s.id.endsWith(".read")).map((s) => s.id);
}

/** How a catalog connector's tool is used: sensitive ones always ask; `*.read` scopes only read. */
export function catalogToolClass(tool: { scope: string; sensitive: boolean }): "read" | "write" | "approval" {
  if (tool.sensitive) return "approval";
  return tool.scope.endsWith(".read") ? "read" : "write";
}
