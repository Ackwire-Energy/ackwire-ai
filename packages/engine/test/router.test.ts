import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { ProviderError, systemText, textOf } from "@agenteschat/providers";
import {
  buildRunContext,
  createAgent,
  createJobHandlers,
  createLlmRouterStrategy,
  DEFAULT_ROUTER_POLICY,
  drainOutbox,
  insertMessage,
  listMessages,
  parseRouterOutput,
  postPersonMessage,
  type RouterStrategy,
  type RoutingCandidate,
  routeMessage,
  selectAgents,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const cand = (agentId: string): RoutingCandidate => ({ agentId, handle: agentId, name: agentId, role: "", about: "" });
const policy = { minScore: 0.5, maxAgents: 2, maxHops: 3 };
const post = (body: string, threadId?: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, threadId });

describe("selectAgents (policy)", () => {
  test("threshold, best first, at most two, candidates only", () => {
    const candidates = ["a", "b", "c", "d"].map(cand);
    const result = {
      agents: [
        { agentId: "a", score: 0.6 },
        { agentId: "b", score: 0.9 },
        { agentId: "c", score: 0.7 },
        { agentId: "d", score: 0.2 },
        { agentId: "intruder", score: 1 },
      ],
    };
    expect(selectAgents(candidates, result, policy)).toEqual(["b", "c"]);
  });

  test("a low need-any-agent score means nobody", () => {
    expect(selectAgents([cand("a")], { agents: [{ agentId: "a", score: 0.9 }], needsAgent: 0.1 }, policy)).toEqual([]);
  });

  test("a clear pick answers even when the need-any-agent score disagrees", () => {
    // "theo, tell everyone our best TikTok campaign": Theo 1.0, needs_agent 0.22 (2026-10-17).
    const result = {
      agents: [
        { agentId: "theo", score: 1 },
        { agentId: "iris", score: 0.025 },
      ],
      needsAgent: 0.22,
    };
    expect(selectAgents([cand("theo"), cand("iris")], result, policy)).toEqual([]);
    expect(selectAgents([cand("theo"), cand("iris")], result, { ...policy, clearPickScore: 0.8 })).toEqual(["theo"]);
    expect(
      selectAgents(
        [cand("theo"), cand("iris")],
        { ...result, agents: [{ agentId: "theo", score: 0.7 }] },
        { ...policy, clearPickScore: 0.8 },
      ),
    ).toEqual([]);
  });

  test("a message to the room may wake up to four agents by default", () => {
    const candidates = ["a", "b", "c", "d", "e"].map(cand);
    const result = { agents: candidates.map((c) => ({ agentId: c.agentId, score: 0.9 })), needsAgent: 0.9 };
    expect(selectAgents(candidates, result, { ...DEFAULT_ROUTER_POLICY, maxHops: 3 })).toHaveLength(4);
  });
});

describe("parseRouterOutput", () => {
  test("keeps well-formed scores and tolerates garbage", () => {
    expect(
      parseRouterOutput('{"needs_agent":0.8,"scores":[{"handle":"dev","score":0.9},{"x":1}],"reason":"r"}'),
    ).toEqual({
      needs_agent: 0.8,
      scores: [{ handle: "dev", score: 0.9 }],
      reason: "r",
    });
    expect(parseRouterOutput("not json").scores).toEqual([]);
  });
});

/** A strategy that returns fixed scores by handle and records what it saw. */
function fixedStrategy(scores: Record<string, number>) {
  const seen: RoutingCandidate[][] = [];
  const strategy: RouterStrategy = {
    name: "fixed",
    async decide(input) {
      seen.push(input.candidates);
      return {
        agents: input.candidates.map((c) => ({ agentId: c.agentId, score: scores[c.handle] ?? 0 })),
        reason: "test",
      };
    },
  };
  return { strategy, seen };
}

