import { afterEach, beforeEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { buildRunContext, dispatchMentions, type Message, postPersonMessage, toTurns } from "../src";
import { type Fixture, setup } from "./fixtures";

const msg = (over: Partial<Message>): Message =>
  ({ authorUserId: null, authorAgentId: null, body: "", ...over }) as Message;

test("toTurns: own messages are assistant turns, others are prefixed user turns, merged and user-bounded", () => {
  const names = new Map([
    ["u1", "Ana"],
    ["a2", "QA (@qa)"],
  ]);
  const turns = toTurns(
    [
      msg({ authorAgentId: "me", body: "leading own message is dropped" }),
      msg({ authorUserId: "u1", body: "hi" }),
      msg({ authorAgentId: "a2", body: "hello" }),
      msg({ authorAgentId: "me", body: "answer" }),
      msg({ authorUserId: "u1", body: "thanks" }),
    ],
    "me",
    names,
  );
  expect(turns).toEqual([
    { role: "user", content: "[Ana]: hi\n\n[QA (@qa)]: hello" },
    { role: "assistant", content: "answer" },
    { role: "user", content: "[Ana]: thanks" },
  ]);
});

let f: Fixture;
beforeEach(async () => {
  f = await setup();
});
afterEach(() => f.close());

test("system prompt carries org context, agent instructions and channel; history ends with the trigger", async () => {
  const post = (body: string, threadId?: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, threadId });
  await post("earlier top-level message");
  const root = await post("root question");
  const trigger = await post("@dev what do you think?", root.id);
  const { runs } = await dispatchMentions(f.db, { orgId: f.org.id, messageId: trigger.id }, { maxHops: 3 });
  const run = runs[0];
  if (!run) throw new Error("no run");
  const ctx = await buildRunContext(f.db, run, f.agent, { maxMessages: 30 });
  expect(ctx.system).toContain("Acme builds rockets.");
  expect(ctx.system).toContain("Answer briefly.");
  expect(ctx.system).toContain("#general");
  expect(ctx.system).toContain("Dev (@dev, agent)");
  expect(ctx.messages).toEqual([
    {
      role: "user",
      content: "[ana]: earlier top-level message\n\n[ana]: root question\n\n[ana]: @dev what do you think?",
    },
  ]);
  expect(ctx.stats.historyMessages).toBe(3);
});

test("history is capped at maxMessages, keeping the most recent", async () => {
  for (let i = 0; i < 5; i++) {
    await f.db.insert(schema.messages).values({
      orgId: f.org.id,
      channelId: f.general.id,
      authorType: "person",
      authorUserId: f.owner.id,
      body: `m${i}`,
      createdAt: new Date(Date.now() - (10 - i) * 1000),
    });
  }
  const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev go",
  });
  const { runs } = await dispatchMentions(f.db, { orgId: f.org.id, messageId: trigger.id }, { maxHops: 3 });
  const ctx = await buildRunContext(f.db, runs[0] as NonNullable<(typeof runs)[0]>, f.agent, { maxMessages: 3 });
  expect(ctx.messages[0]?.content).toBe("[ana]: m3\n\n[ana]: m4\n\n[ana]: @dev go");
});
