/**
 * Test fake — agent tool access, same shapes and resolution order as the
 * backend (packages/engine/src/access.ts): deny > tool > connector > scope > all.
 * - `GET/PUT /api/app/organizations/{orgId}/agents/{agentId}/access`
 * - `GET …/access-matrix`
 */
import type { ApiClient } from "@/api/client";
import type { AccessInput, AccessMatrix, AccessScope, AccessState, AgentAccess, Connection } from "@/api/types";
import type { MockContext } from "./context";

type FakeTool = { name: string; label: string; description: string; sensitive: boolean; readOnly: boolean };
const tool = (name: string, label: string, description: string, readOnly = false, sensitive = false): FakeTool => ({
  name,
  label,
  description,
  sensitive,
  readOnly,
});
const BUILTINS: { scope: string; label: string; tools: FakeTool[] }[] = [
  {
    scope: "memory:write",
    label: "Memória",
    tools: [
      tool("memory_remember", "Lembrar", "Guarda fatos e preferências."),
      tool("memory_search", "Buscar na memória", "Consulta o que já aprendeu.", true),
    ],
  },
  {
    scope: "context:read",
    label: "Busca",
    tools: [tool("search_workspace", "Ler o contexto", "Mensagens e issues.", true)],
  },
  {
    scope: "drive:write",
    label: "Drive",
    tools: [
      tool("drive_create_document", "Escrever arquivos", "Relatórios e tabelas."),
      tool("drive_read_file", "Ler arquivos", "Abre documentos.", true),
    ],
  },
  {
    scope: "issues:write",
    label: "Issues",
    tools: [
      tool("issues_create", "Criar e editar issues", "Abre uma issue."),
      tool("issues_list", "Ler issues", "Lista issues.", true),
    ],
  },
  {
    scope: "calendar:write",
    label: "Calendário",
    tools: [
      tool("calendar_propose_event", "Propor eventos", "Uma pessoa confirma."),
      tool("calendar_list_events", "Ver agenda", "Eventos do workspace.", true),
    ],
  },
  {
    scope: "skills:read",
    label: "Skills",
    tools: [
      tool("load_skill", "Abrir skill", "Lê o SKILL.md.", true),
      tool("read_skill_file", "Ler arquivo da skill", "Arquivos de texto da skill.", true),
    ],
  },
  {
    scope: "",
    label: "Perguntar à pessoa",
    tools: [tool("ask_user", "Perguntar", "Faz uma pergunta curta e espera.")],
  },
];
const GITHUB: { scope: string; label: string; tools: FakeTool[] }[] = [
  {
    scope: "github:repo.read",
    label: "Ler o repositório",
    tools: [tool("github_list_pull_requests", "Ver PRs", "Lista pull requests.", true)],
  },
  {
    scope: "github:pr.write",
    label: "Abrir e comentar PRs",
    tools: [tool("github_create_pull_request", "Abrir PR", "Cria um pull request.")],
  },
  {
    scope: "github:pr.merge",
    label: "Fazer merge",
    tools: [tool("github_merge_pull_request", "Fazer merge", "Merge de um PR.", false, true)],
  },
];

const empty = (): AccessInput => ({
  all: false,
  connectors: {},
  scopes: [
    { connectionId: null, scope: "memory:write" },
    { connectionId: null, scope: "skills:read" },
  ],
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
    tools: b.tools.map((t) => ({
      ...t,
      connectionId: null,
      scope: b.scope,
      state: toolState(null, t.name, b.scope),
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
          ...t,
          connectionId: c.id,
          scope: s.scope,
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
