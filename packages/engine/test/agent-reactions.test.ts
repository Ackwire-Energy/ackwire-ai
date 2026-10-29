import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import { systemText } from "@agenteschat/providers";
import {
  addAgentReaction,
  addReaction,
  drainOutbox,
  ForbiddenError,
  listMessageReactions,
  listMessages,
  listReactions,
  normalizeReaction,
  postPersonMessage,
  removeReaction,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const lastText = (req: ModelRequest) => JSON.stringify(req.messages.at(-1)?.content);

/** "valeu" gets a 🙌 and nothing else; anything else gets a normal answer. */
const reply = (req: ModelRequest) => {
  const last = lastText(req);
  if (last.includes("tool_result")) return { chunks: [] };
  if (last.includes("valeu")) return { chunks: [], toolUses: [{ name: "react", input: { emoji: "🙌" } }] };
  if (last.includes("joinha")) return { chunks: [], toolUses: [{ name: "react", input: { emoji: "👎" } }] };
  return { chunks: ["Os builds rodam no GitHub Actions."] };
};

const post = (body: string, extra: { replyTo?: string; threadId?: string } = {}) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, ...extra });

const agentMessages = async () => (await f.db.select().from(schema.messages)).filter((m) => m.authorType === "agent");
const feedbackJobs = () => f.db.select().from(schema.outbox).where(eq(schema.outbox.kind, "context.feedback"));

describe("react (reaction instead of reply)", () => {
  test("the agent reacts to a thanks and posts no message; the reaction lists the agent", async () => {
    f = await setup({ react: true, reply });
    const events = f.listen(f.general.id);
    const thanks = await post("@dev valeu");
    await drainOutbox(f.db, f.handlers);

    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run?.status).toBe("done");
    expect(run?.replyMessageId).toBeNull();
    expect(await agentMessages()).toEqual([]);

    expect(await listReactions(f.db, f.org.id, thanks.id)).toEqual([
      { reaction: "🙌", count: 1, userIds: [], agentIds: [f.agent.id] },
    ]);
    const listed = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
    expect(listed.find((m) => m.id === thanks.id)?.reactions).toEqual([
      { reaction: "🙌", count: 1, userIds: [], agentIds: [f.agent.id] },
    ]);
    await Bun.sleep(5);
    expect(events.find((e) => e.type === "message.reactions")).toMatchObject({
      messageId: thanks.id,
      reactions: [{ reaction: "🙌", agentIds: [f.agent.id] }],
    });
    expect(await feedbackJobs()).toEqual([]);
  });

  test("the tool is built in (no scope) and the prompt says when to react instead of replying", async () => {
    f = await setup({ react: true, reply });
    await post("@dev onde rodam os builds?");
    await drainOutbox(f.db, f.handlers);
    const request = f.provider.calls[0]?.request as ModelRequest;
    expect(request.tools?.map((t) => t.name)).toContain("react");
    expect(systemText(request.system)).toContain("react with one fitting emoji using `react`");
    expect(systemText(request.system)).toContain("Never react and also reply");
    expect((await agentMessages()).map((m) => m.body)).toEqual(["Os builds rodam no GitHub Actions."]);
  });

  test("an agent's 👍/👎 is stored as +1/-1 but never becomes feedback; a person's does", async () => {
    f = await setup({ react: true, reply });
    await post("@dev onde rodam os builds?");
    await drainOutbox(f.db, f.handlers);
    const [answer] = await agentMessages();
    if (!answer) throw new Error("no answer");

    await addAgentReaction(f.db, { orgId: f.org.id, agentId: f.agent.id, messageId: answer.id, reaction: "-1" });
    expect(await feedbackJobs()).toEqual([]);
    await addReaction(f.db, f.owner.id, f.org.id, answer.id, "-1");
    expect(await feedbackJobs()).toHaveLength(1);
    expect(await listReactions(f.db, f.org.id, answer.id)).toEqual([
      { reaction: "-1", count: 2, userIds: [f.owner.id], agentIds: [f.agent.id] },
    ]);
    // Twice by the same agent is one reaction.
    await addAgentReaction(f.db, { orgId: f.org.id, agentId: f.agent.id, messageId: answer.id, reaction: "-1" });
    expect((await listReactions(f.db, f.org.id, answer.id))[0]?.count).toBe(2);

    expect(normalizeReaction("👍")).toBe("+1");
    expect(normalizeReaction("👎")).toBe("-1");
    expect(normalizeReaction(" 🎉 ")).toBe("🎉");
  });

  test("the react tool turns 👎 into -1 without a feedback job", async () => {
    f = await setup({ react: true, reply });
    const msg = await post("@dev joinha");
    await drainOutbox(f.db, f.handlers);
    expect(await agentMessages()).toEqual([]);
    expect(await listReactions(f.db, f.org.id, msg.id)).toEqual([
      { reaction: "-1", count: 1, userIds: [], agentIds: [f.agent.id] },
    ]);
    expect(await feedbackJobs()).toEqual([]);
  });

  test("a reaction is by a person or by an agent, never both or neither", async () => {
    f = await setup();
    const m = await post("bom dia");
    const r = schema.messageReactions;
    // Drizzle builders are thenables, not promises: `rejects` needs a real promise.
    const insert = async (values: typeof r.$inferInsert) => {
      await f.db.insert(r).values(values);
    };
    await expect(insert({ orgId: f.org.id, messageId: m.id, reaction: "🎉" })).rejects.toThrow();
    await expect(
      insert({ orgId: f.org.id, messageId: m.id, userId: f.owner.id, agentId: f.agent.id, reaction: "🎉" }),
    ).rejects.toThrow();
    await f.db.insert(r).values({ orgId: f.org.id, messageId: m.id, userId: f.owner.id, reaction: "🎉" });
    await f.db.insert(r).values({ orgId: f.org.id, messageId: m.id, agentId: f.agent.id, reaction: "🎉" });
    const rows = await f.db
      .select()
      .from(r)
      .where(and(eq(r.orgId, f.org.id), eq(r.messageId, m.id)));
    expect(rows).toHaveLength(2);
  });
});

