import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { type ModelRequest, systemText, textOf } from "@agenteschat/providers";
import {
  createTalker,
  decideApproval,
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
const REPLY = "Estou esperando a aprovação do merge do PR #42; decida no card com Aprovar ou Negar.";

/** The agent: reads the PR, asks to merge (an approval card), then reports. The talker: `talker(req)`. */
function script(talker: (req: ModelRequest) => ReturnType<NonNullable<Parameters<typeof setup>[0]>["reply"] & object>) {
  return (req: ModelRequest, call: number) => {
    if (isTalkerCall(req)) return talker(req);
    const all = JSON.stringify(req.messages);
    if (all.includes("github_merge_pr ok")) return { chunks: ["Merge feito."] };
    if (all.includes("github_get_pr ok"))
      return {
        chunks: ["Testes ok, vou mergear."],
        toolUses: [
          {
            name: "github_merge_pr",
            input: { repo: "acme/app", pr: 42, why: "CI passed on the PR and it was reviewed: merging ships the fix." },
          },
        ],
      };
    void call;
    return { chunks: ["Vou ver o PR."], toolUses: [{ name: "github_get_pr", input: { repo: "acme/app", pr: 42 } }] };
  };
}

const replyJson = (text: string) => ({ chunks: [JSON.stringify({ action: "reply", text })] });

/** A run waiting on an approval card (merge PR 42), and the talker on the test gateway. */
async function waitingOnApproval(
  talker: Parameters<typeof script>[0],
  options: Partial<Omit<TalkerDeps, "db" | "pubsub" | "gateway" | "resolveModel">> = {},
) {
  const gh = fakeGithub();
  f = await setup({ toolSources: [gh.source], reply: script(talker) });
  await grantScopes(f.db, f.org.id, f.agent.id, ALL_GITHUB_SCOPES);
  const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev merge PR 42 se os testes passarem",
  });
  await drainOutbox(f.db, f.handlers);
  const [run] = await f.db.select().from(schema.agentRuns);
  expect(run?.status).toBe("waiting_approval");
  const decisions: string[] = [];
  const talkerImpl = createTalker({
    db: f.db,
    pubsub: f.pubsub,
    gateway: f.gateway,
    resolveModel: async () => "claude-haiku-5-5",
    onDecision: (d) => decisions.push(d.outcome),
    ...options,
  });
  /** A person writes in the task's thread (it goes into the waiting run). */
  const write = async (body: string) => {
    const m = await postPersonMessage(
      { db: f.db, pubsub: f.pubsub, talker: talkerImpl },
      f.owner.id,
      f.org.id,
      f.general.id,
      { body, threadId: trigger.id },
    );
    await stopChecksSettled();
    return m;
  };
  return { gh, run: run as NonNullable<typeof run>, write, decisions };
}

const talkerCalls = () => f.provider.calls.filter((c) => isTalkerCall(c.request));
const talkerMessages = async () =>
  (await f.db.select().from(schema.messages)).filter((m) => (m.meta as Record<string, unknown>).talker);

describe("talker: fast replies while the task waits", () => {
  test("waiting on an approval: replies as the agent, with the card in its snapshot, usage recorded", async () => {
    const { run, write, decisions } = await waitingOnApproval(() => replyJson(REPLY));
    const asked = await write("já mergeou?");
    expect(decisions).toEqual(["reply"]);

    const [call] = talkerCalls();
    const prompt = textOf(call?.request.messages[0]?.content ?? "");
    expect(prompt).toContain("Merge PR #42 in acme/app");
    expect(prompt).toContain("já mergeou?");
    expect(prompt).toContain("merge PR 42 se os testes passarem");
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
    const { gh, run, write } = await waitingOnApproval(() => replyJson(REPLY));
    await write("já mergeou?");
    // Its `message.posted` job routes nobody (no new run).
    await drainOutbox(f.db, f.handlers);
    expect(await f.db.select().from(schema.agentRuns)).toHaveLength(1);

    const [approval] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
    await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, approval?.id ?? "", {
      decision: "approve",
    });
    await drainOutbox(f.db, f.handlers);
    const [done] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run.id));
    expect(done?.status).toBe("done");
    expect(gh.executed.map((e) => e.tool)).toEqual(["github_get_pr", "github_merge_pr"]);
    // The task read what it already said (as its own, not a person's) and the person's message.
    const agentCalls = f.provider.calls.filter((c) => !isTalkerCall(c.request));
    const read = JSON.stringify(agentCalls.at(-1)?.request.messages);
    expect(read).toContain(`[You already told them, while you worked]: ${REPLY}`);
    expect(read).toContain("já mergeou?");
    expect(read).not.toContain(`New message from Dev`);
    expect(await talkerMessages()).toHaveLength(1);
  });

  test("one reply per run in 30 s; another after the gap, for a new message", async () => {
    let clock = new Date();
    const { write, decisions } = await waitingOnApproval(() => replyJson(REPLY), { now: () => clock });
    await write("já mergeou?");
    await write("e aí?");
    expect(decisions).toEqual(["reply", "rate_limited"]);
    expect(talkerCalls()).toHaveLength(1);

    clock = new Date(Date.now() + TALKER_MIN_GAP_MS + 1000);
    await write("alguém aí?");
    expect(decisions.at(-1)).toBe("reply");
    expect(await talkerMessages()).toHaveLength(2);
  });

  test("the model passes, or answers too late: nothing is posted", async () => {
    const pass = await waitingOnApproval(() => ({ chunks: ['{"action":"pass","text":""}'] }));
    await pass.write("ok, valeu");
    expect(pass.decisions).toEqual(["pass"]);
    expect(await talkerMessages()).toHaveLength(0);
    await f.close();

    const never = new Promise<void>(() => {});
    const late = await waitingOnApproval(() => ({ chunks: ['{"action":', '"reply"}'], hold: never }), {
      timeoutMs: 50,
    });
    const started = Date.now();
    await late.write("já mergeou?");
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
    const decisions: string[] = [];
    const talker = createTalker({
      db: f.db,
      pubsub: f.pubsub,
      gateway: f.gateway,
      resolveModel: async () => "claude-haiku-5-5",
      onDecision: (d) => decisions.push(d.outcome),
    });
    await postPersonMessage({ db: f.db, pubsub: f.pubsub, talker }, f.owner.id, f.org.id, f.general.id, {
      body: "olha só os de ontem",
      threadId: trigger.id,
    });
    await stopChecksSettled();
    expect(decisions).toEqual(["reads_soon"]);
    expect(f.provider.calls).toHaveLength(0);
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
