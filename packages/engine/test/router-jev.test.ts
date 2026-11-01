import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  AGENT_CHIME_IN_SCORE,
  addChannelMember,
  createAgent,
  createAgentRuns,
  createChannel,
  createJevJudge,
  createJevKey,
  createJevRouterStrategy,
  createJobHandlers,
  createLlmJudge,
  DEFAULT_ROUTER_POLICY,
  drainOutbox,
  insertMessage,
  JevOffError,
  jevCostNanoUsd,
  loadReplyPolicy,
  messageRouter,
  postPersonMessage,
  RouterChainEnd,
  RouterSkip,
  type RouterStrategy,
  type RoutingCandidate,
  type RoutingInput,
  routeChain,
  routeMessage,
  SPOKEN_TO,
  selectAgents,
  standingJudge,
  withJudgeFallback,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const cand = (agentId: string): RoutingCandidate => ({ agentId, handle: agentId, name: agentId, role: "", about: "" });
const policy = { minScore: 0.5, maxAgents: 2, maxHops: 3, continuityMinScore: 0.3, singleAgentMinScore: 0.35 };

describe("policy in code", () => {
  test("continuity lowers the bar for the agent the person was just talking to, even past a low need score", () => {
    const result = {
      agents: [
        { agentId: "a", score: 0.32 },
        { agentId: "b", score: 0.45 },
      ],
      needsAgent: 0.3,
    };
    expect(selectAgents([cand("a"), cand("b")], result, policy)).toEqual([]);
    expect(selectAgents([cand("a"), cand("b")], result, policy, { continuityAgentId: "a" })).toEqual(["a"]);
    expect(
      selectAgents([cand("a"), cand("b")], { ...result, agents: [{ agentId: "a", score: 0.2 }] }, policy, {
        continuityAgentId: "a",
      }),
    ).toEqual([]);
  });

  test("the only agent of a room answers a greeting at a lower bar; with two agents it doesn't", () => {
    expect(selectAgents([cand("a")], { agents: [{ agentId: "a", score: 0.4 }], needsAgent: 0.4 }, policy)).toEqual([
      "a",
    ]);
    expect(
      selectAgents([cand("a"), cand("b")], { agents: [{ agentId: "a", score: 0.4 }], needsAgent: 0.4 }, policy),
    ).toEqual([]);
  });
});

describe("routeChain", () => {
  const input = { orgId: "o", candidates: [cand("a")] } as unknown as RoutingInput;
  const step = (name: string, decide: RouterStrategy["decide"]): RouterStrategy => ({ name, decide });
  const decides = (name: string) => step(name, async () => ({ agents: [{ agentId: "a", score: 0.9 }] }));
  const fails = (name: string, message: string) => step(name, async () => Promise.reject(new Error(message)));
  const skips = (name: string, error: Error) => step(name, async () => Promise.reject(error));

  test("the first step that decides wins, under its own name, with the failures before it; a skip leaves no trace", async () => {
    const timings: unknown[][] = [];
    const chain = routeChain(
      [
        skips("jev", new JevOffError()),
        fails("llm", "no answer in 8 s"),
        skips("x", new RouterSkip()),
        decides("plan"),
      ],
      {
        onTiming: (name, ms, attrs) => {
          if (name === "router_step_ms" && ms >= 0) timings.push([attrs.step, attrs.outcome]);
        },
      },
    );
    expect(await chain.decide(input)).toEqual({
      agents: [{ agentId: "a", score: 0.9 }],
      strategy: "plan",
      failures: ["llm: no answer in 8 s"],
    });
    expect(timings).toEqual([
      ["jev", "skipped"],
      ["llm", "failed"],
      ["x", "skipped"],
      ["plan", "decided"],
    ]);
    // The first step decides: no failures at all.
    expect(await routeChain([decides("jev"), fails("llm", "never asked")]).decide(input)).toEqual({
      agents: [{ agentId: "a", score: 0.9 }],
      strategy: "jev",
    });
  });

  test("no step decides: what failed goes to the rules", async () => {
    const error = await routeChain([fails("jev", "TypeSafe answered 529"), skips("llm", new RouterSkip())])
      .decide(input)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RouterChainEnd);
    expect((error as RouterChainEnd).failures).toEqual(["jev: TypeSafe answered 529"]);
  });
});

/**
 * A fake TypeSafe endpoint: records requests, answers with scripted nouls per handle, `choice`, the tie-break
 * Choice's probabilities by handle (default 0.9 for `best`), and `to`, the addressee Choice's (none: "none").
 */
function fakeJev(
  script: (state: Record<string, unknown>) =>
    | {
        nouls: Record<string, number>;
        needs: number;
        best?: string;
        choice?: Record<string, number>;
        everyone?: number;
        to?: Record<string, number>;
      }
    | Error,
) {
  const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      state: Record<string, unknown>;
      questions: Record<string, { instructions: { agent?: { handle: string } } }>;
    };
    requests.push({ headers: new Headers(init.headers), body });
    const r = script(body.state);
    if (r instanceof Error) return new Response("boom", { status: 529 });
    const answers: Record<string, unknown> = { needs_agent: { type: "noul", noul: r.needs } };
    for (const [key, q] of Object.entries(body.questions)) {
      if (key.startsWith("agent_"))
        answers[key] = { type: "noul", noul: r.nouls[q.instructions.agent?.handle ?? ""] ?? 0 };
    }
    if (body.questions.for_everyone) answers.for_everyone = { type: "noul", noul: r.everyone ?? 0 };
    if (body.questions.best_agent) {
      answers.best_agent = {
        type: "choice",
        choice: r.best ?? "none",
        probabilities: r.choice ?? { [r.best ?? "none"]: 0.9 },
        confidence: r.choice?.[r.best ?? "none"] ?? 0.8,
      };
    }
    if (body.questions.addressee) {
      const to = r.to ?? { none: 1 };
      const [choice] = Object.entries(to).sort((a, b) => b[1] - a[1])[0] ?? ["none"];
      answers.addressee = { type: "choice", choice, probabilities: to, confidence: 0.8 };
    }
    return Response.json({ model: "jev-1.14.0", answers, usage: { input_tokens: 1200, output_tokens: 30 } });
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}

