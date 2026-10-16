import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addReaction,
  attachedLine,
  buildRunContext,
  createChannel,
  createFileArtifact,
  listMessages,
  type Message,
  postPersonMessage,
  quotedLine,
  removeReaction,
  replyExcerpt,
  toTurns,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const post = (body: string, extra: { replyTo?: string; attachments?: string[]; threadId?: string } = {}) =>
  postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body, ...extra });

test("replyExcerpt: one line, no code fences, cut at ~200 characters", () => {
  expect(replyExcerpt("  primeira linha\n\nsegunda   linha ")).toBe("primeira linha segunda linha");
  expect(replyExcerpt("```ts\nconst a = 1\n```")).toBe("const a = 1");
  const long = replyExcerpt("a".repeat(500));
  expect(long.length).toBe(200);
  expect(long.endsWith("…")).toBe(true);
});

test("a quote reply stores meta.replyTo with the author's name and an excerpt", async () => {
  f = await setup();
  const original = await post("o deploy de ontem quebrou o login\ndepois do merge");
  const reply = await post("vou olhar", { replyTo: original.id });
  expect(reply.meta.replyTo).toEqual({
    messageId: original.id,
    threadId: null,
    author: { type: "person", id: f.owner.id },
    authorName: f.owner.name,
    excerpt: "o deploy de ontem quebrou o login depois do merge",
  });
  // The client never sets the meta itself: the listed message carries the same.
  const listed = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
  expect(listed.find((m) => m.id === reply.id)?.meta.replyTo).toMatchObject({ messageId: original.id });
});

test("replyTo must be a live message of the same channel (and org)", async () => {
  f = await setup();
  const other = await createChannel(f.db, f.owner.id, f.org.id, { name: "other" });
  const elsewhere = await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, other.id, {
    body: "em outro canal",
  });
  await expect(post("oi", { replyTo: elsewhere.id })).rejects.toMatchObject({ code: "message.reply_not_found" });
  await expect(post("oi", { replyTo: crypto.randomUUID() })).rejects.toMatchObject({
    code: "message.reply_not_found",
  });
  const gone = await post("vai sumir");
  await f.db.update(schema.messages).set({ deletedAt: new Date() }).where(eq(schema.messages.id, gone.id));
  await expect(post("oi", { replyTo: gone.id })).rejects.toMatchObject({ code: "message.reply_not_found" });
});

test("attachments: own uploads or files of the channel become meta.artifacts; files alone are a message", async () => {
  f = await setup();
  const mine = await createFileArtifact(f.artifactDeps, { type: "person", userId: f.owner.id }, f.org.id, {
    title: "notas.txt",
    name: "notas.txt",
    bytes: new TextEncoder().encode("oi"),
    channelId: f.general.id,
  });
  const message = await post("", { attachments: [mine.id] });
  expect(message.meta.artifacts).toEqual([{ id: mine.id, version: 1, title: "notas.txt" }]);
  // Someone else's private Drive file can't be attached.
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const hers = await createFileArtifact(f.artifactDeps, { type: "person", userId: bia.id }, f.org.id, {
    title: "dela.txt",
    name: "dela.txt",
    bytes: new TextEncoder().encode("x"),
  });
  await expect(post("olha", { attachments: [hers.id] })).rejects.toMatchObject({
    code: "message.attachment_not_found",
  });
  // No text and no files: still refused.
  await expect(post("   ")).rejects.toThrow("Message is empty");
});

test("the agent sees what a message quotes and which files it carries, from the meta", async () => {
  f = await setup();
  const original = await post("o token expira em 15 minutos");
  const trigger = await post("@dev isso está certo?", { replyTo: original.id });
  const [run] = await f.db.select().from(schema.agentRuns).where(eq(schema.agentRuns.triggerMessageId, trigger.id));
  if (!run) throw new Error("no run");
  const ctx = await buildRunContext(f.db, run, f.agent, { maxMessages: 30 });
  const last = ctx.messages.at(-1)?.content;
  expect(typeof last === "string" ? last : JSON.stringify(last)).toContain(
    `(replying to ${f.owner.name}: "o token expira em 15 minutos")`,
  );
});

test("quotedLine / attachedLine render the meta for toTurns", () => {
  expect(quotedLine({ replyTo: { authorName: "Ana", excerpt: "oi" } })).toBe('(replying to Ana: "oi")\n');
  expect(quotedLine({})).toBe("");
  const m = {
    id: "m1",
    authorUserId: "u1",
    authorAgentId: null,
    body: "segue",
    meta: { replyTo: { authorName: "Ana", excerpt: "manda o relatório" }, artifacts: [{ id: "a1", title: "r.pdf" }] },
  } as unknown as Message;
  expect(attachedLine(m)).toBe('\n(attached files: "r.pdf" (artifact a1))');
  expect(toTurns([m], "me", new Map([["u1", "Bia"]]))).toEqual([
    {
      role: "user",
      content: '[Bia]: (replying to Ana: "manda o relatório")\nsegue\n(attached files: "r.pdf" (artifact a1))',
    },
  ]);
});

test("reactions: listed with the messages and published live to the channel", async () => {
  f = await setup();
  const events = f.listen(f.general.id);
  const m = await post("bom dia");
  await addReaction(f.db, f.owner.id, f.org.id, m.id, "🎉", f.pubsub);
  const listed = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
  expect(listed.find((x) => x.id === m.id)?.reactions).toEqual([{ reaction: "🎉", count: 1, userIds: [f.owner.id] }]);
  expect(events.find((e) => e.type === "message.reactions")).toMatchObject({
    type: "message.reactions",
    channelId: f.general.id,
    messageId: m.id,
    reactions: [{ reaction: "🎉", count: 1 }],
  });
  await removeReaction(f.db, f.owner.id, f.org.id, m.id, "🎉", f.pubsub);
  expect(events.filter((e) => e.type === "message.reactions").at(-1)).toMatchObject({ reactions: [] });
  const after = await listMessages(f.db, f.owner.id, f.org.id, f.general.id);
  expect(after.find((x) => x.id === m.id)?.reactions).toBeUndefined();
});
