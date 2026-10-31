import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { systemText } from "@agenteschat/providers";
import {
  buildRunContext,
  createAgent,
  insertMessage,
  type Message,
  nowLine,
  postPersonMessage,
  setCoordinator,
  toTurns,
} from "../src";
import { type Fixture, setup } from "./fixtures";

const msg = (over: Partial<Message>): Message =>
  ({ authorUserId: null, authorAgentId: null, body: "", ...over }) as Message;

test("nowLine: the person's local time with its zone and how long since the previous message", () => {
  const now = new Date("2026-10-21T10:40:00Z");
  expect(nowLine("America/Sao_Paulo", "Ana", new Date("2026-10-20T20:40:00Z"), now)).toBe(
    "# Now\nWed, Oct 21, 2026, 07:40 for Ana (America/Sao_Paulo); the previous message here was 14 h ago.",
  );
  // A bad zone falls back to UTC; no person (an agent asked) and nothing before.
  expect(nowLine("Mars/Olympus", null, null, now)).toBe("# Now\nWed, Oct 21, 2026, 10:40 (UTC).");
});

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

test("toTurns: a routine's call reads as the routine's; an agent's message about its report keeps its author", () => {
  const names = new Map([
    ["u1", "Ana"],
    ["a2", "QA (@qa)"],
  ]);
  const routine = { routine: { id: "r", name: "Sentry", runId: "rr" } };
  const turns = toTurns(
    [
      msg({ authorType: "person", authorUserId: "u1", body: "Veja os erros novos.", meta: routine }),
      msg({ authorType: "agent", authorAgentId: "a2", body: "3 erros novos no checkout.", meta: routine }),
    ],
    "me",
    names,
  );
  expect(turns).toEqual([
    {
      role: "user",
      content: '[Routine "Sentry", created by Ana]: Veja os erros novos.\n\n[QA (@qa)]: 3 erros novos no checkout.',
    },
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
  // No tools: nothing to investigate with, so no "How you work".
  expect(systemText(ctx.system)).not.toContain("# How you work");
  const withTools = systemText(
    (await buildRunContext(f.db, run, f.agent, { maxMessages: 30, toolsAvailable: true, askUser: true })).system,
  );
  // Investigate first (ADR 0037): look before answering, reads need no ok, ask only for decisions.
  expect(withTools).toContain("# How you work");
  expect(withTools).toContain("Reading never needs anyone's ok.");
  expect(withTools).toContain("Never ask permission to look");
  expect(withTools).toContain("ambiguous after you have looked with your tools");
  // Lessons from the behavior eval (ADR 0037): whole files, no stopping halfway, recommend the fix,
  // take unowned work, only what tools returned, findings in the turn that asks or requests approval.
  expect(withTools).toContain("Read whole files, not just search snippets");
  expect(withTools).toContain("Choosing the fix is your job");
  expect(withTools).toContain("don't just say someone must take it");
  expect(withTools).toContain("when a search finds nothing, say so");
  expect(withTools).toContain("ask the one question that decides it");
  expect(withTools).toContain("it posts only the text of that same turn");
  // Eval 2026-10-23: an issue it opened on its own cut the data out of a product answer; a thanks
  // in a DM sent it to re-check the deploy.
  expect(withTools).toContain("when the person asked for an internal change");
  expect(withTools).toContain("A change you made on your own doesn't shorten the answer");
  expect(withTools).toContain("A thanks or an ok asks nothing");
  expect(withTools).not.toContain("Use your tools when they help");
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
  // That run answered: it ended (a new message in the channel would otherwise join it while it works).
  await f.db.update(schema.agentRuns).set({ status: "done" }).where(eq(schema.agentRuns.triggerMessageId, earlier.id));
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

test("the team's coordinator hears that what nobody took comes to it, only where other agents are (ADR 0092)", async () => {
  const trigger = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, {
    body: "@dev what do you think?",
  });
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  if (!run) throw new Error("no run");
  const prompt = async (agent: typeof f.agent) =>
    systemText((await buildRunContext(f.db, run, agent, { maxMessages: 10 })).system);
  const LINE = "\nYou coordinate the team. A message that needs an agent and that no other agent took comes to you";
  const dev = await setCoordinator({ db: f.db }, f.owner.id, f.org.id, f.agent.id, true);
  // Nobody to hand work to: alone with Ana.
  expect(await prompt(dev)).not.toContain(LINE);
  const ada = await createAgent(
    f.db,
    f.owner.id,
    f.org.id,
    { name: "Ada", handle: "ada" },
    { model: "claude-sonnet-5-5" },
  );
  await f.db.insert(schema.channelMembers).values({ orgId: f.org.id, channelId: f.general.id, agentId: ada.id });
  expect(await prompt(dev)).toContain(
    `${LINE}, so work nobody owns is in your area. Do what is yours. Hand the rest to the agent whose job it is: mention it with what you need, one agent per line, and leave that part to it.`,
  );
  // Another agent there doesn't.
  await setCoordinator({ db: f.db }, f.owner.id, f.org.id, f.agent.id, false);
  expect(await prompt(f.agent)).not.toContain(LINE);
});