describe("routeMessage", () => {
  test("each candidate's `can` names the connections it may use (a question about Sentry goes to who has it)", async () => {
    f = await setup();
    const make = (handle: string) =>
      createAgent(f.db, f.owner.id, f.org.id, { name: handle, handle }, { model: "claude-sonnet-5-5" });
    const atlas = await make("atlas");
    const ada = await make("ada");
    for (const a of [atlas, ada])
      await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: a.id });
    const [sentry] = await f.db
      .insert(schema.connectorConnections)
      .values({
        orgId: f.org.id,
        connector: "sentry",
        label: "Sentry",
        serverUrl: "https://mcp.sentry.dev",
        authType: "none",
      })
      .returning();
    await f.db.insert(schema.agentScopes).values([
      { orgId: f.org.id, agentId: atlas.id, connectionId: sentry?.id, scope: "connector:*" },
      { orgId: f.org.id, agentId: ada.id, connectionId: sentry?.id, scope: "deny:sentry_list_issues" },
    ]);
    const { strategy, seen } = fixedStrategy({});
    const message = await post("nenhum erro novo no sentry gente?");
    await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: message.id });
    const can = Object.fromEntries((seen[0] ?? []).map((c) => [c.handle, c.can]));
    expect(can.atlas).toContain("Sentry");
    expect(can.ada).not.toContain("Sentry");
  });

  test("candidates are filtered by code: channel members, active, auto-reply on", async () => {
    f = await setup();
    const make = (handle: string) =>
      createAgent(f.db, f.owner.id, f.org.id, { name: handle, handle }, { model: "claude-sonnet-5-5" });
    const qa = await make("qa");
    const ops = await make("ops");
    await make("outsider"); // not in #general
    const archived = await make("old");
    for (const a of [qa, ops, archived])
      await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: a.id });
    await f.db.update(schema.channelMembers).set({ autoReply: false }).where(eq(schema.channelMembers.agentId, ops.id));
    await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, archived.id));

    const { strategy, seen } = fixedStrategy({ qa: 0.95, dev: 0.7, outsider: 1 });
    const message = await post("the build is red again");
    const result = await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: message.id });
    expect(seen[0]?.map((c) => c.handle).sort()).toEqual(["dev", "qa"]);
    expect(result.runs.map((r) => [r.agentId, r.trigger, r.hop])).toEqual([
      [qa.id, "router", 1],
      [f.agent.id, "router", 1],
    ]);

    const [decision] = await f.db.select().from(schema.routingDecisions);
    expect(decision).toMatchObject({ strategy: "fixed", messageId: message.id, selectedAgentIds: [qa.id, f.agent.id] });
    expect(decision?.candidates.sort((a, b) => b.score - a.score)).toEqual([
      { agentId: qa.id, score: 0.95 },
      { agentId: f.agent.id, score: 0.7 },
    ]);

    // Each picked agent knows who else answers, so it speaks only for itself.
    const devRun = result.runs.find((r) => r.agentId === f.agent.id);
    if (!devRun) throw new Error("no run");
    const devPrompt = systemText((await buildRunContext(f.db, devRun, f.agent, { maxMessages: 10 })).system);
    expect(devPrompt).toContain("@qa also got this message and is answering right now");
    expect(devPrompt).not.toContain("@ops also got");

    // One decision per message: a redelivered job does nothing.
    expect(
      (await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: message.id })).skipped,
    ).toBe("already_routed");
    expect(seen).toHaveLength(1);
  });

  test("an agent's message brings in one more agent only on a clear pick, never itself, never from an answer to an answer", async () => {
    f = await setup();
    const make = async (handle: string) => {
      const a = await createAgent(f.db, f.owner.id, f.org.id, { name: handle, handle }, { model: "claude-sonnet-5-5" });
      await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: a.id });
      return a;
    };
    const infra = await make("infra");
    await make("qa");
    const question = await post("why is staging slow?");
    const byDev = (body: string, hop: number) =>
      insertMessage(f.db, {
        orgId: f.org.id,
        channelId: f.general.id,
        threadId: question.id,
        author: { type: "agent", agentId: f.agent.id, runId: null, hop },
        body,
      });

    const { strategy, seen } = fixedStrategy({ dev: 1, infra: 0.9, qa: 0.85 });
    const answer = await byDev("Looks like the database; infra would know.", 1);
    const result = await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: answer.id });
    expect(seen[0]?.map((c) => c.handle).sort()).toEqual(["infra", "qa"]);
    expect(result.runs.map((r) => [r.agentId, r.hop])).toEqual([[infra.id, 2]]);

    const lukewarm = fixedStrategy({ infra: 0.7, qa: 0.6 });
    const second = await byDev("Also the cache was cold.", 1);
    expect(
      (await routeMessage({ db: f.db, strategy: lukewarm.strategy, policy }, { orgId: f.org.id, messageId: second.id }))
        .selected,
    ).toEqual([]);

    const deep = await byDev("answer to an answer", 2);
    expect((await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: deep.id })).skipped).toBe(
      "hop_limit",
    );
  });

  test("asking the agent you talk to about what it already said still gets its answer; another agent stays quiet", async () => {
    f = await setup();
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "ops", handle: "ops" },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ops.id });
    const question = await post("our timezone is Sao Paulo, note it");
    await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: question.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1 },
      body: "Noted. I also moved the hourly reviews routine to Sao Paulo time.",
    });
    const answered = (scores: Record<string, number>): RouterStrategy => ({
      name: "fixed",
      async decide(input) {
        return {
          agents: input.candidates.map((c) => ({ agentId: c.agentId, score: scores[c.handle] ?? 0 })),
          needsAgent: 0.94,
          alreadyAnswered: 0.9,
        };
      },
    });
    // Longer than a short follow-up, about something the agent already said: it answers anyway.
    const again = await post("and what is the interval of that review routine of yours again?");
    const toDev = await routeMessage(
      { db: f.db, strategy: answered({ [f.agent.handle]: 1, ops: 0.05 }), policy },
      { orgId: f.org.id, messageId: again.id },
    );
    expect(toDev.selected).toEqual([f.agent.id]);
    // The router would bring in someone else for an answer already given: nobody.
    const other = await post("who handles the review routine and how often does it run?");
    const toOps = await routeMessage(
      { db: f.db, strategy: answered({ [f.agent.handle]: 0.1, ops: 0.9 }), policy },
      { orgId: f.org.id, messageId: other.id },
    );
    expect(toOps.selected).toEqual([]);
  });

  test("a quote reply to an agent goes to that agent, who the router saw answer under the earlier message", async () => {
    f = await setup();
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "ops", handle: "ops" },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ops.id });
    const question = await post("clone the repo and look at the error");
    const answer = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: question.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1 },
      body: "I couldn't read the code: the clone of the repo hung.",
    });
    const inputs: { body: string; thread: string[] }[] = [];
    const strategy: RouterStrategy = {
      name: "fixed",
      async decide(input) {
        inputs.push({ body: input.message.body, thread: input.thread.map((m) => m.body) });
        // The router alone would pick ops (it talks about infrastructure).
        return { agents: input.candidates.map((c) => ({ agentId: c.agentId, score: c.handle === "ops" ? 0.9 : 0.2 })) };
      },
    };
    const why = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "why did the clone of the repo hang? was it a timeout, permissions or the network?",
      replyTo: answer.id,
    });
    const result = await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: why.id });
    expect(result.selected).toEqual([f.agent.id]);
    expect(inputs[0]?.thread).toContain("I couldn't read the code: the clone of the repo hung.");
    expect(inputs[0]?.body).toStartWith("(replying to Dev:");
  });

  test("a reply under an agent's message goes to that agent, long after it, with the message in view", async () => {
    f = await setup();
    const report = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1 },
      body: "A new loved review came in right after a subscription; that prompt was the one we decided to remove.",
      createdAt: new Date(Date.now() - 2 * 60 * 60_000),
    });
    const threads: string[][] = [];
    const strategy: RouterStrategy = {
      name: "fixed",
      async decide(input) {
        threads.push(input.thread.map((m) => m.body));
        // Without the report in view, a plain statement reads as for nobody.
        return { agents: input.candidates.map((c) => ({ agentId: c.agentId, score: 0.1 })), needsAgent: 0.1 };
      },
    };
    const reply = await post("we haven't shipped that removal yet, I'm still thinking it over", report.id);
    const result = await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: reply.id });
    expect(result.selected).toEqual([f.agent.id]);
    expect(threads[0]?.[0]).toBe(report.body);
  });

  test("no candidates: no strategy call", async () => {
    f = await setup();
    await f.db
      .update(schema.channelMembers)
      .set({ autoReply: false })
      .where(eq(schema.channelMembers.agentId, f.agent.id));
    const { strategy, seen } = fixedStrategy({});
    const message = await post("hi");
    expect(
      (await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: message.id })).skipped,
    ).toBe("no_candidates");
    expect(seen).toHaveLength(0);
  });

  test("transient strategy errors retry; permanent ones are stored and pick nobody", async () => {
    f = await setup();
    const message = await post("hi");
    const failing = (error: Error): RouterStrategy => ({ name: "boom", decide: async () => Promise.reject(error) });
    await expect(
      routeMessage(
        { db: f.db, strategy: failing(new ProviderError("overloaded", true)), policy },
        {
          orgId: f.org.id,
          messageId: message.id,
        },
      ),
    ).rejects.toThrow("overloaded");
    expect(await f.db.select().from(schema.routingDecisions)).toHaveLength(0);
    const result = await routeMessage(
      { db: f.db, strategy: failing(new ProviderError("bad key", false)), policy },
      { orgId: f.org.id, messageId: message.id },
    );
    expect(result.runs).toEqual([]);
    const [decision] = await f.db.select().from(schema.routingDecisions);
    expect(decision?.error).toBe("bad key");
  });
});

