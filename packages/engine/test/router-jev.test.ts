import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import {
  createAgent,
  createJevJudge,
  createJevKey,
  createJobHandlers,
  createLlmJudge,
  drainOutbox,
  insertMessage,
  JevOffError,
  jevCostNanoUsd,
  messageRouter,
  postPersonMessage,
  RouterChainEnd,
  RouterSkip,
  type RouterStrategy,
  type RoutingCandidate,
  type RoutingInput,
  routeChain,
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

/** A fake TypeSafe endpoint: records requests, answers with scripted nouls per handle. */
function fakeJev(
  script: (
    state: Record<string, unknown>,
  ) => { nouls: Record<string, number>; needs: number; best?: string; everyone?: number } | Error,
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
        probabilities: { [r.best ?? "none"]: 0.9 },
        confidence: 0.8,
      };
    }
    return Response.json({ model: "jev-1.14.0", answers, usage: { input_tokens: 1200, output_tokens: 30 } });
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}

const post = (fx: Fixture, body: string, threadId?: string) =>
  postPersonMessage({ db: fx.db, pubsub: fx.pubsub }, fx.owner.id, fx.org.id, fx.general.id, { body, threadId });

describe("Jev strategy end to end", () => {
  test("one request with a Noul per agent, a need Noul and a tie-break Choice; usage billed to the platform", async () => {
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
