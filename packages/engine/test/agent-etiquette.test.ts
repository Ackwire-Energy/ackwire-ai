import { afterEach, describe, expect, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  addressesSeveral,
  buildRunContext,
  createAgent,
  createJevMentionClassifier,
  createJobHandlers,
  drainOutbox,
  isShortFollowUp,
  mentionIntent,
  postPersonMessage,
  type RouterStrategy,
  routeMessage,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const post = (body: string, threadId?: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, threadId });

async function addQa() {
  const qa = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "QA", handle: "qa", role: "Testes", credentialId: f.credential.id },
    { model: "claude-sonnet-5-5" },
  );
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: qa.id });
  return qa;
}

describe("an agent's @mention of another agent", () => {
  test("requests and questions hand off; references don't", () => {
    expect(mentionIntent("@jorge pode revisar o PR?", "jorge")).toBe("request");
    expect(mentionIntent("@Jorge, dá uma olhada nos testes.", "jorge")).toBe("request");
    expect(mentionIntent("Feito. @jorge consegue confirmar em staging", "jorge")).toBe("request");
    expect(mentionIntent("Como o @jorge disse, está tudo certo.", "jorge")).toBe("reference");
    expect(mentionIntent("O @jorge já fez o deploy.", "jorge")).toBe("reference");
    expect(mentionIntent("Não sei as permissões dele, pergunte a @jorge.", "jorge")).toBe("reference");
    expect(mentionIntent("Fale com o @theo ou o @jorge.", "theo")).toBe("reference");
    expect(mentionIntent("Fale com o @theo ou o @jorge.", "jorge")).toBe("reference");
    expect(mentionIntent("Vou alinhar isso com @jorge depois.", "jorge")).toBe("unclear");
  });

  test("a reference doesn't start the other agent; a request does, once, and the reply can't hand back", async () => {
    let turn = 0;
    f = await setup({
      reply: (req) => {
        const mine = systemText(req.system).includes("You are Dev (@dev)");
        if (!mine) return { chunks: ["@dev revisei, pode seguir?"] }; // QA tries to hand back
        turn++;
        return { chunks: [turn === 1 ? "Como o @qa disse, está tudo certo." : "@qa pode revisar o PR?"] };
      },
    });
    await addQa();
    const first = await post("@dev e o deploy?");
    await drainOutbox(f.db, f.handlers);
    expect((await f.db.select().from(schema.agentRuns)).map((r) => r.hop)).toEqual([1]); // QA stayed quiet

    await post("@dev pede revisão do PR", first.id);
    await drainOutbox(f.db, f.handlers);
    const runs = await f.db.select().from(schema.agentRuns).orderBy(asc(schema.agentRuns.createdAt));
    // Dev (hop 1) asked QA (hop 2); QA's "@dev …?" doesn't start Dev again.
    expect(runs.map((r) => r.hop)).toEqual([1, 1, 2]);
  });

  test("Jev judges each mentioned agent in one request", async () => {
    const seen: string[] = [];
    const classify = createJevMentionClassifier({
      apiKey: "tk",
      recordUsage: async () => {},
      fetch: (async (_url: string, init?: RequestInit) => {
        seen.push(String(init?.body));
        return Response.json({
          model: "jev-1",
          answers: { asks_0: { type: "noul", noul: 0.83 } },
          usage: { input_tokens: 50 },
        });
      }) as unknown as typeof fetch,
    });
    const scores = await classify({
      orgId: "o",
      body: "Vou alinhar isso com @jorge depois.",
      author: "@dev",
      targets: [{ agentId: "a1", handle: "jorge", name: "Jorge", role: null }],
    });
    expect(scores.get("a1")).toBeCloseTo(0.83);
    expect(seen[0]).toContain("@jorge");
  });
});

describe("short follow-ups without a mention", () => {
  const scoreAll: RouterStrategy = {
    name: "fixed",
    async decide(input) {
      return {
        agents: input.candidates.map((c) => ({ agentId: c.agentId, score: 0.9 })),
        needsAgent: 0.9,
        reason: "t",
      };
    },
  };
  const policy = { minScore: 0.5, maxAgents: 2, maxHops: 3 };

  test("go only to the agent the person last talked to, unless they address several", async () => {
    f = await setup({ reply: () => ({ chunks: ["Deploy feito."] }) });
    const qa = await addQa();
    await post("@dev status do deploy?");
    await drainOutbox(f.db, f.handlers); // Dev answers in the thread
    const followUp = await post("e agora?");
    const one = await routeMessage(
      { db: f.db, strategy: scoreAll, policy },
      { orgId: f.org.id, messageId: followUp.id },
    );
    expect(one.runs.map((r) => r.agentId)).toEqual([f.agent.id]);

    const both = await post("e agora, vocês dois?");
    const several = await routeMessage(
      { db: f.db, strategy: scoreAll, policy },
      { orgId: f.org.id, messageId: both.id },
    );
    expect(several.runs.map((r) => r.agentId).sort()).toEqual([f.agent.id, qa.id].sort());
  });

  test("helpers", () => {
    expect(isShortFollowUp("e aí?")).toBe(true);
    expect(isShortFollowUp("@qa e agora?")).toBe(false);
    expect(isShortFollowUp("preciso que alguém revise todo o fluxo de pagamento antes da release de sexta")).toBe(
      false,
    );
    const agents = [
      { name: "Theo", handle: "theo" },
      { name: "Jorge", handle: "jorge" },
    ];
    expect(addressesSeveral("theo e jorge, e agora?", agents)).toBe(true);
    expect(addressesSeveral("e agora, theo?", agents)).toBe(false);
    expect(addressesSeveral("e agora, pessoal, todos prontos?", agents)).toBe(true);
  });
});