const post = (fx: Fixture, body: string, threadId?: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body, threadId });

describe("Jev's questions", () => {
  test("name a message to the room in both languages, for every agent and for each one", async () => {
    const jev = fakeJev(() => ({ nouls: {}, needs: 0.9 }));
    await createJevRouterStrategy({ key: "k", recordUsage: async () => {}, fetch: jev.fetcher }).decide({
      orgId: "o",
      channel: { id: "c", name: "geral", topic: "" },
      message: { id: "m", author: "ana", body: "e agora, vocês dois?" },
      thread: [],
      candidates: [cand("dev"), cand("qa")],
    });
    const questions = jev.requests[0]?.body.questions as {
      for_everyone: { instructions: string };
      agent_0: { instructions: { question: string } };
    };
    for (const phrase of ["everyone", "all of you", "gente", "vocês", "agentes"]) {
      expect(questions.for_everyone.instructions).toContain(`"${phrase}"`);
      expect(questions.agent_0.instructions.question).toContain(`"${phrase}"`);
    }
  });

  test("read who each message names and a person's messages in a row as one, and say who those are for", async () => {
    const jev = fakeJev(() => ({ nouls: {}, needs: 0.1 }));
    await createJevRouterStrategy({ key: "k", recordUsage: async () => {}, fetch: jev.fetcher }).decide({
      orgId: "o",
      channel: { id: "c", name: "geral", topic: "" },
      message: { id: "m", author: "ana", body: "boa tarde walter\ncomo esta hoje", names: ["Walter"] },
      thread: [{ author: "@ada", body: "Campanha publicada." }],
      candidates: [cand("ada")],
      aloneWith: "ada",
    });
    const body = jev.requests[0]?.body as {
      state: Record<string, unknown>;
      questions: { needs_agent: { instructions: string }; agent_0: { instructions: { question: string } } };
    };
    expect(body.state).toMatchObject({
      latest_message: { from: "ana", names: ["Walter"], text: "boa tarde walter\ncomo esta hoje" },
      recent_messages: [{ from: "@ada", names: [], text: "Campanha publicada." }],
      alone_with: "@ada",
    });
    for (const text of [body.questions.needs_agent.instructions, body.questions.agent_0.instructions.question]) {
      expect(text).toContain("Messages a person sends in a row continue the same address");
      expect(text).toContain("A message to a person, by @ or by name, is for that person, not for an agent.");
      expect(text).toContain("Greetings and small talk between people get no agent.");
    }
  });
});

