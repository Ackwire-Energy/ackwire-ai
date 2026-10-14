/**
 * MOCK — connectors and agent scopes (two layers: the org connects an MCP
 * once; each agent gets a subset of its scopes).
 * Waiting for: GET /api/app/organizations/{orgId}/connectors,
 * GET|PUT /api/app/organizations/{orgId}/agents/{agentId}/scopes.
 * The Tool Gateway enforces them server-side; the UI never grants anything.
 */
import type { MockedApi } from "../client";
import type { Connector } from "../types";
import { clone, type MockContext, perOrg } from "./context";

/** The connectors of the approved screen (telas/Agente). */
export const DEMO_CONNECTORS: Connector[] = [
  {
    id: "github",
    name: "GitHub",
    note: "agentes-chat/app, agentes-chat/site",
    scopes: [
      {
        id: "gh-read",
        label: "Ler código e issues",
        description: "Repositórios e issues liberados para a organização.",
      },
      { id: "gh-pr", label: "Abrir e comentar PRs", description: "Sempre em branch própria, nunca na main." },
      { id: "gh-issues-write", label: "Criar e fechar issues", description: "Inclui rótulos e responsáveis." },
      {
        id: "gh-merge",
        label: "Fazer merge",
        description: "Cada merge vira um pedido de aprovação no chat.",
        requiresApproval: true,
      },
    ],
  },
  {
    id: "sentry",
    name: "Sentry",
    note: "projeto app",
    scopes: [{ id: "sentry-read", label: "Ler erros e eventos", description: "Stack traces, frequência e releases." }],
  },
  {
    id: "sandbox",
    name: "Sandbox",
    note: "execução isolada",
    scopes: [
      {
        id: "sandbox-run",
        label: "Rodar testes e scripts",
        description: "Num ambiente descartável, sem acesso à produção.",
      },
    ],
  },
  {
    id: "drive",
    name: "Drive",
    note: "arquivos da organização",
    scopes: [
      { id: "drive-read", label: "Ler arquivos", description: "Relatórios, tabelas e organograma." },
      { id: "drive-write", label: "Criar relatórios e diffs", description: "Arquivos novos ficam na pasta do agente." },
    ],
  },
];

const DEFAULT_OFF = new Set(["drive-write", "gh-issues-write"]);

export function createMockPermissions(ctx: MockContext): MockedApi["permissions"] {
  const connectors = perOrg<Connector[]>(async () => (ctx.seed ? clone(DEMO_CONNECTORS) : []));
  const grants = new Map<string, Set<string>>();
  const key = (orgId: string, agentId: string) => `${orgId}:${agentId}`;

  const granted = async (orgId: string, agentId: string) => {
    const k = key(orgId, agentId);
    let set = grants.get(k);
    if (!set) {
      const all = (await connectors(orgId)).flatMap((c) => c.scopes.map((s) => s.id));
      set = new Set(all.filter((id) => !DEFAULT_OFF.has(id)));
      grants.set(k, set);
    }
    return set;
  };

  const view = async (orgId: string, agentId: string) => {
    const list = await connectors(orgId);
    const set = await granted(orgId, agentId);
    // Approval-gated scopes are always on: they can only ever ask.
    const gated = list.flatMap((c) => c.scopes.filter((s) => s.requiresApproval).map((s) => s.id));
    return { connectors: clone(list), granted: [...new Set([...set, ...gated])] };
  };

  return {
    get: view,
    set: async (orgId, agentId, ids) => {
      const valid = new Set((await connectors(orgId)).flatMap((c) => c.scopes.map((s) => s.id)));
      grants.set(key(orgId, agentId), new Set(ids.filter((id) => valid.has(id))));
      return view(orgId, agentId);
    },
    connectors: async (orgId) => clone(await connectors(orgId)),
  };
}
