import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import {
  createAgent,
  createJobHandlers,
  drainOutbox,
  insertMessage,
  jevCostNanoUsd,
  postPersonMessage,
  type RoutingCandidate,
  selectAgents,
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

/** A fake TypeSafe endpoint: records requests, answers with scripted nouls per handle. */
function fakeJev(
  script: (state: Record<string, unknown>) => { nouls: Record<string, number>; needs: number; best?: string } | Error,
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
      router: { enabled: true, model: "claude-haiku-5-5", jev: { apiKey: "ts_secret", fetch: jev.fetcher } },
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
      router: { enabled: true, model: "claude-haiku-5-5", jev: { apiKey: "k", fetch: jev.fetcher } },
    });
    await post(f, "help with the build?");
    await drainOutbox(f.db, handlers);
    const [decision] = await f.db.select().from(schema.routingDecisions);
    expect(decision?.strategy).toStartWith("llm (fallback:");
    expect(decision?.selectedAgentIds).toEqual([f.agent.id]);
  });

  test("conversation continuity: a follow-up without a mention goes to the agent just spoken to", async () => {
    f = await setup({ reply: () => ({ chunks: ["oi!"] }) });
    const jev = fakeJev((state) => ({
      nouls: { "@dev": state.agent_just_talking === "@dev" ? 0.35 : 0.2 },
      needs: 0.3,
    }));
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "claude-haiku-5-5", jev: { apiKey: "k", fetch: jev.fetcher } },
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
      router: { enabled: true, model: "claude-haiku-5-5", jev: { apiKey: "k", fetch: jev.fetcher } },
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

  test("agents' messages never reach the router", async () => {
    f = await setup();
    const jev = fakeJev(() => ({ nouls: {}, needs: 1 }));
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: { enabled: true, model: "m", jev: { apiKey: "k", fetch: jev.fetcher } },
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