describe("who a message speaks to", () => {
  const ada = { ...cand("ada"), name: "Ada", role: "Engenharia" };
  const theo = { ...cand("theo"), name: "Theo" };
  const decide = (answer: Parameters<typeof fakeJev>[0], body: string, more: Partial<RoutingInput> = {}) => {
    const jev = fakeJev(answer);
    const strategy = createJevRouterStrategy({ key: "k", recordUsage: async () => {}, fetch: jev.fetcher });
    const decided = strategy.decide({
      orgId: "o",
      channel: { id: "c", name: "geral", topic: "" },
      message: { id: "m", author: "ana", body },
      thread: [],
      candidates: [ada, theo],
      ...more,
    });
    return { jev, decided };
  };
  const scores = (r: { agents: { agentId: string; score: number }[] }) =>
    Object.fromEntries(r.agents.map((a) => [a.agentId, Math.round(a.score * 100) / 100]));

  test("Jev is asked which agent it speaks to, and an agent it only names as someone to ask is a no", async () => {
    const { jev, decided } = decide(() => ({ nouls: {}, needs: 0.8 }), "ada pergunta pro theo ai qual meu email");
    await decided;
    const questions = jev.requests[0]?.body.questions as {
      needs_agent: { instructions: string };
      agent_1: { instructions: { question: string } };
      best_agent: { instructions: string };
      addressee: { type: string; instructions: string; criteria: Record<string, string> };
    };
    expect(questions.addressee.type).toBe("choice");
    expect(questions.addressee.criteria).toEqual({
      ada: "Ada (@ada), Engenharia",
      theo: "Theo (@theo)",
      none: "No agent in particular.",
    });
    for (const text of [
      questions.needs_agent.instructions,
      questions.agent_1.instructions.question,
      questions.best_agent.instructions,
      questions.addressee.instructions,
    ])
      expect(text).toContain(SPOKEN_TO);
    expect(questions.agent_1.instructions.question).toContain(
      "No when it speaks to another agent, even when it names this one as someone to ask, involve or hand over to",
    );
    // Right after Theo spoke, "pergunta pra Ada se o PR subiu" speaks to Theo.
    expect(SPOKEN_TO).toContain(
      "A follow-up that names another agent only as someone to ask, involve or hand over to still speaks to the agent the person was just talking to",
    );
    expect(questions.addressee.instructions).toContain(
      "The agent the person was just talking to is `agent_just_talking`.",
    );
  });

  test("'ada pergunta pro theo ai qual meu email mais recente pls' is Ada's, not Theo's who has the email", async () => {
    // Jev's answers on 2026-10-31: Theo 0.90, Ada 0.52, needs 0.78, best @theo, and an addressee Choice that
    // hears Ada (assumed: the real Jev hasn't answered it yet).
    const { decided } = decide(
      () => ({
        nouls: { "@theo": 0.9, "@ada": 0.52 },
        needs: 0.78,
        best: "theo",
        to: { ada: 0.86, theo: 0.08, none: 0.06 },
      }),
      "ada pergunta pro theo ai qual meu email mais recente pls",
    );
    const result = await decided;
    expect(result.addressee).toBe("ada");
    // Ada as far as an agent is needed (0.78 × 0.86); Theo only as far as it might speak to him or to nobody.
    expect(scores(result)).toEqual({ ada: 0.67, theo: 0.14 });
    expect(selectAgents([ada, theo], result, policy)).toEqual(["ada"]);
    expect(result.reason).toBe("to @ada (0.86); best @theo (confidence 0.80)");
  });

  test("what worked still does: to Theo by name, to anyone, to everyone, to a person", async () => {
    const to = async (answer: Parameters<typeof fakeJev>[0]) => {
      const result = await decide(answer, "x").decided;
      return { picked: selectAgents([ada, theo], result, policy), addressee: result.addressee };
    };
    // "theo, qual meu email mais recente?"
    expect(
      await to(() => ({
        nouls: { "@theo": 0.92, "@ada": 0.1 },
        needs: 0.9,
        best: "theo",
        to: { theo: 0.9, none: 0.1 },
      })),
    ).toEqual({ picked: ["theo"], addressee: "theo" });
    // "alguém sabe qual meu email mais recente?": whoever can.
    expect(
      await to(() => ({
        nouls: { "@theo": 0.85, "@ada": 0.2 },
        needs: 0.85,
        best: "theo",
        to: { none: 0.9, theo: 0.06, ada: 0.04 },
      })),
    ).toEqual({ picked: ["theo"], addressee: undefined });
    // "agentes, cada um diz seu nome": every agent, whoever the Choice leaned to.
    expect(
      await to(() => ({
        nouls: { "@theo": 0.9, "@ada": 0.9 },
        needs: 0.9,
        everyone: 0.9,
        to: { ada: 0.7, theo: 0.2, none: 0.1 },
      })),
    ).toEqual({ picked: ["ada", "theo"], addressee: undefined });
    // "walter, a ada já terminou o relatório?": a person's.
    expect(
      await to(() => ({ nouls: { "@ada": 0.2, "@theo": 0.05 }, needs: 0.1, to: { none: 0.8, ada: 0.2 } })),
    ).toEqual({ picked: [], addressee: undefined });
  });

  test("unsure which agent it speaks to (under 0.6), the scores stand", async () => {
    // That day's answers with a Choice that only leans to Ada: Theo, as before. Capped and not lifted, nobody was.
    const day = { nouls: { "@theo": 0.9, "@ada": 0.52 }, needs: 0.78, best: "theo" };
    const before = await decide(() => day, "x").decided;
    const leaning = await decide(() => ({ ...day, to: { ada: 0.55, theo: 0.35, none: 0.1 } }), "x").decided;
    expect(leaning.addressee).toBeUndefined();
    expect(leaning.agents).toEqual(before.agents);
    expect(selectAgents([ada, theo], leaning, policy)).toEqual(["theo"]);
    // "alguém sabe qual meu email mais recente?" leaning a little to Ada, who can't help: still Theo, who can.
    const anyone = await decide(
      () => ({ nouls: { "@theo": 0.85, "@ada": 0.2 }, needs: 0.85, best: "theo", to: { ada: 0.53, none: 0.47 } }),
      "x",
    ).decided;
    expect(selectAgents([ada, theo], anyone, policy)).toEqual(["theo"]);
  });

  test("an agent's message isn't asked who it speaks to: another agent chimes in only past its own bar", async () => {
    // "@ada: Theo, confere a agenda?" with Theo at 0.6: the floor from who it speaks to would lift him past 0.75.
    const { jev, decided } = decide(
      () => ({ nouls: { "@theo": 0.6, "@ada": 0.1 }, needs: 0.85, to: { theo: 0.92, none: 0.08 } }),
      "Theo, confere a agenda?",
      { message: { id: "m", author: "@dev", body: "Theo, confere a agenda?" }, authorUserId: null },
    );
    const result = await decided;
    expect(jev.requests[0]?.body.questions).not.toHaveProperty("addressee");
    expect(result.addressee).toBeUndefined();
    expect(scores(result).theo).toBeLessThan(AGENT_CHIME_IN_SCORE);
  });

  /** #general with Ada and Theo besides Dev, and Jev answering as on 2026-10-31 with the addressee Choice. */
  async function team(reply?: NonNullable<Parameters<typeof setup>[0]>["reply"]) {
    f = await setup({ askAgent: true, reply });
    const make = async (name: string, handle: string, role: string) => {
      const a = await createAgent(
        f.db,
        f.owner.id,
        f.org.id,
        { name, handle, role, credentialId: f.credential.id },
        { model: "claude-sonnet-5-5" },
      );
      await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: a.id });
      return a;
    };
    const agents = { ada: await make("Ada", "ada", "Engenharia"), theo: await make("Theo", "theo", "Assistente") };
    const jev = fakeJev((state) =>
      String((state.latest_message as { from: string }).from).startsWith("@")
        ? { nouls: {} as Record<string, number>, needs: 0 }
        : {
            nouls: { "@theo": 0.9, "@ada": 0.52 },
            needs: 0.78,
            best: "theo",
            to: { ada: 0.86, theo: 0.08, none: 0.06 },
          },
    );
    const strategy = createJevRouterStrategy({ key: "k", recordUsage: async () => {}, fetch: jev.fetcher });
    return { ...agents, jev, strategy };
  }
  const decisionOf = async (messageId: string) =>
    (await f.db.select().from(schema.routingDecisions).where(eq(schema.routingDecisions.messageId, messageId)))[0];

  test("the agent spoken to answers, may not pass, and asks the other one itself", async () => {
    const asked = /your question to @theo\]: ([^"\\]+)/;
    const t = await team((req) => {
      const last = JSON.stringify(req.messages.at(-1)?.content);
      if (systemText(req.system).includes("A private conversation between agents"))
        return { chunks: ["O mais recente: Lumen, Proposta revisada."] };
      const heard = asked.exec(last);
      if (heard) return { chunks: [`O Theo disse: ${heard[1]}`] };
      if (last.includes("tool_result")) return { chunks: ["Perguntei ao Theo, já te conto."] };
      return {
        chunks: [],
        toolUses: [{ name: "ask_agent", input: { agent: "@theo", question: "Qual o email mais recente da Ana?" } }],
      };
    });
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", jev: { key: "k", fetch: t.jev.fetcher } },
    });
    const m = await post(f, "ada pergunta pro theo ai qual meu email mais recente pls");
    await drainOutbox(f.db, handlers);

    const decision = await decisionOf(m.id);
    expect(decision?.selectedAgentIds).toEqual([t.ada.id]);
    // Addressed: the follow-up marker, so the reply policy gives Ada no `pass`.
    expect(decision?.reason).toStartWith("follow-up; jev: to @ada (0.86)");
    const runs = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, m.id));
    expect(runs.map((r) => r.agentId)).toEqual([t.ada.id]);
    expect((await loadReplyPolicy(f.db, f.org.id, runs[0]?.id ?? ""))?.mayPass).toBe(false);
    // Theo got no run of his own for Ana's message, so Ada's question to him goes through.
    const [consultation] = await f.db.select().from(schema.agentConsultations);
    expect(consultation).toMatchObject({
      askerAgentId: t.ada.id,
      targetAgentId: t.theo.id,
      status: "answered",
      answer: "O mais recente: Lumen, Proposta revisada.",
    });
  });

  test("right after Theo spoke, a short message or a reply to him that speaks to Ada still goes to Ada", async () => {
    const t = await team();
    const say = (body: string, secondsAgo: number, meta?: Record<string, unknown>) =>
      insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId: f.owner.id },
        body,
        meta,
        createdAt: new Date(Date.now() - secondsAgo * 1000),
      });
    await say("theo, bom dia", 120);
    const hello = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: t.theo.id, runId: null, hop: 1, stretchId: null },
      body: "Bom dia, Ana! Em que posso ajudar?",
      createdAt: new Date(Date.now() - 60_000),
    });
    const route = async (messageId: string) =>
      routeMessage(
        { db: f.db, strategy: t.strategy, policy: { ...DEFAULT_ROUTER_POLICY, maxHops: 3 } },
        { orgId: f.org.id, messageId },
      );
    // Short enough to be a follow-up of the talk with Theo.
    const short = await say("ada, pergunta pro theo meu email", 30);
    expect(await route(short.id)).toMatchObject({ selected: [t.ada.id], continuityAgentId: t.ada.id });
    // A quote reply to Theo's message.
    const reply = await say("ada, confere com o theo meu email mais recente", 0, {
      replyTo: {
        messageId: hello.id,
        author: { type: "agent", id: t.theo.id },
        authorName: "Theo",
        excerpt: "Bom dia",
      },
    });
    expect((await route(reply.id)).selected).toEqual([t.ada.id]);
    expect((await decisionOf(reply.id))?.reason).toStartWith("follow-up");
  });

  test("a reply to Theo that only hands over to Ada stays Theo's: Ada takes a reply only past her own bar", async () => {
    const t = await team();
    // The Choice hears Ada in "isso do deploy é com a ada", but no agent should answer it as for itself.
    const jev = fakeJev(() => ({ nouls: { "@ada": 0.1, "@theo": 0.2 }, needs: 0.15, to: { ada: 0.65, none: 0.35 } }));
    const strategy = createJevRouterStrategy({ key: "k", recordUsage: async () => {}, fetch: jev.fetcher });
    const report = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: t.theo.id, runId: null, hop: 1, stretchId: null },
      body: "Resumo de hoje: 3 emails novos do cliente, e o deploy de ontem falhou no CI.",
      createdAt: new Date(Date.now() - 60_000),
    });
    const handOver = async (where: { threadId?: string; meta?: Record<string, unknown> }) => {
      const m = await insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "person", userId: f.owner.id },
        body: "isso do deploy é com a ada",
        ...where,
      });
      const policy = { ...DEFAULT_ROUTER_POLICY, maxHops: 3 };
      return (await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: m.id })).selected;
    };
    const quoted = { messageId: report.id, author: { type: "agent", id: t.theo.id }, authorName: "Theo", excerpt: "" };
    expect(await handOver({ meta: { replyTo: quoted } })).toEqual([t.theo.id]);
    expect(await handOver({ threadId: report.id })).toEqual([t.theo.id]);
  });
});

