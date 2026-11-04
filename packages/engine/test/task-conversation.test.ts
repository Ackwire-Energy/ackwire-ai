import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addChannelMember,
  commentIssue,
  createAgent,
  createChannel,
  createIssue,
  drainOutbox,
  ForbiddenError,
  getIssue,
  issueFromMessage,
  listIssueActivity,
  listIssues,
  moveIssueComments,
  NEW_AGENT_DEFAULTS,
  NotFoundError,
  openTaskConversation,
  postPersonMessage,
  requireChannelAccess,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const repliesIn = async (channelId: string) =>
  (await f.db.select().from(schema.messages).where(eq(schema.messages.channelId, channelId)))
    .filter((m) => m.threadId)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

describe("a task's conversation (ADR 0144)", () => {
  test("made once on first use; a mention there wakes the agent, which answers in the same thread", async () => {
    f = await setup({ reply: () => ({ chunks: ["Olhei: 18 das 31 usam WhatsApp."] }) });
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Confirmação por WhatsApp" });
    expect(issue.conversation).toBeNull();
    const at = await openTaskConversation(f.db, person(f.owner.id), f.org.id, issue.id);
    expect(await openTaskConversation(f.db, person(f.owner.id), f.org.id, issue.id)).toEqual(at);
    const [channel] = await f.db.select().from(schema.channels).where(eq(schema.channels.id, at.channelId));
    expect(channel).toMatchObject({ kind: "task", visibility: "private" });

    // The chat's own send, in the thread: the mention admits the agent (it sees the task) and starts its run.
    const asked = await postPersonMessage(deps, f.owner.id, f.org.id, at.channelId, {
      body: "@dev quantas clínicas já usam WhatsApp?",
      threadId: at.rootId,
    });
    expect(asked.mentionedAgentIds).toEqual([f.agent.id]);
    const [run] = await f.db.select().from(schema.agentRuns);
    expect(run).toMatchObject({ agentId: f.agent.id, channelId: at.channelId, threadRootId: at.rootId });
    await drainOutbox(f.db, f.handlers);
    const replies = await repliesIn(at.channelId);
    expect(replies.map((m) => [m.authorType, m.body])).toEqual([
      ["person", "@dev quantas clínicas já usam WhatsApp?"],
      ["agent", "Olhei: 18 das 31 usam WhatsApp."],
    ]);
    // The run knew it was in the task's conversation.
    expect(JSON.stringify(f.provider.calls.at(-1)?.request.system)).toContain("This conversation: task #1");

    // The card reads it in the board's one query: count, who, nobody at work now.
    const [card] = await listIssues(f.db, person(f.owner.id), f.org.id);
    expect(card?.conversation).toMatchObject({ channelId: at.channelId, rootId: at.rootId, count: 2, working: false });
    expect(card?.conversation?.participants).toEqual([
      { type: "person", id: f.owner.id },
      { type: "agent", id: f.agent.id },
    ]);
  });

  test("a comment (the old box, the agent's tool) is a reply in it; never an activity row", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Frete lento" });
    await commentIssue(deps, person(f.owner.id), f.org.id, issue.id, "Começo amanhã.");
    const agent = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
    await commentIssue(deps, agent, f.org.id, issue.id, "Reproduzi.");
    const at = (await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id })).conversation;
    if (!at) throw new Error("no conversation");
    expect((await repliesIn(at.channelId)).map((m) => [m.authorType, m.body])).toEqual([
      ["person", "Começo amanhã."],
      ["agent", "Reproduzi."],
    ]);
    expect(at.count).toBe(2);
    const activity = await listIssueActivity(f.db, person(f.owner.id), f.org.id, issue.id);
    expect(activity.map((a) => a.kind)).toEqual(["event"]);
  });

  test("read by whoever sees the task: a private channel's task stays its members'; agents join only seeing it", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secreto", visibility: "private" });
    const said = await postPersonMessage(deps, f.owner.id, f.org.id, secret.id, { body: "Checkout quebra" });
    const issue = await issueFromMessage(deps, f.owner.id, f.org.id, said.id);
    const at = await openTaskConversation(f.db, person(f.owner.id), f.org.id, issue.id);

    // Bia isn't in #secreto: no task, no conversation, by any way in.
    await expect(openTaskConversation(f.db, person(bia.id), f.org.id, issue.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(requireChannelAccess(f.db, bia.id, f.org.id, at.channelId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      postPersonMessage(deps, bia.id, f.org.id, at.channelId, { body: "oi", threadId: at.rootId }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // In #secreto now: she reads it, without being a member of the conversation itself.
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { userId: bia.id });
    expect((await requireChannelAccess(f.db, bia.id, f.org.id, at.channelId)).channel.id).toBe(at.channelId);
    const members = await f.db
      .select()
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.channelId, at.channelId));
    expect(members.filter((m) => m.userId)).toEqual([]);

    // An agent outside #secreto mentioned there doesn't join (and starts nothing); one inside does.
    const qa = await createAgent(f.db, f.owner.id, f.org.id, { name: "QA", handle: "qa" }, NEW_AGENT_DEFAULTS);
    await postPersonMessage(deps, f.owner.id, f.org.id, at.channelId, { body: "@qa olha", threadId: at.rootId });
    expect(await f.db.select().from(schema.agentRuns)).toEqual([]);
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: qa.id });
    await postPersonMessage(deps, f.owner.id, f.org.id, at.channelId, { body: "@qa e agora?", threadId: at.rootId });
    expect((await f.db.select().from(schema.agentRuns)).map((r) => [r.agentId, r.channelId])).toEqual([
      [qa.id, at.channelId],
    ]);
  });

  test("old comments move in once: their ids, times, authors and files; the events stay as the history", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Exportar CSV" });
    const [file] = await f.db
      .insert(schema.artifacts)
      .values({
        orgId: f.org.id,
        kind: "file",
        title: "print.png",
        createdByType: "person",
        createdById: f.owner.id,
        updatedByType: "person",
        updatedById: f.owner.id,
      })
      .returning();
    const old = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    const comments = [
      { authorType: "person", authorId: f.owner.id, text: "Vejam o print", at: old(30), files: [file?.id ?? ""] },
      { authorType: "agent", authorId: f.agent.id, text: "Vou olhar.", at: old(20), files: [] },
      // Someone who left: the text and the time stay, with no author.
      { authorType: "person", authorId: "gone-user", text: "Urgente", at: old(10), files: [] },
    ];
    const rows = await f.db
      .insert(schema.issueActivity)
      .values(
        comments.map((c) => ({
          orgId: f.org.id,
          issueId: issue.id,
          kind: "comment",
          authorType: c.authorType,
          authorId: c.authorId,
          text: c.text,
          createdAt: c.at,
          data: c.files.length ? { attachments: c.files.map((id) => ({ id, title: "print.png" })) } : {},
        })),
      )
      .returning();

    expect(await moveIssueComments(f.db)).toBe(1);
    expect(await moveIssueComments(f.db)).toBe(0);
    const at = (await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id })).conversation;
    if (!at) throw new Error("no conversation");
    const moved = await repliesIn(at.channelId);
    const same = (i: number) => [rows[i]?.id ?? "", comments[i]?.at.getTime() ?? 0];
    expect(moved.map((m) => [m.id, m.createdAt.getTime(), m.authorUserId, m.authorAgentId, m.body])).toEqual([
      [...same(0), f.owner.id, null, "Vejam o print"],
      [...same(1), null, f.agent.id, "Vou olhar."],
      [...same(2), null, null, "Urgente"],
    ]);
    expect(moved[0]?.meta).toMatchObject({ movedFromIssue: true, artifacts: [{ id: file?.id, title: "print.png" }] });
    expect(moved.every((m) => m.threadId === at.rootId)).toBe(true);
    expect(at.count).toBe(3);
    // The old comments left the activity; "created" is still there.
    expect((await listIssueActivity(f.db, person(f.owner.id), f.org.id, issue.id)).map((a) => a.event)).toEqual([
      "created",
    ]);
    // Moved quietly: nobody hears about old comments again.
    await drainOutbox(f.db, f.handlers);
    expect(await f.db.select().from(schema.notifications)).toEqual([]);
  });

  test("a reply there reaches the task's followers like a comment did, opening the task at that message", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const issue = await createIssue(deps, person(bia.id), f.org.id, { title: "Exportar CSV" });
    const at = await openTaskConversation(f.db, person(f.owner.id), f.org.id, issue.id);
    const reply = await postPersonMessage(deps, f.owner.id, f.org.id, at.channelId, {
      body: "Feito o rascunho",
      threadId: at.rootId,
    });
    await drainOutbox(f.db, f.handlers);
    const [n] = await f.db.select().from(schema.notifications).where(eq(schema.notifications.userId, bia.id));
    expect(n).toMatchObject({ kind: "issue_comment" });
    expect(n?.source).toMatchObject({ issueId: issue.id, issueNumber: issue.number, messageId: reply.id });
  });
});
