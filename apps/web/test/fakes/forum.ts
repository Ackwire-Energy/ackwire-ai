/**
 * Test fake — the forum. Expected shapes (`ForumTopic`, `ForumPost`) until
 * the backend's routes land: `GET/POST …/forum/topics`, `GET …/forum/topics/{id}`,
 * `POST …/posts|conclude|cancel|issues`.
 */
import type { ApiClient } from "@/api/client";
import type { ForumPost, ForumTopicDetail } from "@/api/types";
import { clone, type MockContext, MockNotFoundError, minutesAgo, mockId, perOrg } from "./context";

export function createFakeForum(
  ctx: MockContext,
  log: (method: string, ...args: unknown[]) => void,
): ApiClient["forum"] {
  const store = perOrg(async (orgId) => {
    const topics: ForumTopicDetail[] = [];
    if (!ctx.seed) return topics;
    const agents = await ctx.lookup.agents(orgId);
    const me = await ctx.lookup.me();
    const [a1, a2] = agents;
    if (!a1 || !me) return topics;
    const now = ctx.now();
    const meId = me.user.id;
    const post = (
      id: string,
      topicId: string,
      round: number,
      author: ForumPost["author"],
      body: string,
      m: number,
    ) => ({
      id,
      topicId,
      round,
      author,
      body,
      agentRunId: author.type === "agent" ? `run-${id}` : null,
      createdAt: minutesAgo(now, m),
    });
    topics.push({
      id: "topic-pricing",
      channelId: "chan-topic-pricing",
      originChannelId: null,
      activeAgentIds: [],
      title: "Plano de preços do Q1",
      goal: "Decidir se mudamos o plano de entrada para US$ 19 e o que entra nele.",
      status: "open",
      round: 2,
      rounds: 3,
      agentIds: [a1.id, ...(a2 ? [a2.id] : [])],
      userIds: [meId],
      createdBy: { type: "person", id: meId },
      createdAt: minutesAgo(now, 90),
      lastActivityAt: minutesAgo(now, 4),
      costUsd: 0.42,
      budgetUsd: 2,
      synthesis: null,
      posts: [
        post("p1", "topic-pricing", 1, { type: "agent", id: a1.id }, "Proponho US$ 19 com 3 agentes e 1 GB.", 80),
        ...(a2
          ? [post("p2", "topic-pricing", 1, { type: "agent", id: a2.id }, "Concordo, mas o PC deveria ficar fora.", 70)]
          : []),
        post("p3", "topic-pricing", 1, { type: "person", id: meId }, "Lembrem do custo do PC por hora.", 60),
        post("p4", "topic-pricing", 2, { type: "agent", id: a1.id }, "Com o PC fora, a margem fica em 62%.", 4),
      ],
    });
    topics.push({
      id: "topic-onboarding",
      channelId: "chan-topic-onboarding",
      originChannelId: null,
      activeAgentIds: [],
      title: "Onboarding em 5 minutos",
      goal: "Achar os três passos que mais travam quem chega.",
      status: "done",
      round: 2,
      rounds: 2,
      agentIds: [a1.id],
      userIds: [],
      createdBy: { type: "agent", id: a1.id },
      createdAt: minutesAgo(now, 60 * 30),
      lastActivityAt: minutesAgo(now, 60 * 26),
      costUsd: 0.31,
      budgetUsd: null,
      synthesis: {
        artifactId: "art-onboarding",
        version: 1,
        suggestedIssues: [
          { title: "Pular a escolha de chave no onboarding", description: "Usar a chave da plataforma por padrão." },
          { title: "Exemplo pronto no primeiro canal", description: "Uma conversa de exemplo com o agente." },
        ],
      },
      posts: [
        post(
          "p9",
          "topic-onboarding",
          1,
          { type: "agent", id: a1.id },
          "O passo da chave é o que mais trava.",
          60 * 29,
        ),
        {
          ...post(
            "p10",
            "topic-onboarding",
            2,
            { type: "agent", id: a1.id },
            "Síntese: três passos a cortar.",
            60 * 26,
          ),
          meta: { synthesis: true },
        },
      ],
    });
    return topics;
  });
  const find = async (orgId: string, id: string) => {
    const t = (await store(orgId)).find((x) => x.id === id);
    if (!t) throw new MockNotFoundError("Topic not found");
    return t;
  };
  const summary = ({ posts: _p, ...t }: ForumTopicDetail) => clone(t);
  return {
    list: async (orgId) => (await store(orgId)).map(summary),
    get: async (orgId, id) => clone(await find(orgId, id)),
    create: async (orgId, input) => {
      log("forum.create", orgId, input);
      const me = await ctx.lookup.me();
      const now = ctx.now().toISOString();
      const topicId = mockId("topic");
      const topic: ForumTopicDetail = {
        id: topicId,
        channelId: `chan-${topicId}`,
        originChannelId: null,
        title: input.title,
        goal: input.goal,
        status: "open",
        round: 1,
        rounds: input.rounds,
        agentIds: input.agentIds,
        userIds: input.userIds,
        createdBy: { type: "person", id: me?.user.id ?? "" },
        createdAt: now,
        lastActivityAt: now,
        costUsd: 0,
        budgetUsd: input.budgetUsd ?? null,
        activeAgentIds: input.agentIds.slice(0, 1),
        synthesis: null,
        posts: [],
      };
      (await store(orgId)).unshift(topic);
      return clone(topic);
    },
    post: async (orgId, id, body) => {
      log("forum.post", orgId, id, body);
      const t = await find(orgId, id);
      const me = await ctx.lookup.me();
      const p: ForumPost = {
        id: mockId("post"),
        topicId: id,
        round: t.round,
        author: { type: "person", id: me?.user.id ?? "" },
        body,
        agentRunId: null,
        createdAt: ctx.now().toISOString(),
      };
      t.posts.push(p);
      t.lastActivityAt = p.createdAt;
      return clone(p);
    },
    conclude: async (orgId, id) => {
      log("forum.conclude", orgId, id);
      const t = await find(orgId, id);
      t.status = "done";
      t.synthesis = t.synthesis ?? { artifactId: `art-${id}`, version: 1, suggestedIssues: [] };
      return clone(t);
    },
    cancel: async (orgId, id) => {
      log("forum.cancel", orgId, id);
      const t = await find(orgId, id);
      t.status = "canceled";
      return clone(t);
    },
    participants: async (orgId, id, input) => {
      log("forum.participants", orgId, id, input);
      const t = await find(orgId, id);
      t.agentIds = [...t.agentIds.filter((x) => !input.removeAgentIds?.includes(x)), ...(input.addAgentIds ?? [])];
      t.userIds = [...t.userIds.filter((x) => !input.removeUserIds?.includes(x)), ...(input.addUserIds ?? [])];
      return clone(t);
    },
    createIssues: async (orgId, id, items) => {
      log("forum.createIssues", orgId, id, items);
      return { numbers: items.map((_, i) => 100 + i) };
    },
  };
}