describe("the agent a person last talked to", () => {
  /**
   * `by`: an agent (in `runId`, when given), else Ana; `routedTo`: the agents the router sent it to, `working` when
   * their runs on it are still at work; `thread`: in the thread of that line of the talk.
   */
  type Said = [
    by: { id: string; runId?: string } | null,
    text: string,
    minutesAgo: number,
    routedTo?: { id: string }[],
    more?: { working?: boolean; thread?: number; strategy?: string },
  ];

  /** Ana alone with Theo (PM) and Ada (Dev), as in #private on 2026-10-31. */
  async function privateRoom() {
    f = await setup();
    const make = (name: string, role: string) =>
      createAgent(
        f.db,
        f.owner.id,
        f.org.id,
        { name, handle: name.toLowerCase(), role, credentialId: f.credential.id },
        { model: "claude-sonnet-5-5" },
      );
    const theo = await make("Theo", "PM");
    const ada = await make("Ada", "Dev");
    let n = 0;
    /**
     * In a channel of their own: `before` (Ana's, or an agent's), then `body` by Ana (or `by`), routed on Jev's
     * `answer` after the router's quiet wait (`quietMs`, none by default).
     */
    async function talk(
      before: Said[],
      body: string,
      answer: Parameters<typeof fakeJev>[0],
      by: Said[0] = null,
      quietMs = 0,
    ) {
      n += 1;
      const now = Date.now();
      const channel = await createChannel(f.db, f.owner.id, f.org.id, { name: `private-${n}` });
      for (const a of [theo, ada]) await addChannelMember(f.db, f.owner.id, f.org.id, channel.id, { agentId: a.id });
      const said: string[] = [];
      const say = async ([author, text, minutesAgo, routedTo, more]: Said) => {
        const m = await insertMessage(f.db, {
          orgId: f.org.id,
          channelId: channel.id,
          threadId: more?.thread === undefined ? null : said[more.thread],
          author: author
            ? { type: "agent", agentId: author.id, runId: author.runId ?? null, hop: 1, stretchId: null }
            : { type: "person", userId: f.owner.id },
          body: text,
          createdAt: new Date(now - minutesAgo * 60_000),
        });
        if (routedTo) {
          const selectedAgentIds = routedTo.map((a) => a.id);
          await f.db.insert(schema.routingDecisions).values({
            orgId: f.org.id,
            channelId: channel.id,
            messageId: m.id,
            strategy: more?.strategy ?? "jev",
            candidates: [],
            selectedAgentIds,
          });
          if (more?.working) await f.db.transaction((tx) => createAgentRuns(tx, m, selectedAgentIds, "router"));
        }
        said.push(m.id);
        return m;
      };
      for (const line of before) await say(line);
      const m = await say([by, body, 0]);
      const strategy = createJevRouterStrategy({
        key: "k",
        recordUsage: async () => {},
        fetch: fakeJev(answer).fetcher,
      });
      const policy = { ...DEFAULT_ROUTER_POLICY, maxHops: 3 };
      const { selected } = await routeMessage(
        { db: f.db, strategy, policy, quietMs },
        { orgId: f.org.id, messageId: m.id },
      );
      const [decision] = await f.db
        .select()
        .from(schema.routingDecisions)
        .where(eq(schema.routingDecisions.messageId, m.id));
      return { selected, decision };
    }
    return { theo, ada, talk };
  }

  /** Jev on "me de bom dia todo dia ás 8:30 da manha" (2026-10-31): the same Noul for both, the Choice for `best`. */
  const bomDia = (best: string, other: string) => () => ({
    nouls: { "@theo": 0.576, "@ada": 0.576 },
    needs: 0.54,
    best,
    choice: { [best]: 0.83, [other]: 0.12, none: 0.05 },
  });
  const BOM_DIA = "me de bom dia todo dia ás 8:30 da manha";

  test("'me de bom dia todo dia ás 8:30 da manha' 23 minutes after a talk with Ada is hers, though Theo scored a little more", async () => {
    const t = await privateRoom();
    const talkWithAda = (minutesAgo: number): Said[] => [
      [null, "ada quanto ta seu limite de uso?", minutesAgo + 0.4, [t.ada]],
      [t.ada, "Heitor, não consigo consultar meu saldo de uso por aqui.", minutesAgo],
    ];
    const { selected, decision } = await t.talk(talkWithAda(22.8), BOM_DIA, bomDia("theo", "ada"));
    // The scores stored that day: Theo 0.626, Ada 0.555.
    const scores = Object.fromEntries(decision?.candidates.map((c) => [c.agentId, Math.round(c.score * 1000)]) ?? []);
    expect(scores).toEqual({ [t.theo.id]: 626, [t.ada.id]: 555 });
    expect(selected).toEqual([t.ada.id]);
    // Kept with the agent she talks to, by code: Ada may not pass, and the reason says why.
    expect(decision?.reason).toBe("follow-up; last talked to; jev: best @theo (confidence 0.83)");
    // A thank-you the router sent to nobody since doesn't end the talk.
    const thanked = await t.talk([...talkWithAda(22.8), [null, "valeu", 20, []]], BOM_DIA, bomDia("theo", "ada"));
    expect(thanked.selected).toEqual([t.ada.id]);
    // Past what the router reads (30 minutes), the scores decide, as they did that day.
    expect((await t.talk(talkWithAda(30.5), BOM_DIA, bomDia("theo", "ada"))).selected).toEqual([t.theo.id]);
    // Sooner, while she is still the agent just talking (5 minutes), the same, though it is no short follow-up.
    expect((await t.talk(talkWithAda(5), BOM_DIA, bomDia("theo", "ada"))).selected).toEqual([t.ada.id]);
    // Right after Theo spoke on his own, he is the one just talking: the scores decide, as before.
    const afterTheo = await t.talk(
      [...talkWithAda(5), [t.theo, "Lembrete: a daily começa em 10 minutos.", 1]],
      BOM_DIA,
      bomDia("theo", "ada"),
    );
    expect(afterTheo.selected).toEqual([t.theo.id]);
  });

  test("a message that clearly fits the other agent still goes to it", async () => {
    const t = await privateRoom();
    const talkWithAda: Said[] = [
      [null, "ada quanto ta seu limite de uso?", 23],
      [t.ada, "Não consigo ver meu saldo por aqui.", 22],
    ];
    // Ada could do it too, but Theo is a clear pick, 0.3 over her (0.96 to 0.52).
    const roadmap = await t.talk(talkWithAda, "resume a discussão de ontem no fórum e atualiza o roadmap", () => ({
      nouls: { "@theo": 0.9, "@ada": 0.55 },
      needs: 0.85,
      best: "theo",
    }));
    expect(roadmap.selected).toEqual([t.theo.id]);
    expect(roadmap.decision?.reason).not.toContain("follow-up");
    // Ada could do it nearly as well (0.72 to 0.96, under 0.3 apart), but the tie-break is sure it fits Theo, the PM.
    const sprint = await t.talk(talkWithAda, "cria uma task pro sprint de amanhã com os itens do roadmap", () => ({
      nouls: { "@theo": 0.9, "@ada": 0.75 },
      needs: 0.9,
      best: "theo",
      choice: { theo: 0.95, ada: 0.03, none: 0.02 },
    }));
    expect(sprint.selected).toEqual([t.theo.id]);
    expect(sprint.decision?.reason).toBe("jev: best @theo (confidence 0.95)");
    // Ada can't do it: under her bar.
    const tasks = await t.talk(talkWithAda, "e o roadmap, como está?", () => ({
      nouls: { "@theo": 0.7, "@ada": 0.2 },
      needs: 0.8,
      best: "theo",
    }));
    expect(tasks.selected).toEqual([t.theo.id]);
  });

  test("with a coordinator, a message it took isn't a talk with it", async () => {
    const t = await privateRoom();
    await f.db.update(schema.agents).set({ coordinator: true }).where(eq(schema.agents.id, t.theo.id));
    // Theo took Ana's question as the coordinator and handed it to Ada, who did the work.
    const handedOver = await t.talk(
      [
        [null, "alguém consegue ver se o PR do checkout subiu?", 15, [t.theo], { strategy: "rule:coordinator" }],
        [t.theo, "@ada pode olhar o PR do checkout?", 14.6],
        [t.ada, "Subiu sim, está verde.", 14],
      ],
      "e os testes de integração passaram?",
      () => ({ nouls: { "@theo": 0.55, "@ada": 0.72 }, needs: 0.8, best: "ada" }),
    );
    expect(handedOver.selected).toEqual([t.ada.id]);
    expect(handedOver.decision?.reason).toBe("jev: best @ada (confidence 0.80)");
    // A greeting the coordinator answered doesn't keep the next request with it.
    const greeted = await t.talk(
      [
        [null, "bom dia", 12.4, [t.theo], { strategy: "rule:coordinator" }],
        [t.theo, "Bom dia, Ana!", 12],
      ],
      "o checkout está dando 500",
      () => ({ nouls: { "@theo": 0.5, "@ada": 0.75 }, needs: 0.9, best: "ada" }),
    );
    expect(greeted.selected).toEqual([t.ada.id]);
  });

  test("with no pick between agents to settle, nothing changes", async () => {
    const t = await privateRoom();
    const talkWithAda: Said[] = [
      [null, "ada quanto ta seu limite de uso?", 23.4, [t.ada]],
      [t.ada, "Não consigo ver meu saldo por aqui.", 23],
    ];
    // The router picks Ada on its own: she may still pass.
    const build = await t.talk(talkWithAda, "alguém sabe se o build de ontem passou?", () => ({
      nouls: { "@theo": 0.2, "@ada": 0.6 },
      needs: 0.6,
      best: "ada",
    }));
    expect(build.selected).toEqual([t.ada.id]);
    expect(build.decision?.reason).toBe("jev: best @ada (confidence 0.80)");
    // No agent needed, and Theo picked only as a clear pick (0.84): Ada (0.62) wouldn't pass the need check alone.
    const remark = await t.talk(talkWithAda, "o roadmap ficou bom", () => ({
      nouls: { "@theo": 0.82, "@ada": 0.62 },
      needs: 0.3,
      best: "theo",
      choice: { theo: 0.5, ada: 0.3, none: 0.2 },
    }));
    expect(remark.selected).toEqual([t.theo.id]);
    expect(remark.decision?.reason).toBe("jev: best @theo (confidence 0.50)");
  });

  test("after another agent was addressed, the message doesn't go back to the one before", async () => {
    const t = await privateRoom();
    const talkWithAda: Said[] = [
      [null, "ada quanto ta seu limite de uso?", 28],
      [t.ada, "Não consigo ver meu saldo por aqui.", 27],
    ];
    // This time Jev leans to Ada, as it leaned to Theo that day.
    const leansToAda = bomDia("ada", "theo");
    // Theo @mentioned, still working on it.
    const mentioned = await t.talk(
      [...talkWithAda, [null, "@theo cria uma task pra revisar o PR do checkout", 15]],
      BOM_DIA,
      leansToAda,
    );
    expect(mentioned.selected).toEqual([t.theo.id]);
    // Theo asked by name, and he answered.
    const answered = await t.talk(
      [...talkWithAda, [null, "theo, cria uma task pra revisar o PR do checkout", 15], [t.theo, "Criei a task.", 14]],
      BOM_DIA,
      leansToAda,
    );
    expect(answered.selected).toEqual([t.theo.id]);
    // Theo asked by name a minute ago, and the router sent it to him: still at work, he hasn't answered yet.
    const working = await t.talk(
      [...talkWithAda, [null, "theo, cria uma task pra revisar o PR do checkout", 1, [t.theo], { working: true }]],
      BOM_DIA,
      leansToAda,
    );
    expect(working.selected).toEqual([t.theo.id]);
  });

  test("a message that names another agent isn't kept for the one before, even when the step isn't sure it speaks to it", async () => {
    const t = await privateRoom();
    // Jev only 0.55 sure it speaks to Theo (under 0.6), and Theo at 0.80, just under a clear pick.
    const { selected } = await t.talk(
      [
        [null, "ada quanto ta seu limite de uso?", 23.4, [t.ada]],
        [t.ada, "Não consigo ver meu saldo por aqui.", 23],
      ],
      `theo ${BOM_DIA}`,
      () => ({
        nouls: { "@theo": 0.75, "@ada": 0.576 },
        needs: 0.7,
        best: "theo",
        choice: { theo: 0.83, ada: 0.12, none: 0.05 },
        to: { theo: 0.55, none: 0.45 },
      }),
    );
    expect(selected).toEqual([t.theo.id]);
  });

  test("an agent the router sent a message to that stayed quiet wasn't talked to", async () => {
    const t = await privateRoom();
    // The room asked since; the router sent it to Theo, who passed. This time Jev leans to Ada.
    const { selected } = await t.talk(
      [
        [null, "ada quanto ta seu limite de uso?", 23.2, [t.ada]],
        [t.ada, "Não consigo ver meu saldo por aqui.", 22.8],
        [null, "alguém viu o jogo ontem?", 15, [t.theo]],
      ],
      BOM_DIA,
      bomDia("ada", "theo"),
    );
    expect(selected).toEqual([t.ada.id]);
  });

  test("a message of theirs the router hasn't decided on yet leaves whom they talk to unknown", async () => {
    const t = await privateRoom();
    const talkWithAda: Said[] = [
      [null, "ada quanto ta seu limite de uso?", 23.4, [t.ada]],
      [t.ada, "Não consigo ver meu saldo por aqui.", 23],
    ];
    // Four seconds ago, past the quiet wait, and still being routed: the step decides, as it did that day.
    const pending = await t.talk(
      [...talkWithAda, [null, "cria uma task pra revisar o PR do checkout", 4 / 60]],
      BOM_DIA,
      bomDia("theo", "ada"),
    );
    expect(pending.selected).toEqual([t.theo.id]);
    expect(pending.decision?.reason).toBe("jev: best @theo (confidence 0.83)");
    // A thank-you in two messages, decided as one (on the second) and sent to nobody, doesn't end the talk.
    const thanked = await t.talk(
      [...talkWithAda, [null, "valeu", 20], [null, "ajudou muito", 20 - 1 / 600, []]],
      BOM_DIA,
      bomDia("theo", "ada"),
      null,
      500,
    );
    expect(thanked.selected).toEqual([t.ada.id]);
  });

  test("a talk in another thread is that thread's, not the channel's", async () => {
    const t = await privateRoom();
    // Ana talked to Ada in the channel, then to Theo in the thread of an older message. Jev leans to Ada.
    const { selected } = await t.talk(
      [
        [null, "pessoal, revisão do contrato", 40],
        [null, "ada quanto ta seu limite de uso?", 23.2, [t.ada]],
        [t.ada, "Não consigo ver meu saldo por aqui.", 22.8],
        [null, "theo, pode revisar isso?", 15, [t.theo], { thread: 0 }],
        [t.theo, "Revisei.", 14, undefined, { thread: 0 }],
      ],
      BOM_DIA,
      bomDia("ada", "theo"),
    );
    expect(selected).toEqual([t.ada.id]);
  });

  test("an agent's message is unchanged: only a clear pick, the best one, and it may pass", async () => {
    const t = await privateRoom();
    // Ana last talked to Ada (who hasn't answered, so she can still be brought in), and the agent writes for her.
    const ask = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "person", userId: f.owner.id },
      body: "pede pra alguém criar minha rotina de bom dia às 8:30",
    });
    const [run] = await f.db.transaction((tx) => createAgentRuns(tx, ask, [f.agent.id], "mention"));
    const { selected, decision } = await t.talk(
      [[null, "@ada quanto ta seu limite de uso?", 23]],
      "alguém cria a rotina de bom dia do Heitor às 8:30?",
      () => ({ nouls: { "@theo": 0.9, "@ada": 0.85 }, needs: 0.9, best: "theo" }),
      { id: f.agent.id, runId: run?.id },
    );
    expect(selected).toEqual([t.theo.id]);
    expect(decision?.reason).toBe("jev: best @theo (confidence 0.80)");
  });
});