test("an agent knows what the other agents here can do and points to them", async () => {
  f = await setup();
  await addQa();
  const trigger = await post("@dev o QA consegue mexer no Drive?");
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  if (!run) throw new Error("no run");
  const ctx = await buildRunContext(f.db, run, f.agent, { maxMessages: 30 });
  const prompt = systemText(ctx.system);
  expect(prompt).toContain("Other agents here and what they can do: QA (@qa, Testes):");
  expect(prompt).toContain("Arquivos (Drive)");
  expect(prompt).toContain("pergunte a @qa");
  expect(prompt).not.toMatch(/Dev \(@dev, [^)]*\):/); // not itself
});

describe("Jev judges every agent-to-agent mention (the 20:35 loop)", () => {
  /** Fake TypeSafe: mention judgements by the mentioned agent's handle; routing questions answered low. */
  function fakeJev(asks: Record<string, number>) {
    const requests: Record<string, unknown>[] = [];
    const fetcher = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        questions: Record<string, { instructions: { agent?: { handle: string } } }>;
      };
      requests.push(body);
      const answers: Record<string, unknown> = {};
      for (const [key, q] of Object.entries(body.questions)) {
        const noul = key.startsWith("asks_") ? (asks[q.instructions.agent?.handle ?? ""] ?? 0) : 0.1;
        answers[key] = { type: "noul", noul };
      }
      return Response.json({ model: "jev-1", answers, usage: { input_tokens: 100, output_tokens: 5 } });
    }) as unknown as typeof fetch;
    return { fetcher, requests };
  }

  test("a question to three agents gets one answer each and at most one hand-off; decisions are recorded", async () => {
    f = await setup({
      reply: (req) => {
        const system = systemText(req.system);
        const last = JSON.stringify(req.messages.at(-1)?.content);
        if (system.includes("You are Dev (@dev)")) return { chunks: ["Não sei, fale com o @qa ou o @ops."] };
        if (system.includes("You are QA (@qa)")) return { chunks: ["@ops você consegue ver os logs?"] };
        // Ops: first its own answer to the person, then (if asked by QA) a reply that tries to hand back.
        return {
          chunks: [
            last.includes("você consegue ver os logs") ? "@dev @qa sim, já vi, pode seguir?" : "Eu vejo os logs, @qa.",
          ],
        };
      },
    });
    await addQa();
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Ops", handle: "ops", role: "Infra", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ops.id });
    const jev = fakeJev({ "@ops": 0.9, "@qa": 0.2, "@dev": 0.2 });
    const handlers = createJobHandlers({
      ...f.jobDeps,
      router: {
        enabled: true,
        model: "claude-haiku-5-5",
        jev: { apiKey: "tk", fetch: jev.fetcher },
        mentionThreshold: 0.6,
      },
    });

    // A person's @mentions always start the mentioned agents.
    await post("@dev @qa @ops quem consegue ver os logs de produção?");
    await drainOutbox(f.db, handlers);

    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs.filter((r) => r.hop === 1)).toHaveLength(3); // one answer per addressed agent
    expect(runs.filter((r) => r.hop === 2).map((r) => r.agentId)).toEqual([ops.id]); // QA → Ops, once
    expect(runs.filter((r) => r.hop >= 3)).toEqual([]);

    const decisions = await f.db.select().from(schema.routingDecisions);
    const strategies = decisions.map((d) => d.strategy).sort();
    expect(strategies).toContain("mention-rules"); // Dev's "fale com o @qa ou o @ops": references, no Jev call
    expect(strategies.filter((s) => s === "jev-mention").length).toBeGreaterThanOrEqual(2);
    expect(
      decisions.find((d) => d.strategy === "jev-mention" && d.selectedAgentIds.length === 1)?.selectedAgentIds,
    ).toEqual([ops.id]);
  });

  test("without Jev only explicit requests hand off", async () => {
    f = await setup({
      reply: (req) =>
        systemText(req.system).includes("You are Dev (@dev)")
          ? { chunks: ["Vou alinhar isso com @qa depois."] }
          : { chunks: ["ok"] },
    });
    await addQa();
    await post("@dev e os testes?");
    await drainOutbox(f.db, f.handlers);
    expect((await f.db.select().from(schema.agentRuns)).map((r) => r.hop)).toEqual([1]);
    const [decision] = await f.db.select().from(schema.routingDecisions);
    expect(decision).toMatchObject({ strategy: "mention-rules", selectedAgentIds: [] });
  });
});