describe("LLM strategy (end to end through the outbox)", () => {
  test("a message without mentions is routed by the router model; the picked agent replies", async () => {
    f = await setup({
      reply: (req) =>
        req.outputSchema
          ? {
              chunks: ['{"needs_agent":0.9,"scores":[{"handle":"dev","score":0.88}],"reason":"build question"}'],
              usage: { inputTokens: 300, outputTokens: 20 },
            }
          : { chunks: ["On it."] },
    });
    const handlers = createJobHandlers({ ...f.jobDeps, router: { enabled: true, model: "claude-haiku-5-5" } });
    await post("why is the build failing?");
    await drainOutbox(f.db, handlers);

    const routerCall = f.provider.calls[0]?.request;
    expect(routerCall?.model).toBe("claude-haiku-5-5");
    expect(routerCall?.effort).toBe("low");
    expect(JSON.stringify(routerCall?.outputSchema)).toContain('"enum":["dev"]');
    expect(textOf(routerCall?.messages[0]?.content ?? "")).toContain("<message>\n[ana]: why is the build failing?");

    // Asked in the channel: the reply is in the main timeline.
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(main.map((m) => m.body)).toEqual(["why is the build failing?", "On it."]);
    const usage = await f.db.select().from(schema.usageRecords);
    expect(usage.map((u) => [u.kind, u.agentId]).sort()).toEqual([
      ["agent", f.agent.id],
      ["router", null],
    ]);
    const [decision] = await f.db.select().from(schema.routingDecisions);
    expect(decision).toMatchObject({ strategy: "llm", needsAgentScore: 0.9, reason: "build question" });
    expect(decision?.usageRecordId).toBe(usage.find((u) => u.kind === "router")?.id ?? "");
  });

  test("after an agent answers, another agent may join on its own; its reply says nobody called it", async () => {
    f = await setup({
      reply: (req) => {
        if (!req.outputSchema)
          return { chunks: [JSON.stringify(req.messages).includes("cache") ? "Ok." : "The cache is cold."] };
        const prompt = textOf(req.messages[0]?.content ?? "");
        // The person's message goes to @dev; @dev's answer brings in @qa.
        return prompt.includes("[@dev]:")
          ? { chunks: ['{"needs_agent":0.3,"scores":[{"handle":"qa","score":0.9}],"reason":"qa owns tests"}'] }
          : { chunks: ['{"needs_agent":0.9,"scores":[{"handle":"dev","score":0.9}],"reason":"dev"}'] };
      },
    });
    const qa = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "QA", handle: "qa", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: qa.id });
    const handlers = createJobHandlers({ ...f.jobDeps, router: { enabled: true, model: "claude-haiku-5-5" } });
    await post("why are the tests slow?");
    await drainOutbox(f.db, handlers);

    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const byDev = main.find((m) => m.author.id === f.agent.id);
    const byQa = main.find((m) => m.author.id === qa.id);
    expect(byDev?.meta.joined).toBeUndefined();
    expect(byQa?.meta.joined).toBe(true);
    // QA's answer to an answer brings in nobody else.
    expect(main.filter((m) => m.author.type === "agent")).toHaveLength(2);
  });

  test("an org can override the router model; the router is off when disabled", async () => {
    f = await setup({ reply: () => ({ chunks: ['{"needs_agent":0,"scores":[],"reason":"chit-chat"}'] }) });
    await f.db.insert(schema.organizationSettings).values({ orgId: f.org.id, routerModel: "claude-sonnet-5-5" });
    const strategy = createLlmRouterStrategy({
      gateway: f.gateway,
      resolveModel: async () => "claude-sonnet-5-5",
    });
    const message = await post("lunch?");
    const result = await routeMessage({ db: f.db, strategy, policy }, { orgId: f.org.id, messageId: message.id });
    expect(result.selected).toEqual([]);
    expect(f.provider.calls[0]?.request.model).toBe("claude-sonnet-5-5");

    const off = createJobHandlers({ ...f.jobDeps, router: { enabled: false, model: "claude-haiku-5-5" } });
    await post("anyone?");
    await drainOutbox(f.db, off);
    expect(f.provider.calls).toHaveLength(1);
  });

  test("the org override is resolved per organization by the job handlers", async () => {
    f = await setup({ reply: () => ({ chunks: ['{"needs_agent":0,"scores":[],"reason":""}'] }) });
    await f.db.insert(schema.organizationSettings).values({ orgId: f.org.id, routerModel: "claude-sonnet-5-5" });
    const handlers = createJobHandlers({ ...f.jobDeps, router: { enabled: true, model: "claude-haiku-5-5" } });
    await post("hello");
    await drainOutbox(f.db, handlers);
    expect(f.provider.calls[0]?.request.model).toBe("claude-sonnet-5-5");
  });
});
