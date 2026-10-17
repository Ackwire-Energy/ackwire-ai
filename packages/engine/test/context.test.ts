import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import { buildRunContext, insertMessage, type Message, postPersonMessage, toTurns } from "../src";
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

test("toTurns: with older unanswered messages, the one being answered is marked current", () => {
  const names = new Map([["u1", "Ana"]]);
  const older = msg({ id: "m1", authorUserId: "u1", body: "alguém viu o deploy?" });
  const current = msg({ id: "m2", authorUserId: "u1", body: "@theo consegue criar um pdf?" });
  expect(toTurns([older, current], "me", names, current.id)).toEqual([
    { role: "user", content: "[Ana]: alguém viu o deploy?\n\n(current message) [Ana]: @theo consegue criar um pdf?" },
  ]);
  // Alone, it needs no mark.
  expect(toTurns([current], "me", names, current.id)).toEqual([
    { role: "user", content: "[Ana]: @theo consegue criar um pdf?" },
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
  const runs = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  const run = runs[0];
  if (!run) throw new Error("no run");
  const ctx = await buildRunContext(f.db, run, f.agent, { maxMessages: 30 });
  expect(systemText(ctx.system)).toContain("Acme builds rockets.");
  expect(systemText(ctx.system)).toContain("Answer briefly.");
  expect(systemText(ctx.system)).toContain("#general");
  expect(systemText(ctx.system)).toContain("Dev (@dev, agent)");
  expect(ctx.messages).toEqual([
    {
      role: "user",
      content:
        "[ana]: earlier top-level message\n\n[ana]: root question\n\n(current message) [ana]: @dev what do you think?",
    },
  ]);
  expect(ctx.stats.historyMessages).toBe(3);
});

test("a new top-level message reads the replies shown under earlier messages, not only the top level", async () => {
  const post = (body: string) =>
    postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body });
  const earlier = await post("@dev clone the repo");
  await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    threadId: earlier.id,
    author: { type: "agent", agentId: f.agent.id, runId: null, hop: 1 },
    body: "The clone hung.",
  });
  const trigger = await post("@dev why did it hang?");
  const runs = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  const ctx = await buildRunContext(f.db, runs[0] as NonNullable<(typeof runs)[0]>, f.agent, { maxMessages: 10 });
  expect(ctx.messages).toEqual([
    { role: "user", content: "[ana]: @dev clone the repo" },
    { role: "assistant", content: "The clone hung." },
    { role: "user", content: "[ana]: @dev why did it hang?" },
  ]);
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
  const runs = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  const ctx = await buildRunContext(f.db, runs[0] as NonNullable<(typeof runs)[0]>, f.agent, { maxMessages: 3 });
  expect(ctx.messages[0]?.content).toBe("[ana]: m3\n\n[ana]: m4\n\n(current message) [ana]: @dev go");
});
