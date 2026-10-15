/**
 * Test fake — agent tool access, same shapes and resolution order as the
 * backend (packages/engine/src/access.ts): deny > tool > connector > scope > all.
 * - `GET/PUT /api/app/organizations/{orgId}/agents/{agentId}/access`
 * - `GET …/access-matrix`
 */
import type { ApiClient } from "@/api/client";
import type { AccessInput, AccessMatrix, AccessScope, AccessState, AgentAccess, Connection } from "@/api/types";
import type { MockContext } from "./context";

const BUILTINS: { scope: string; label: string; tools: string[] }[] = [
  { scope: "memory:write", label: "Memória", tools: ["memory_remember", "memory_search"] },
  { scope: "context:read", label: "Busca", tools: ["search_workspace"] },
  { scope: "drive:write", label: "Drive", tools: ["drive_create_document", "drive_read_file"] },
  { scope: "issues:write", label: "Issues", tools: ["issues_create", "issues_list"] },
  { scope: "calendar:write", label: "Calendário", tools: ["calendar_propose_event", "calendar_list_events"] },
  { scope: "", label: "Perguntar à pessoa", tools: ["ask_user"] },
];
const GITHUB = [
  {
    scope: "github:repo.read",
    label: "Ler o repositório",
    tools: [{ name: "github_list_pull_requests", sensitive: false }],
  },
  {
    scope: "github:pr.write",
    label: "Abrir e comentar PRs",
    tools: [{ name: "github_create_pull_request", sensitive: false }],
  },
  { scope: "github:pr.merge", label: "Fazer merge", tools: [{ name: "github_merge_pull_request", sensitive: true }] },
];

const empty = (): AccessInput => ({
  all: false,
  connectors: {},
  scopes: [{ connectionId: null, scope: "memory:write" }],
  tools: { allow: [], deny: [] },
});

export function fakeAccessTree(input: AccessInput, connections: Connection[]): AgentAccess {
  const allowed = (c: string | null, name: string) =>
    input.tools.allow.some((t) => t.connectionId === c && t.name === name);
  const denied = (c: string | null, name: string) =>
    input.tools.deny.some((t) => t.connectionId === c && t.name === name);
  const scopeGranted = (c: string | null, scope: string) =>
    input.scopes.some((s) => s.connectionId === c && s.scope === scope);
  const toolState = (c: string | null, name: string, scope: string): AccessState => {
    if (denied(c, name)) return "denied";
    if (allowed(c, name)) return "granted";
    if (scope === "" || scopeGranted(c, scope) || (c && input.connectors[c]) || input.all) return "inherited";
    return "off";
  };
  const scopeState = (c: string | null, scope: string): AccessState =>
    scopeGranted(c, scope) ? "granted" : (c && input.connectors[c]) || input.all || scope === "" ? "inherited" : "off";
  const builtins: AccessScope[] = BUILTINS.map((b) => ({
    scope: b.scope,
    label: b.label,
    state: scopeState(null, b.scope),
    tools: b.tools.map((name) => ({
      name,
      connectionId: null,
      scope: b.scope,
      sensitive: false,
      state: toolState(null, name, b.scope),
    })),
  }));
  const connectors = connections
    .filter((c) => !c.revokedAt && c.connector === "github")
    .map((c) => ({
      connectionId: c.id,
      connector: c.connector,
      label: "GitHub",
      custom: false,
      state: (input.connectors[c.id] ? "granted" : input.all ? "inherited" : "off") as AccessState,
      scopes: GITHUB.map((s) => ({
        scope: s.scope,
        label: s.label,
        state: scopeState(c.id, s.scope),
        tools: s.tools.map((t) => ({
          name: t.name,
          connectionId: c.id,
          scope: s.scope,
          sensitive: t.sensitive,
          state: toolState(c.id, t.name, s.scope),
        })),
      })),
    }));
  return { all: input.all, builtins, connectors };
}

export function createFakeAccess(
  ctx: MockContext,
  connections: (orgId: string) => Promise<Connection[]>,
  log: (method: string, ...args: unknown[]) => void,
): ApiClient["access"] {
  const inputs = new Map<string, AccessInput>();
  const of = (agentId: string) => inputs.get(agentId) ?? empty();
  return {
    get: async (orgId, agentId) => fakeAccessTree(of(agentId), await connections(orgId)),
    set: async (orgId, agentId, input) => {
      log("access.set", orgId, agentId, input);
      inputs.set(agentId, structuredClone(input));
      return fakeAccessTree(input, await connections(orgId));
    },
    matrix: async (orgId) => {
      const conns = await connections(orgId);
      const agents = await ctx.lookup.agents(orgId);
      const tools: (AccessMatrix["tools"][number] & { state: AccessState })[] = [];
      const sample = fakeAccessTree(empty(), conns);
      for (const s of sample.builtins) {
        for (const t of s.tools) tools.push({ ...t, group: "agentes", key: `builtin|${t.name}` });
      }
      for (const c of sample.connectors) {
        for (const s of c.scopes) {
          for (const t of s.tools) tools.push({ ...t, group: c.label, key: `${c.connectionId}|${t.name}` });
        }
      }
      const cells: AccessMatrix["cells"] = {};
      for (const a of agents) {
        const tree = fakeAccessTree(of(a.id), conns);
        const row: Record<string, AccessState> = {};
        for (const s of tree.builtins) for (const t of s.tools) row[`builtin|${t.name}`] = t.state;
        for (const c of tree.connectors) {
          for (const s of c.scopes) for (const t of s.tools) row[`${c.connectionId}|${t.name}`] = t.state;
        }
        cells[a.id] = row;
      }
      return {
        agents: agents.map((a) => ({ id: a.id, name: a.name, handle: a.handle })),
        tools: tools.map(({ state: _s, ...t }) => t),
        cells,
      };
    },
  };
}
