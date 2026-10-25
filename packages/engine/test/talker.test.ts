import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { type ModelRequest, systemText, textOf } from "@agenteschat/providers";
import type { FakeReply } from "@agenteschat/providers/testing";
import {
  answerQuestion,
  createTalker,
  drainOutbox,
  grantScopes,
  listApprovals,
  listMessages,
  postPersonMessage,
  stopChecksSettled,
  TALKER_MIN_GAP_MS,
  type TalkerDeps,
  talkerPolicy,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { ALL_GITHUB_SCOPES, fakeGithub } from "./tool-fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const isTalkerCall = (req: ModelRequest) => systemText(req.system).includes("conversation layer");
const QUESTION = "Faço o deploy em staging ou em produção?";
const REPLY = "Ainda não: estou esperando sua resposta no card, staging ou produção.";

/** The agent: asks where to deploy (a question card), then deploys. The talker: `talker(req)`. */
function script(talker: (req: ModelRequest) => FakeReply) {
  return (req: ModelRequest): FakeReply => {
    if (isTalkerCall(req)) return talker(req);
    if (JSON.stringify(req.messages).includes("The person answered")) return { chunks: ["Deploy em staging feito."] };
    return {
      chunks: [],
      toolUses: [
        {
          name: "ask_user",
          input: {
            question: QUESTION,
            choices: ["staging", "produção"],
            why: "The request doesn't say where to deploy, and production is the person's call.",
          },
        },
      ],
    };
  };
}

const replyJson = (text: string) => ({ chunks: [JSON.stringify({ action: "reply", text })] });

type TalkerOptions = Partial<Omit<TalkerDeps, "db" | "pubsub" | "gateway" | "resolveModel">>;

/** The talker on the test gateway, and a person writing in the thread of the task's trigger. */
function talkerOn(trigger: { id: string }, options: TalkerOptions = {}) {
  const decisions: string[] = [];
  const talker = createTalker({
    db: f.db,
    pubsub: f.pubsub,
    gateway: f.gateway,
    resolveModel: async () => "claude-haiku-5-5",
    onDecision: (d) => decisions.push(d.outcome),
    ...options,
  });
  const write = async (body: string) => {
    const m = await postPersonMessage({ db: f.db, pubsub: f.pubsub, talker }, f.owner.id, f.org.id, f.general.id, {
      body,
      threadId: trigger.id,
    });
    await stopChecksSettled();
    return m;
  };
  return { write, decisions };
}

/**
 * A run waiting on a person's answer to its question. The card is in the channel, where the run answers:
 * a message in the thread of the trigger goes into the run without answering it.
 */
async function waitingOnQuestion(talker: Parameters<typeof script>[0], options: TalkerOptions = {}) {
  f = await setup({ askUser: true, reply: script(talker) });
  const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev faz o deploy da versão nova",
  });
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_input");
  return { run: run as NonNullable<typeof run>, ...talkerOn(trigger, options) };
}

const talkerCalls = () => f.provider.calls.filter((c) => isTalkerCall(c.request));
const talkerMessages = async () =>
  (await f.db.select().from(schema.messages)).filter((m) => (m.meta as Record<string, unknown>).talker);

