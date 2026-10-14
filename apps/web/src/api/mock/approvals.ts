/**
 * MOCK — approvals (sensitive actions waiting for a person).
 * Waiting for: GET /api/app/organizations/{orgId}/approvals,
 * POST /api/app/organizations/{orgId}/approvals/{id}/decision { decision },
 * and an `approval.*` WebSocket event. Owned by the Tool Gateway workstream.
 */
import type { MockedApi } from "../client";
import type { Approval } from "../types";
import { clone, hoursFromNow, type MockContext, MockNotFoundError, minutesAgo, mockId, perOrg } from "./context";

export function createMockApprovals(ctx: MockContext): MockedApi["approvals"] {
  const store = perOrg<Approval[]>(async (orgId) => {
    if (!ctx.seed) return [];
    const [agents, channels, members, me] = await Promise.all([
      ctx.lookup.agents(orgId),
      ctx.lookup.channels(orgId).catch(() => []),
      ctx.lookup.members(orgId).catch(() => []),
      ctx.lookup.me(),
    ]);
    const first = agents[0];
    if (!first) return [];
    const second = agents[1] ?? first;
    const third = agents[2] ?? first;
    const channel = channels.find((c) => c.isMember) ?? channels[0];
    const other = members.find((m) => m.userId !== me?.user.id);
    const now = ctx.now();
    const base = { channelId: channel?.id ?? null, decidedBy: null, decidedAt: null, diffUrl: null };
    return [
      {
        ...base,
        id: mockId("apr"),
        agentId: first.id,
        title: "Fazer merge do PR #42 em main",
        detail: "github.merge · agentes-chat/app · PR 42 · testes passando",
        action: "merge",
        diffUrl: "https://github.com/agentes-chat/app/pull/42/files",
        status: "pending",
        createdAt: minutesAgo(now, 2),
        expiresAt: hoursFromNow(now, 23),
      },
      {
        ...base,
        id: mockId("apr"),
        agentId: second.id,
        title: "Fazer deploy da versão 1.8.2 em produção",
        detail: "vercel.deploy · app · produção · 3 commits desde 1.8.1",
        action: "deploy",
        status: "pending",
        createdAt: minutesAgo(now, 14),
        expiresAt: hoursFromNow(now, 22),
      },
      {
        ...base,
        id: mockId("apr"),
        agentId: second.id,
        title: "Fazer rollback da 1.8.0 para 1.7.9",
        detail: "vercel.rollback · app · produção",
        action: "rollback",
        status: "approved",
        createdAt: minutesAgo(now, 26 * 60),
        expiresAt: hoursFromNow(now, -2),
        decidedBy: other ? { userId: other.userId, name: other.name } : null,
        decidedAt: minutesAgo(now, 22 * 60),
      },
      {
        ...base,
        id: mockId("apr"),
        agentId: third.id,
        title: "Publicar o roadmap do trimestre no fórum",
        detail: "forum.publish · tópico novo · visível para toda a org",
        action: "publish",
        status: "refused",
        createdAt: minutesAgo(now, 30 * 60),
        expiresAt: hoursFromNow(now, -6),
        decidedBy: me ? { userId: me.user.id, name: me.user.name } : null,
        decidedAt: minutesAgo(now, 29 * 60),
      },
    ];
  });

  return {
    list: async (orgId) => clone(await store(orgId)),
    decide: async (orgId, approvalId, decision) => {
      const items = await store(orgId);
      const item = items.find((a) => a.id === approvalId);
      if (!item) throw new MockNotFoundError("Approval not found");
      const me = await ctx.lookup.me();
      item.status = decision;
      item.decidedBy = me ? { userId: me.user.id, name: me.user.name } : null;
      item.decidedAt = ctx.now().toISOString();
      return clone(item);
    },
  };
}
