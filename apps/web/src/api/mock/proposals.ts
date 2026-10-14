/**
 * MOCK — improvement proposals (an agent proposes changing its own
 * instructions or the organization context; nothing changes until a person
 * accepts).
 * Waiting for: GET /api/app/organizations/{orgId}/proposals,
 * POST .../proposals/{id}/accept { text? } (applies the change server-side),
 * POST .../proposals/{id}/refuse (stored as a lesson).
 */
import type { MockedApi } from "../client";
import type { Proposal } from "../types";
import { clone, type MockContext, MockNotFoundError, minutesAgo, mockId, perOrg } from "./context";

export function createMockProposals(ctx: MockContext): MockedApi["proposals"] {
  const store = perOrg<Proposal[]>(async (orgId) => {
    if (!ctx.seed) return [];
    const [agents, members] = await Promise.all([ctx.lookup.agents(orgId), ctx.lookup.members(orgId).catch(() => [])]);
    const [a, b, c] = [agents[0], agents[1] ?? agents[0], agents[2] ?? agents[0]];
    if (!a || !b || !c) return [];
    const now = ctx.now();
    const owner = (agentId: string) => {
      const ownerId = agents.find((x) => x.id === agentId)?.ownerUserId;
      const m = members.find((x) => x.userId === ownerId) ?? members[0];
      return m ? ({ type: "user", userId: m.userId, name: m.name } as const) : ({ type: "admins" } as const);
    };
    const someone = members[1] ?? members[0];
    return [
      {
        id: mockId("prop"),
        agentId: a.id,
        target: { type: "agent_instructions", agentId: a.id },
        title: "Manter PRs pequenos e pedir revisão do João em pagamentos",
        why: "O João corrigiu a Ada três vezes pelo mesmo motivo e recusou um merge que mexia em pagamentos sem revisão.",
        evidence: [
          { where: "#eng · 13 out", what: "João: “quebra esse PR em dois, tá grande demais”" },
          { where: "#eng · 11 out", what: "João: “PR acima de 300 linhas eu não consigo revisar direito”" },
          { where: "Aprovação recusada · 8 out", what: "Merge do PR #31 (cobrança): “precisa passar por mim antes”" },
        ],
        before: [
          "Programa em branches, nunca direto na main.",
          "Abre PRs pequenos, com teste para cada correção.",
          "Explica a causa antes da solução.",
          "Pede ajuda ao João quando a mudança tocar em pagamentos.",
        ].join("\n"),
        after: [
          "Programa em branches, nunca direto na main.",
          "Abre PRs de até 300 linhas; se passar disso, divide em PRs menores.",
          "Abre PRs pequenos, com teste para cada correção.",
          "Explica a causa antes da solução.",
          "Antes de abrir PR que toque em pagamentos, pede revisão do João no canal.",
        ].join("\n"),
        status: "pending",
        decider: owner(a.id),
        createdAt: minutesAgo(now, 60),
        decidedBy: null,
        decidedAt: null,
      },
      {
        id: mockId("prop"),
        agentId: b.id,
        target: { type: "org_context" },
        title: "Registrar que deploy só acontece de segunda a quinta",
        why: "A regra de deploy apareceu em quatro conversas e foi confirmada pelo Walter.",
        evidence: [
          { where: "#eng · 10 out", what: "Walter: “sexta não tem deploy, nem depois das 18h”" },
          { where: "#geral · 3 out", what: "Marina perguntou e o João confirmou a regra" },
        ],
        before: ["Prioridade do trimestre: estabilidade do login e do agendamento.", "Tom: direto e gentil."].join(
          "\n",
        ),
        after: [
          "Prioridade do trimestre: estabilidade do login e do agendamento.",
          "Deploy em produção só de segunda a quinta, depois das 18h.",
          "Tom: direto e gentil.",
        ].join("\n"),
        status: "pending",
        decider: { type: "admins" },
        createdAt: minutesAgo(now, 26 * 60),
        decidedBy: null,
        decidedAt: null,
      },
      {
        id: mockId("prop"),
        agentId: c.id,
        target: { type: "agent_instructions", agentId: c.id },
        title: "Citar a fonte de cada número nas tabelas",
        why: "Marina pediu duas vezes a origem dos números de reviews.",
        evidence: [{ where: "#produto · 8 out", what: "Marina: “de onde saiu esse 31?”" }],
        before: "Monta tabelas com os dados encontrados.",
        after: "Monta tabelas com os dados encontrados e cita a fonte de cada número.",
        status: "accepted",
        decider: owner(c.id),
        createdAt: minutesAgo(now, 5 * 24 * 60),
        decidedBy: someone ? { userId: someone.userId, name: someone.name } : null,
        decidedAt: minutesAgo(now, 5 * 24 * 60 - 30),
      },
    ];
  });

  const decide = async (orgId: string, id: string, status: "accepted" | "refused", finalText?: string) => {
    const item = (await store(orgId)).find((p) => p.id === id);
    if (!item) throw new MockNotFoundError("Proposal not found");
    const me = await ctx.lookup.me();
    item.status = status;
    if (finalText !== undefined) item.after = finalText;
    item.decidedBy = me ? { userId: me.user.id, name: me.user.name } : null;
    item.decidedAt = ctx.now().toISOString();
    return clone(item);
  };

  return {
    list: async (orgId) => clone(await store(orgId)),
    accept: (orgId, id, finalText) => decide(orgId, id, "accepted", finalText),
    refuse: (orgId, id) => decide(orgId, id, "refused"),
  };
}