describe("talker: fast replies while the task waits", () => {
  test("waiting on a question: replies as the agent, with the question in its snapshot, usage recorded", async () => {
    const { run, write, decisions } = await waitingOnQuestion(() => replyJson(REPLY));
    const asked = await write("já fez o deploy?");
    expect(decisions).toEqual(["reply"]);

    const [call] = talkerCalls();
    const prompt = textOf(call?.request.messages[0]?.content ?? "");
    const { snapshot } = JSON.parse(prompt) as { snapshot: { waitingOn: string[] } };
    expect(snapshot.waitingOn).toEqual([expect.stringContaining(QUESTION)]);
    expect(prompt).toContain("já fez o deploy?");
    expect(prompt).toContain("faz o deploy da versão nova");
    expect(call?.request.outputSchema).toMatchObject({ required: ["action", "text"] });

    // Posted as the agent where the run answers (the main timeline), marked as a fast reply and a notice.
    const main = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    const reply = main.find((m) => m.body === REPLY);
    expect(reply).toMatchObject({ author: { type: "agent", id: f.agent.id }, threadId: null });
    expect(reply?.meta).toMatchObject({
      talker: { runId: run.id, inReplyTo: asked.id },
      notice: { kind: "talker_reply", text: REPLY },
    });
    // Queued for the task ahead of the person's message (never the last: a redispatch answers the person).
    const [after] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
    expect(after?.pendingMessageIds).toEqual([reply?.id ?? "", asked.id]);
    // Usage on the org's cheap model, recorded with the agent and the run.
    const usage = await f.db.select().from(schema.usageRecords).where(eq(schema.usageRecords.kind, "router"));
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ agentId: f.agent.id, runId: run.id, requestedModel: "claude-haiku-5-5" });
  });

  test("the reply reaches the task as a notice, and starts no run", async () => {
    const { run, write } = await waitingOnQuestion(() => replyJson(REPLY));
    await write("já fez o deploy?");
    // Its `message.posted` job routes nobody (no new run); the question is still open.
    await drainOutbox(f.db, f.handlers);
    expect(await f.db.select().from(schema.agentRuns)).toHaveLength(1);
    const [question] = await f.db.select().from(schema.agentQuestions);
    expect(question?.status).toBe("open");

    await answerQuestion({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, question?.id ?? "", {
      choice: "staging",
    });
    await drainOutbox(f.db, f.handlers);
    const [done] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
    expect(done?.status).toBe("done");
    // The task read the answer, what it already said (as its own, not a person's) and the person's message.
    const agentCalls = f.provider.calls.filter((c) => !isTalkerCall(c.request));
    const read = JSON.stringify(agentCalls.at(-1)?.request.messages);
    expect(read).toContain("The person answered: staging");
    expect(read).toContain(`[You already told them, while you worked]: ${REPLY}`);
    expect(read).toContain("já fez o deploy?");
    expect(read).not.toContain(`New message from Dev`);
    expect(await talkerMessages()).toHaveLength(1);
  });

  test("one reply per run in 30 s; another after the gap, for a new message", async () => {
    let clock = new Date();
    const { write, decisions } = await waitingOnQuestion(() => replyJson(REPLY), { now: () => clock });
    await write("já fez o deploy?");
    await write("e aí?");
    expect(decisions).toEqual(["reply", "rate_limited"]);
    expect(talkerCalls()).toHaveLength(1);

    clock = new Date(Date.now() + TALKER_MIN_GAP_MS + 1000);
    await write("alguém aí?");
    expect(decisions.at(-1)).toBe("reply");
    expect(await talkerMessages()).toHaveLength(2);
  });

  test("the model passes, or answers too late: nothing is posted", async () => {
    const pass = await waitingOnQuestion(() => ({ chunks: ['{"action":"pass","text":""}'] }));
    await pass.write("ok, valeu");
    expect(pass.decisions).toEqual(["pass"]);
    expect(await talkerMessages()).toHaveLength(0);
    await f.close();

    const never = new Promise<void>(() => {});
    const late = await waitingOnQuestion(() => ({ chunks: ['{"action":', '"reply"}'], hold: never }), {
      timeoutMs: 50,
    });
    const started = Date.now();
    await late.write("já fez o deploy?");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(late.decisions).toEqual(["pass"]);
    expect(await talkerMessages()).toHaveLength(0);
  });

  test("a model-brain run moving along reads the message itself: no model call", async () => {
    f = await setup();
    const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev analisa os logs",
    });
    // Working (not drained): it steps at its next model call.
    const [run] = await f.db.select().from(schema.agentRuns);
    await f.db
      .update(schema.agentRuns)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(schema.agentRuns.id, run?.id ?? ""));
    const { write, decisions } = talkerOn(trigger);
    await write("olha só os de ontem");
    expect(decisions).toEqual(["reads_soon"]);
    expect(f.provider.calls).toHaveLength(0);
  });

  test("waiting on an approval: the message gets a run of its own, the card stays, the talker isn't asked", async () => {
    const merge = {
      name: "github_merge_pr",
      input: { repo: "acme/app", pr: 42, why: "CI passed on the PR and it was reviewed: merging ships the fix." },
    };
    f = await setup({
      toolSources: [fakeGithub().source],
      reply: (req) => (isTalkerCall(req) ? replyJson(REPLY) : { chunks: [], toolUses: [merge] }),
    });
    await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
    const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
      body: "@dev merge PR 42",
    });
    await drainOutbox(f.db, f.handlers);
    const [held] = await f.db.select().from(schema.agentRuns);
    expect(held?.status).toBe("waiting_approval");

    const { write, decisions } = talkerOn(trigger);
    const asked = await write("já mergeou?");
    expect(decisions).toEqual([]);
    expect(talkerCalls()).toHaveLength(0);
    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.id === held?.id)).toMatchObject({ status: "waiting_approval", pendingMessageIds: [] });
    expect(runs.find((r) => r.id !== held?.id)?.triggerMessageId).toBe(asked.id);
    expect(await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" })).toEqual([
      expect.objectContaining({ runId: held?.id }),
    ]);
  });
});

describe("talkerPolicy", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  const base = {
    run: { status: "running" as const, background: false },
    brain: "model",
    message: { body: "e aí, como vai?", createdAt: now },
    waited: null,
    lastActivityAt: new Date(now.getTime() - 2000),
    lastReplyAt: null,
    now,
  };
  test("model brain: only when quiet for a while", () => {
    expect(talkerPolicy(base)).toBe("reads_soon");
    expect(talkerPolicy({ ...base, lastActivityAt: new Date(now.getTime() - 25_000) })).toBeNull();
    expect(talkerPolicy({ ...base, run: { status: "queued", background: false } })).toBe("reads_soon");
  });
  test("computer brain mid-turn and waiting runs: considered", () => {
    expect(talkerPolicy({ ...base, brain: "claude_code" })).toBeNull();
    expect(talkerPolicy({ ...base, run: { status: "waiting_input", background: false } })).toBeNull();
    expect(talkerPolicy({ ...base, waited: { waitKind: "approval", outcome: "held" } })).toBeNull();
  });
  test("skips background work, stops, a wait the message ended, and replies too close", () => {
    expect(talkerPolicy({ ...base, brain: "claude_code", run: { status: "running", background: true } })).toBe(
      "background",
    );
    expect(talkerPolicy({ ...base, brain: "claude_code", message: { body: "Para!", createdAt: now } })).toBe("stop");
    expect(talkerPolicy({ ...base, waited: { waitKind: "browser_handoff", outcome: "resolved" } })).toBe("resolved");
    const waiting = { ...base, run: { status: "waiting_approval" as const, background: false } };
    expect(talkerPolicy({ ...waiting, lastReplyAt: new Date(now.getTime() - 10_000) })).toBe("rate_limited");
    // Never two in a row without a new person message.
    expect(
      talkerPolicy({
        ...waiting,
        message: { body: "oi", createdAt: new Date(now.getTime() - 60_000) },
        lastReplyAt: new Date(now.getTime() - 40_000),
      }),
    ).toBe("rate_limited");
    expect(talkerPolicy({ ...waiting, lastReplyAt: new Date(now.getTime() - 40_000) })).toBeNull();
  });
});
