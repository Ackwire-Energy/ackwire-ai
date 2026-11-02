import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  createAgent,
  createJobHandlers,
  drainOutbox,
  insertMessage,
  listReactions,
  postPersonMessage,
  type RouterStrategy,
  routeMessage,
  thanksReaction,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(() => f?.close());

const policy = { minScore: 0.5, maxAgents: 2, maxHops: 3 };
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
/** A step that hears a thanks: no agent needed, every score low. */
const quiet: RouterStrategy = {
  name: "fixed",
  async decide(input) {
    return { agents: input.candidates.map((c) => ({ agentId: c.agentId, score: 0.05 })), needsAgent: 0.05 };
  },
};
const said = (userId: string, body: string, createdAt: Date, threadId: string | null = null) =>
  insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId },
    body,
    createdAt,
    threadId,
  });
const answered = (agentId: string, body: string, createdAt: Date) =>
  insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "agent", agentId, runId: null, hop: 1, stretchId: null },
    body,
    createdAt,
  });
const addOps = async () => {
  const ops = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "ops", handle: "ops" },
    { model: "claude-sonnet-5-5" },
  );
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ops.id });
  return ops;
};
const addBia = async () => {
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: bia.id });
  return bia;
};
const route = (messageId: string) =>
  routeMessage({ db: f.db, strategy: quiet, policy }, { orgId: f.org.id, messageId });
const post = (userId: string, body: string) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, f.general.id, { body });
const reactionsOn = async (messageId: string) =>
  (await f.db.select().from(schema.messageReactions)).filter((r) => r.messageId === messageId);

describe("thanksReaction", () => {
  test("short thanks and acknowledgements in Portuguese and English get one emoji by tone", () => {
    expect(thanksReaction("vlw pai")).toBe("🙏");
    expect(thanksReaction("Valeuuu!!")).toBe("🙏");
    expect(thanksReaction("muito obrigado mesmo")).toBe("🙏");
    expect(thanksReaction("thank you so much")).toBe("🙏");
    expect(thanksReaction("ty")).toBe("🙏");
    expect(thanksReaction("show")).toBe("+1");
    expect(thanksReaction("perfeito, top")).toBe("+1");
    expect(thanksReaction("👍")).toBe("+1");
    expect(thanksReaction("te amo pai ❤️")).toBe("❤️");
    expect(thanksReaction("valeu <3")).toBe("❤️");
  });

  test("anything else is no thanks", () => {
    expect(thanksReaction("valeu, e o deploy?")).toBeNull();
    expect(thanksReaction("obrigado, agora sobe a versão nova")).toBeNull();
    expect(thanksReaction("boa noite")).toBeNull();
    expect(thanksReaction("pode")).toBeNull();
    expect(thanksReaction("")).toBeNull();
  });
});