test("reaction reads and deletes require access to the message's channel", async () => {
  f = await setup();
  const outsider = await addMember(f.db, f.org.id, "member", "reaction-outsider");
  const [privateChannel] = await f.db
    .insert(schema.channels)
    .values({ orgId: f.org.id, name: "reaction-private", visibility: "private", createdByUserId: f.owner.id })
    .returning();
  if (!privateChannel) throw new Error("no private channel");
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: privateChannel.id, userId: f.owner.id });
  const message = await postPersonMessage(
    { db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, privateChannel.id, { body: "private note" },
  );
  await addReaction(f.db, f.owner.id, f.org.id, message.id, "🎉");
  expect(await listMessageReactions(f.db, f.owner.id, f.org.id, message.id)).toHaveLength(1);
  await expect(listMessageReactions(f.db, outsider.id, f.org.id, message.id)).rejects.toBeInstanceOf(ForbiddenError);
  await expect(removeReaction(f.db, outsider.id, f.org.id, message.id, "🎉")).rejects.toBeInstanceOf(ForbiddenError);
});

describe('👎 then "Pedir correção"', () => {
  test("the person's reply quoting the 👎'd answer and mentioning the agent starts a run that sees it", async () => {
    f = await setup({ react: true, reply });
    await post("@dev onde rodam os builds?");
    await drainOutbox(f.db, f.handlers);
    const [answer] = await agentMessages();
    if (!answer) throw new Error("no answer");
    await addReaction(f.db, f.owner.id, f.org.id, answer.id, "-1");

    const fix = await post("@dev faltou dizer que mudamos para o Buildkite", {
      replyTo: answer.id,
      threadId: answer.threadId ?? undefined,
    });
    expect(fix.meta.replyTo).toMatchObject({ messageId: answer.id });
    await drainOutbox(f.db, f.handlers);

    const runs = await f.db.select().from(schema.agentRuns);
    expect(runs).toHaveLength(2);
    const request = f.provider.calls
      .map((c) => c.request as ModelRequest)
      .find((r) => lastText(r).includes("Buildkite"));
    expect(request ? lastText(request) : "").toContain("replying to Dev");
  });
});