describe("Jev strategy end to end", () => {
  test("one request with a Noul per agent, a need Noul, a tie-break Choice and an addressee Choice; usage billed to the platform", async () => {
    f = await setup({ reply: () => ({ chunks: ["Deploy is green."] }) });
    const qa = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "QA", handle: "qa", role: "Testing" },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: qa.id });
    const jev = fakeJev(() => ({ nouls: { "@dev": 0.81, "@qa": 0.2 }, needs: 0.9, best: "dev" }));
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", jev: { key: "ts_secret", fetch: jev.fetcher } },
    });
    const m = await post(f, "is the deploy green?");
    await drainOutbox(f.db, handlers);

    const req = jev.requests[0];
    expect(req?.headers.get("authorization")).toBe("Bearer ts_secret");
    expect(req?.body).toMatchObject({ model: "jev-latest" });
    expect(Object.keys((req?.body.questions as object) ?? {}).sort()).toEqual([
      "addressee",
      "agent_0",
      "agent_1",
      "best_agent",
      "for_everyone",
      "needs_agent",
    ]);
    expect(JSON.stringify(req?.body.state)).toContain("is the deploy green?");
    expect(f.provider.calls).toHaveLength(1); // only the agent's reply: no LLM router call

    const [decision] = await f.db.select().from(schema.routingDecisions);
    expect(decision).toMatchObject({
      strategy: "jev",
      messageId: m.id,
      selectedAgentIds: [f.agent.id],
      needsAgentScore: 0.9,
    });
    const usage = (await f.db.select().from(schema.usageRecords)).find((u) => u.provider === "typesafe");
    expect(usage).toMatchObject({
      kind: "router",
      agentId: null,
      billedTo: "platform",
      inputTokens: 1200,
      costNanoUsd: jevCostNanoUsd(1200),
    });
    expect(jevCostNanoUsd(1_000_000)).toBe(42_000_000); // $0.042 per million input tokens
  });

  test("on a Jev error the LLM strategy decides, and the decision says so", async () => {
    f = await setup({
      reply: (req) =>
        req.outputSchema
          ? { chunks: ['{"needs_agent":0.9,"scores":[{"handle":"dev","score":0.9}],"reason":"r"}'] }
          : { chunks: ["ok"] },
    });
    const jev = fakeJev(() => new Error("down"));
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", jev: { key: "k", fetch: jev.fetcher } },
    });
    await post(f, "help with the build?");
    await drainOutbox(f.db, handlers);
    const [decision] = await f.db.select().from(schema.routingDecisions);
    expect(decision).toMatchObject({
      strategy: "llm:claude-haiku-5-5",
      error: "jev: TypeSafe answered 529",
      selectedAgentIds: [f.agent.id],
    });
  });

  test("conversation continuity: a follow-up without a mention goes to the agent just spoken to", async () => {
    f = await setup({ reply: () => ({ chunks: ["oi!"] }) });
    const jev = fakeJev((state) => ({
      nouls: { "@dev": state.agent_just_talking === "@dev" ? 0.35 : 0.2 },
      needs: 0.3,
    }));
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", jev: { key: "k", fetch: jev.fetcher } },
    });
    await post(f, "oi @dev");
    await drainOutbox(f.db, handlers);
    const followUp = await post(f, "e aí, tudo certo com o deploy?");
    await drainOutbox(f.db, handlers);
    expect(JSON.stringify(jev.requests.at(-1)?.body.state)).toContain('"agent_just_talking":"@dev"');
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs.map((r) => [r.trigger, r.triggerMessageId === followUp.id])).toContainEqual(["router", true]);
  });

  test("no pick: no agent.thinking, and message.routed with pickedBy []", async () => {
    f = await setup();
    const jev = fakeJev(() => ({ nouls: { "@dev": 0.2 }, needs: 0.1 }));
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", jev: { key: "k", fetch: jev.fetcher } },
    });
    const events = f.listen(f.general.id);
    const m = await post(f, "pessoal, almoço?");
    await drainOutbox(f.db, handlers);
    expect(events.some((e) => e.type === "agent.thinking")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "message.routed", messageId: m.id, seenBy: [f.agent.id], pickedBy: [] }),
    );
    expect(await f.db.select().from(schema.agentRuns)).toEqual([]);
  });

  test("with no Jev key the LLM strategy decides at once, under its own name, and nothing calls TypeSafe", async () => {
    f = await setup({
      reply: (req) =>
        req.outputSchema
          ? { chunks: ['{"needs_agent":0.9,"scores":[{"handle":"dev","score":0.9}],"reason":"r"}'] }
          : { chunks: ["ok"] },
    });
    const jev = fakeJev(() => ({ nouls: { "@dev": 0.9 }, needs: 0.9 }));
    const key = createJevKey({ db: f.db, keyWrapper: f.keyWrapper, keyWrappers: [f.keyWrapper] });
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", jev: { key, fetch: jev.fetcher } },
    });
    await post(f, "help with the build?");
    await drainOutbox(f.db, handlers);
    const [decision] = await f.db.select().from(schema.routingDecisions);
    expect(decision).toMatchObject({ strategy: "llm:claude-haiku-5-5", error: null, selectedAgentIds: [f.agent.id] });
    expect(jev.requests).toEqual([]);
  });

  test("named for who decides now: the cheap model with no key, Jev once one is saved", async () => {
    f = await setup();
    const jev = fakeJev(() => ({ nouls: {}, needs: 0 }));
    const key = createJevKey({ db: f.db, keyWrapper: f.keyWrapper, keyWrappers: [f.keyWrapper], fetch: jev.fetcher });
    await key.ready();
    const routing = messageRouter({ ...f.jobDeps, router: { enabled: true, model: "m", jev: { key } } });
    const llm = createLlmJudge({ gateway: f.gateway, resolveModel: async () => "m" });
    const judge = standingJudge(
      f.db,
      withJudgeFallback(createJevJudge({ key, gateway: f.gateway }), llm, () => key.usable()),
    );
    expect([routing?.strategy.name, judge.name]).toEqual(["llm", "llm"]);
    await key.save("ts_named_key_1", f.owner.id);
    expect([routing?.strategy.name, judge.name]).toEqual(["jev", "jev"]);
  });

  test("out of credit: the LLM strategy decides, and Jev isn't called again for 30 minutes", async () => {
    f = await setup({
      reply: (req) =>
        req.outputSchema ? { chunks: ['{"needs_agent":0.1,"scores":[],"reason":"r"}'] } : { chunks: ["ok"] },
    });
    let clock = Date.now();
    const key = createJevKey({
      db: f.db,
      keyWrapper: f.keyWrapper,
      keyWrappers: [f.keyWrapper],
      envKey: "ts_broke_key",
      now: () => clock,
    });
    let calls = 0;
    const broke = (async () => {
      calls++;
      return Response.json({ detail: { error_type: "billing_error", message: "No credit left" } }, { status: 402 });
    }) as unknown as typeof fetch;
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", jev: { key, fetch: broke } },
    });
    await post(f, "anyone around?");
    await drainOutbox(f.db, handlers);
    expect(calls).toBe(1);
    expect((await key.view()).state).toBe("no_credit");
    await post(f, "still there?");
    await drainOutbox(f.db, handlers);
    expect(calls).toBe(1);
    clock += 30 * 60_000;
    await post(f, "and now?");
    await drainOutbox(f.db, handlers);
    expect(calls).toBe(2);
    const decisions = await f.db.select().from(schema.routingDecisions);
    expect(decisions.map((d) => d.strategy)).toEqual(Array(3).fill("llm:claude-haiku-5-5"));
    expect(decisions.map((d) => d.error).sort()).toEqual([
      "jev: TypeSafe answered 402",
      "jev: TypeSafe answered 402",
      null,
    ]);
  });

  test("agents' messages never reach the router", async () => {
    f = await setup();
    const jev = fakeJev(() => ({ nouls: {}, needs: 1 }));
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "m", jev: { key: "k", fetch: jev.fetcher } },
    });
    await f.db.transaction((tx) =>
      insertMessage(tx, {
        orgId: f.org.id,
        channelId: f.general.id,
        author: { type: "agent", agentId: f.agent.id, runId: crypto.randomUUID(), hop: 1 },
        body: "done",
      }),
    );
    await drainOutbox(f.db, handlers);
    expect(jev.requests).toEqual([]);
  });
});