describe("an agent reacts to the thanks of the person it just answered", () => {
  test("thanks after its answer: that agent reacts live, no run starts; a real question still gets a run", async () => {
    f = await setup({
      reply: (req) => {
        if (!req.outputSchema) return { chunks: ["The build is green again."] };
        const asked = JSON.stringify(req.messages).includes("]: vlw pai\\n</message>") ? 0.02 : 0.9;
        return {
          chunks: [
            `{"addressee":"none","needs_agent":${asked},"for_everyone":0,"already_answered":0,"scores":[{"handle":"dev","score":${asked}}],"reason":"test"}`,
          ],
        };
      },
    });
    const handlers = createJobHandlers({ ...f.jobDeps, router: { enabled: true, model: "claude-haiku-5-5" } });
    const events: unknown[] = [];
    await f.pubsub.subscribe(`channel:${f.general.id}`, (e) => events.push(e));
    await post(f.owner.id, "why is the build failing?");
    await drainOutbox(f.db, handlers);
    const runsBefore = (await f.db.select().from(schema.agentRuns)).length;
    expect(runsBefore).toBe(1);

    const thanks = await post(f.owner.id, "vlw pai");
    await drainOutbox(f.db, handlers);
    expect(await f.db.select().from(schema.agentRuns)).toHaveLength(runsBefore);
    expect(await listReactions(f.db, f.org.id, thanks.id)).toEqual([
      expect.objectContaining({ reaction: "🙏", agentIds: [f.agent.id] }),
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: "message.reactions", messageId: thanks.id }));
    // Shown live on the person's own message; no inbox line about their own thanks.
    expect((await f.db.select().from(schema.notifications)).filter((n) => n.kind === "reaction")).toEqual([]);

    const question = await post(f.owner.id, "and the deploy, is it done?");
    await drainOutbox(f.db, handlers);
    expect(await f.db.select().from(schema.agentRuns)).toHaveLength(runsBefore + 1);
    expect(await reactionsOn(question.id)).toEqual([]);
  });

  test("thanks between two people gets no reaction, even right after an agent answered", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: bia.id });
    await said(f.owner.id, "can someone check the logs?", minutesAgo(5));
    await answered(f.agent.id, "The logs show a timeout on the payments call.", minutesAgo(4));
    await said(bia.id, "I already fixed that timeout", minutesAgo(1));
    const thanks = await post(f.owner.id, "valeu");
    const result = await routeMessage({ db: f.db, strategy: quiet, policy }, { orgId: f.org.id, messageId: thanks.id });
    expect(result.selected).toEqual([]);
    expect(result.reacted).toBeUndefined();
    expect(await reactionsOn(thanks.id)).toEqual([]);
  });

  test("an agent outside the exchange, or one that just asked something, doesn't react", async () => {
    f = await setup();
    const ops = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "ops", handle: "ops" },
      { model: "claude-sonnet-5-5" },
    );
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ops.id });
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, userId: bia.id });
    // Ops answered Bia; the owner was never part of it.
    await said(bia.id, "is the staging server up?", minutesAgo(20));
    await answered(ops.id, "Staging is up since this morning.", minutesAgo(19));
    const outside = await said(f.owner.id, "show", minutesAgo(10));
    const first = await routeMessage({ db: f.db, strategy: quiet, policy }, { orgId: f.org.id, messageId: outside.id });
    expect(first.reacted).toBeUndefined();
    expect(await reactionsOn(outside.id)).toEqual([]);

    // Dev answered the owner with a question: their "ok" answers it, it isn't thanks.
    await said(f.owner.id, "can you clean the old branches?", minutesAgo(3));
    await answered(f.agent.id, "There are 14 old branches. Should I delete them all?", minutesAgo(2));
    const ok = await post(f.owner.id, "ok");
    const second = await routeMessage({ db: f.db, strategy: quiet, policy }, { orgId: f.org.id, messageId: ok.id });
    expect(second.reacted).toBeUndefined();
    expect(await reactionsOn(ok.id)).toEqual([]);
  });

  test("another agent posting between the answer and the thanks: the agent that answered reacts", async () => {
    f = await setup();
    const ops = await addOps();
    await said(f.owner.id, "why is the build failing?", minutesAgo(5));
    await answered(f.agent.id, "A missing env var in CI. Fixed it.", minutesAgo(4));
    await answered(ops.id, "Nightly report: 3 deploys, 0 incidents.", minutesAgo(1));
    const thanks = await post(f.owner.id, "vlw pai");
    const result = await route(thanks.id);
    expect(result.reacted).toEqual({ agentId: f.agent.id, reaction: "🙏" });
    expect((await reactionsOn(thanks.id)).map((r) => r.agentId)).toEqual([f.agent.id]);
  });

  test("thanks between two people in an agent's thread: that agent doesn't react", async () => {
    f = await setup();
    const ops = await addOps();
    const bia = await addBia();
    const report = await answered(ops.id, "Nightly report: disk at 91%.", minutesAgo(20));
    await said(bia.id, "I cleaned the old logs, should be fine now", minutesAgo(15), report.id);
    const thanks = await said(f.owner.id, "valeu", minutesAgo(1), report.id);
    const result = await route(thanks.id);
    // A reply under an agent's message is that agent's by the reply rule: a run that may pass, never a reaction.
    expect(result.selected).toEqual([ops.id]);
    expect(result.reacted).toBeUndefined();
    expect(await reactionsOn(thanks.id)).toEqual([]);
  });

  test("an agent that may not answer this person here doesn't react", async () => {
    f = await setup();
    await f.db
      .update(schema.channelMembers)
      .set({ autoReply: false })
      .where(and(eq(schema.channelMembers.channelId, f.general.id), eq(schema.channelMembers.agentId, f.agent.id)));
    await said(f.owner.id, "why is the build failing?", minutesAgo(5));
    await answered(f.agent.id, "A missing env var in CI. Fixed it.", minutesAgo(4));
    const thanks = await post(f.owner.id, "vlw pai");
    expect((await route(thanks.id)).reacted).toBeUndefined();
    expect(await reactionsOn(thanks.id)).toEqual([]);
  });
});
