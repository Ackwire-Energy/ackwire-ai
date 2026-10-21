/**
 * Test fake — the forum (apps/server/src/routes/app/forum.ts): topics
 * with seats, the round track, stances, syntheses (decision or plan) and the
 * actions (post, conclude, cancel, pass, resume, participants, issues,
 * suggestions). The track is rebuilt from the posts on every read.
 */
import type {
  ApiClient,
  ForumPost,
  ForumSeat,
  ForumSuggestion,
  ForumSynthesis,
  ForumTopic,
  ForumTopicDetail,
  ForumTrack,
} from "@agenteschat/client";
import { clone, type MockContext, MockNotFoundError, minutesAgo, mockId, perOrg } from "./context";

const origin = (over: Partial<ForumTopic["origin"]> = {}): ForumTopic["origin"] => ({
  kind: "direct",
  channelId: null,
  messageId: null,
  issueId: null,
  issueNumber: null,
  routineId: null,
  agentId: null,
  ...over,
});

/** Each seat's turn per round, from the posts (spoke / skipped / pending), and the synthesis. */
export function fakeTrack(t: Omit<ForumTopicDetail, "track">): ForumTrack {
  const seats: ForumSeat[] = t.seats.length ? t.seats : t.agentIds.map((id) => ({ type: "agent", id }));
  const ended = t.status === "done" || t.status === "canceled";
  const last = ended ? Math.max(1, t.round) : Math.max(1, t.rounds, t.round);
  const rounds: ForumTrack["rounds"] = [];
  for (let round = 1; round <= last; round++) {
    const personPosts = t.posts
      .filter((p) => p.kind === "free" && p.round + 1 === round)
      .map((p) => ({ userId: p.author.id, postId: p.id, length: p.body.length }));
    const entries = seats.map((seat) => {
      const post = t.posts.find(
        (p) =>
          p.round === round &&
          p.author.type === seat.type &&
          p.author.id === seat.id &&
          (p.kind === "turn" || p.kind === "seat"),
      );
      if (post) return { seat, status: "spoke" as const, postId: post.id, length: post.body.length };
      if (t.status === "open" && t.phase === "waiting_person" && t.waitingUserId === seat.id && round === t.round)
        return { seat, status: "waiting" as const, postId: null, length: 0 };
      const passed = ended || round < t.round;
      return { seat, status: passed ? ("skipped" as const) : ("pending" as const), postId: null, length: 0 };
    });
    rounds.push({ round, personPosts, entries });
  }
  const synthesis: ForumTrack["synthesis"] =
    t.status === "done" && t.synthesis
      ? { agentId: t.ownerAgentId ?? t.agentIds[0] ?? null, status: "done", revision: t.synthesis.revision }
      : t.status === "open" && t.phase === "synthesizing"
        ? { agentId: null, status: "live", revision: 1 }
        : null;
  return { rounds, synthesis };
}

const synthesisOf = (artifactId: string, over: Partial<ForumSynthesis> = {}): ForumSynthesis => ({
  artifactId,
  version: 1,
  revision: 1,
  format: "decision",
  suggestedIssues: [],
  structured: null,
  versions: [],
  createdIssues: [],
  ...over,
});

export function createFakeForum(
  ctx: MockContext,
  log: (method: string, ...args: unknown[]) => void,
): ApiClient["forum"] {
  const store = perOrg(async (orgId) => {
    const topics: Omit<ForumTopicDetail, "track">[] = [];
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
      over: Partial<ForumPost> = {},
    ): ForumPost => ({
      id,
      topicId,
      round,
      author,
      body,
      agentRunId: author.type === "agent" ? `run-${id}` : null,
      kind: author.type === "agent" ? "turn" : "free",
      stance: null,
      replyTo: null,
      position: null,
      createdAt: minutesAgo(now, m),
      ...over,
    });
    const base = {
      originChannelId: null,
      activeAgentIds: [],
      responsibleUserId: meId,
      requestedByUserId: null,
      ownerAgentId: null,
      deadline: null,
      waitingUserId: null,
      stall: null,
      reopened: null,
      syntheses: [],
    };
    topics.push({
      ...base,
      id: "topic-pricing",
      channelId: "chan-topic-pricing",
      origin: origin(),
      title: "Plano de preços do Q1",
      goal: "Decidir se mudamos o plano de entrada para US$ 19 e o que entra nele.",
      status: "open",
      phase: "discussing",
      format: "decision",
      round: 2,
      rounds: 3,
      agentIds: [a1.id, ...(a2 ? [a2.id] : [])],
      userIds: [meId],
      seats: [],
      createdBy: { type: "person", id: meId },
      createdAt: minutesAgo(now, 90),
      lastActivityAt: minutesAgo(now, 4),
      synthesis: null,
      posts: [
        post("p1", "topic-pricing", 1, { type: "agent", id: a1.id }, "Proponho US$ 19 com 3 agentes e 1 GB.", 80, {
          stance: { kind: "propose" },
          position: "US$ 19 com 3 agentes",
        }),
        ...(a2
          ? [
              post(
                "p2",
                "topic-pricing",
                1,
                { type: "agent", id: a2.id },
                "Concordo, mas o PC deveria ficar fora.",
                70,
                {
                  stance: { kind: "agree", target: { type: "agent", id: a1.id } },
                  replyTo: "p1",
                  position: "A favor, sem o PC",
                },
              ),
            ]
          : []),
        post("p3", "topic-pricing", 1, { type: "person", id: meId }, "Lembrem do custo do PC por hora.", 60),
        post("p4", "topic-pricing", 2, { type: "agent", id: a1.id }, "Com o PC fora, a margem fica em 62%.", 4, {
          stance: { kind: "shift" },
          replyTo: "p3",
          position: "Sem o PC, margem de 62%",
        }),
      ],
    });
    topics.push({
      ...base,
      id: "topic-onboarding",
      channelId: "chan-topic-onboarding",
      origin: origin(),
      title: "Onboarding em 5 minutos",
      goal: "Achar os três passos que mais travam quem chega.",
      status: "done",
      phase: "finished",
      format: "decision",
      round: 2,
      rounds: 2,
      agentIds: [a1.id, ...(a2 ? [a2.id] : [])],
      userIds: [],
      seats: [],
      createdBy: { type: "agent", id: a1.id },
      createdAt: minutesAgo(now, 60 * 30),
      lastActivityAt: minutesAgo(now, 60 * 26),
      synthesis: synthesisOf("art-onboarding", {
        suggestedIssues: [
          { title: "Pular a escolha de chave no onboarding", description: "Usar a chave da plataforma por padrão." },
          { title: "Exemplo pronto no primeiro canal", description: "Uma conversa de exemplo com o agente." },
        ],
        structured: {
          format: "decision",
          decision: "Cortar a escolha de chave, o tour e o convite do primeiro minuto.",
          positions: [{ agentId: a1.id, name: a1.name, pros: ["Menos passos"], cons: ["Menos controle no início"] }],
          openQuestions: ["Medimos o tempo até a primeira resposta?"],
          nextSteps: [],
          suggestedIssues: [],
          changes: [],
        },
      }),
      posts: [
        post(
          "p9",
          "topic-onboarding",
          1,
          { type: "agent", id: a1.id },
          "O passo da chave é o que mais trava.",
          60 * 29,
          {
            stance: { kind: "propose" },
          },
        ),
        post("p10", "topic-onboarding", 2, { type: "agent", id: a1.id }, "Síntese: três passos a cortar.", 60 * 26, {
          kind: "synthesis",
          agentRunId: null,
        }),
      ],
    });
    return topics;
  });
  const view = (t: Omit<ForumTopicDetail, "track">): ForumTopicDetail => clone({ ...t, track: fakeTrack(t) });
  const find = async (orgId: string, id: string) => {
    const t = (await store(orgId)).find((x) => x.id === id);
    if (!t) throw new MockNotFoundError("Topic not found");
    return t;
  };
  const summary = (t: Omit<ForumTopicDetail, "track">): ForumTopic => {
    const { posts: _p, syntheses: _s, ...rest } = view(t);
    return rest;
  };
  const suggestions = new Map<string, ForumSuggestion>();
  return {
    list: async (orgId) => (await store(orgId)).map(summary),
    get: async (orgId, id) => view(await find(orgId, id)),
    create: async (orgId, input) => {
      log("forum.create", orgId, input);
      const me = await ctx.lookup.me();
      const now = ctx.now().toISOString();
      const topicId = mockId("topic");
      const topic: Omit<ForumTopicDetail, "track"> = {
        id: topicId,
        channelId: `chan-${topicId}`,
        originChannelId: null,
        origin: origin(input.originIssueId ? { kind: "issue", issueId: input.originIssueId } : {}),
        title: input.title,
        goal: input.goal,
        status: "open",
        phase: "discussing",
        format: input.format ?? "decision",
        round: 1,
        rounds: input.rounds ?? 3,
        agentIds: input.agentIds,
        userIds: input.userIds ?? [],
        seats: input.seats ?? [],
        createdBy: { type: "person", id: me?.user.id ?? "" },
        responsibleUserId: me?.user.id ?? null,
        requestedByUserId: null,
        ownerAgentId: input.ownerAgentId ?? null,
        deadline: input.deadline ?? null,
        waitingUserId: null,
        stall: null,
        reopened: null,
        createdAt: now,
        lastActivityAt: now,
        activeAgentIds: input.agentIds.slice(0, 1),
        synthesis: null,
        posts: [],
        syntheses: [],
      };
      (await store(orgId)).unshift(topic);
      return view(topic);
    },
    post: async (orgId, id, input) => {
      log("forum.post", orgId, id, input);
      const t = await find(orgId, id);
      const me = await ctx.lookup.me();
      const seat = t.phase === "waiting_person" && t.waitingUserId === me?.user.id;
      const p: ForumPost = {
        id: mockId("post"),
        topicId: id,
        round: Math.max(1, t.round),
        author: { type: "person", id: me?.user.id ?? "" },
        body: input.body,
        agentRunId: null,
        kind: t.status === "done" && !input.requestRound ? "comment" : seat ? "seat" : "free",
        stance: null,
        replyTo: input.replyTo ?? null,
        position: null,
        ...(input.requestRound ? { requestRound: { agentIds: input.requestRound.agentIds ?? null } } : {}),
        createdAt: ctx.now().toISOString(),
      };
      t.posts.push(p);
      t.lastActivityAt = p.createdAt;
      if (input.requestRound && t.status === "done") {
        t.status = "open";
        t.phase = "discussing";
        t.round += 1;
        t.rounds = Math.max(t.rounds, t.round);
        t.reopened = { byUserId: me?.user.id ?? "", at: p.createdAt };
      }
      if (seat) {
        t.phase = "discussing";
        t.waitingUserId = null;
      }
      return clone(p);
    },
    conclude: async (orgId, id) => {
      log("forum.conclude", orgId, id);
      const t = await find(orgId, id);
      t.status = "done";
      t.phase = "finished";
      t.activeAgentIds = [];
      t.synthesis = t.synthesis ?? synthesisOf(`art-${id}`);
      return view(t);
    },
    cancel: async (orgId, id) => {
      log("forum.cancel", orgId, id);
      const t = await find(orgId, id);
      t.status = "canceled";
      t.phase = "finished";
      t.activeAgentIds = [];
      return view(t);
    },
    pass: async (orgId, id) => {
      log("forum.pass", orgId, id);
      const t = await find(orgId, id);
      t.phase = "discussing";
      t.waitingUserId = null;
      return view(t);
    },
    resume: async (orgId, id) => {
      log("forum.resume", orgId, id);
      const t = await find(orgId, id);
      t.status = "open";
      t.stall = null;
      return view(t);
    },
    participants: async (orgId, id, input) => {
      log("forum.participants", orgId, id, input);
      const t = await find(orgId, id);
      t.agentIds = [...t.agentIds.filter((x) => !input.removeAgentIds?.includes(x)), ...(input.addAgentIds ?? [])];
      t.userIds = [...t.userIds.filter((x) => !input.removeUserIds?.includes(x)), ...(input.addUserIds ?? [])];
      return view(t);
    },
    createIssues: async (orgId, id, items) => {
      log("forum.createIssues", orgId, id, items);
      const t = await find(orgId, id);
      const issues = items.map((it, i) => ({ id: mockId("issue"), number: 100 + i, title: it.title }));
      if (t.synthesis) t.synthesis.createdIssues = [...t.synthesis.createdIssues, ...issues];
      return { numbers: issues.map((i) => i.number), issues };
    },
    acceptSuggestion: async (orgId, messageId, overrides) => {
      log("forum.acceptSuggestion", orgId, messageId, overrides);
      const me = await ctx.lookup.me();
      const s = suggestions.get(messageId);
      const agents = await ctx.lookup.agents(orgId);
      const topic = await createFakeForumTopic(orgId, {
        title: overrides?.title ?? s?.title ?? "",
        goal: overrides?.goal ?? s?.goal ?? "",
        agentIds: overrides?.agentIds ?? s?.agentIds ?? agents.slice(0, 2).map((a) => a.id),
      });
      const suggestion: ForumSuggestion = {
        title: topic.title,
        goal: topic.goal,
        agentIds: topic.agentIds,
        rounds: topic.rounds,
        format: topic.format,
        suggestedByAgentId: s?.suggestedByAgentId ?? agents[0]?.id ?? "",
        state: "accepted",
        topicId: topic.id,
        decidedByUserId: me?.user.id ?? null,
        decidedAt: ctx.now().toISOString(),
      };
      suggestions.set(messageId, suggestion);
      return { topic, suggestion };
    },
    dismissSuggestion: async (orgId, messageId) => {
      log("forum.dismissSuggestion", orgId, messageId);
      const me = await ctx.lookup.me();
      const agents = await ctx.lookup.agents(orgId);
      const suggestion: ForumSuggestion = {
        title: "",
        goal: "",
        agentIds: [],
        rounds: 3,
        format: "decision",
        suggestedByAgentId: agents[0]?.id ?? "",
        ...suggestions.get(messageId),
        state: "dismissed",
        topicId: null,
        decidedByUserId: me?.user.id ?? null,
        decidedAt: ctx.now().toISOString(),
      };
      suggestions.set(messageId, suggestion);
      return { suggestion };
    },
  };
  async function createFakeForumTopic(orgId: string, input: { title: string; goal: string; agentIds: string[] }) {
    const now = ctx.now().toISOString();
    const me = await ctx.lookup.me();
    const topicId = mockId("topic");
    const topic: Omit<ForumTopicDetail, "track"> = {
      id: topicId,
      channelId: `chan-${topicId}`,
      originChannelId: null,
      origin: origin({ kind: "suggestion" }),
      title: input.title,
      goal: input.goal,
      status: "open",
      phase: "discussing",
      format: "decision",
      round: 1,
      rounds: 3,
      agentIds: input.agentIds,
      userIds: [],
      seats: [],
      createdBy: { type: "person", id: me?.user.id ?? "" },
      responsibleUserId: me?.user.id ?? null,
      requestedByUserId: null,
      ownerAgentId: null,
      deadline: null,
      waitingUserId: null,
      stall: null,
      reopened: null,
      createdAt: now,
      lastActivityAt: now,
      activeAgentIds: input.agentIds.slice(0, 1),
      synthesis: null,
      posts: [],
      syntheses: [],
    };
    (await store(orgId)).unshift(topic);
    return view(topic);
  }
}
