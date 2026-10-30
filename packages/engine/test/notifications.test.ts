import { afterEach, expect, test } from "bun:test";
import { type RealtimeEvent, userTopic } from "@agenteschat/adapters";
import { and, eq, schema } from "@agenteschat/db";
import {
  addAgentReaction,
  addChannelMember,
  addReaction,
  commentIssue,
  createIssue,
  drainOutbox,
  listMembers,
  listNotifications,
  markAllNotificationsRead,
  markChannelRead,
  markNotificationDone,
  markNotificationRead,
  NotFoundError,
  notificationCounts,
  notificationSnippet,
  notify,
  openDm,
  postPersonMessage,
  resolveNotifications,
  setNoticePref,
  snoozeNotification,
  updateIssue,
  ValidationError,
  wakeSnoozedNotifications,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });

/** Two more people in #general, with handles (`@bia`, `@caio`). */
async function people() {
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const caio = await addMember(f.db, f.org.id, "member", "caio");
  await listMembers(f.db, f.org.id); // assigns their handles
  for (const u of [bia, caio]) await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: u.id });
  return { bia, caio };
}

const post = async (userId: string, body: string, threadId?: string, channelId = f.general.id) => {
  const m = await postPersonMessage(deps(), userId, f.org.id, channelId, { body, threadId });
  await drainOutbox(f.db, f.handlers);
  return m;
};

const inbox = (userId: string, filter?: "all" | "mentions" | "waiting" | "unread" | "reactions") =>
  listNotifications(deps(), userId, f.org.id, { filter });

const hear = (userId: string) => {
  const events: RealtimeEvent[] = [];
  f.pubsub.subscribe(userTopic(f.org.id, userId), (e) => events.push(e));
  return events;
};

test("thread replies merge into one unread row per thread; reading it starts a new one", async () => {
  f = await setup();
  const { bia, caio } = await people();
  const root = await post(f.owner.id, "Release 2.4.1 checklist");
  await post(bia.id, "Build is green", root.id);
  await post(caio.id, "**Smoke** tests pass", root.id);

  const { items } = await inbox(f.owner.id);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    kind: "thread_reply",
    waiting: false,
    count: 2,
    actors: [
      { type: "user", id: caio.id },
      { type: "user", id: bia.id },
    ],
    source: { channelId: f.general.id, threadId: root.id, label: "Release 2.4.1 checklist" },
    latest: { text: "Smoke tests pass" },
    readAt: null,
  });
  // Bia wrote in the thread: she hears Caio's reply, not her own.
  expect((await inbox(bia.id)).items.map((n) => [n.kind, n.count])).toEqual([["thread_reply", 1]]);
  // Nobody is notified of their own reply.
  expect((await inbox(caio.id)).items).toEqual([]);

  await markNotificationRead(deps(), f.owner.id, f.org.id, items[0]?.id ?? "", true);
  await post(bia.id, "Tagging the release", root.id);
  const after = await inbox(f.owner.id);
  expect(after.items.map((n) => [n.kind, n.count, n.readAt === null])).toEqual([
    ["thread_reply", 1, true],
    ["thread_reply", 2, false],
  ]);
});

test("mentions, DMs, filters and counts; the actor never hears their own action", async () => {
  f = await setup();
  const { bia } = await people();
  await post(f.owner.id, "@bia can you check this? @ana too");
  const dm = await openDm(f.db, f.owner.id, f.org.id, { userId: bia.id });
  await post(f.owner.id, "Te mandei o contrato", undefined, dm.id);

  const all = await inbox(bia.id);
  expect(all.items.map((n) => n.kind).sort()).toEqual(["dm", "mention"]);
  expect(all.items.find((n) => n.kind === "dm")).toMatchObject({
    actors: [{ type: "user", id: f.owner.id }],
    source: { dmId: dm.id, channelId: dm.id },
    latest: { text: "Te mandei o contrato" },
  });
  expect(all.items.find((n) => n.kind === "mention")?.source.label).toBe("general");
  expect(all.counts).toEqual({ all: 2, mentions: 2, waiting: 0, unread: 2, reactions: 0 });
  expect((await inbox(bia.id, "reactions")).items).toEqual([]);
  // "@ana" is the author herself.
  expect((await inbox(f.owner.id)).items).toEqual([]);
  expect(await notificationCounts(deps(), bia.id, f.org.id)).toEqual({ unread: 2, waiting: 0 });
});

test("an agent's answer reaches the person who asked, merged per conversation; reading it there resolves it", async () => {
  f = await setup();
  const dm = await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id });
  await post(f.owner.id, "Faz o relatório?", undefined, dm.id);

  const first = await inbox(f.owner.id);
  expect(first.items.map((n) => [n.kind, n.count])).toEqual([["agent_reply", 1]]);
  expect(first.items[0]).toMatchObject({
    actors: [{ type: "agent", id: f.agent.id }],
    source: { dmId: dm.id, channelId: dm.id },
  });
  expect(first.counts.mentions).toBe(1);

  // A second answer while the first is unread merges into it (and pushes nothing new: only count 1 does).
  await post(f.owner.id, "E o gráfico?", undefined, dm.id);
  expect((await inbox(f.owner.id)).items.map((n) => [n.kind, n.count])).toEqual([["agent_reply", 2]]);

  // Read in the conversation: it leaves the inbox.
  await markChannelRead(f.db, f.owner.id, f.org.id, dm.id, new Date(), f.pubsub);
  expect((await inbox(f.owner.id)).items).toEqual([]);
});

test("the realtime event says whether it reaches the person's devices, by their choices", async () => {
  f = await setup();
  const { bia } = await people();
  const events = hear(bia.id);
  await post(f.owner.id, "@bia olha isso");
  await setNoticePref(f.db, f.org.id, bia.id, "mentions", false);
  await post(f.owner.id, "@bia e isso");
  const alerts = events.filter((e) => e.type === "notification.upserted").map((e) => e.alert);
  expect(alerts).toEqual([true, false]);
});

test("reactions to my message merge (also within 30 min after reading); my own reactions don't count", async () => {
  f = await setup();
  const { bia, caio } = await people();
  const mine = await post(f.owner.id, "Shipped the new onboarding");
  await addReaction(f.db, f.owner.id, f.org.id, mine.id, "🎉", f.pubsub);
  expect((await inbox(f.owner.id)).items).toEqual([]);
  await addReaction(f.db, bia.id, f.org.id, mine.id, "+1", f.pubsub);
  await addReaction(f.db, caio.id, f.org.id, mine.id, "🎉", f.pubsub);
  let [n] = (await inbox(f.owner.id, "reactions")).items;
  expect(n).toMatchObject({
    kind: "reaction",
    count: 2,
    actors: [
      { type: "user", id: caio.id },
      { type: "user", id: bia.id },
    ],
    latest: { emojis: ["👍", "🎉"], quote: "Shipped the new onboarding" },
  });
  await markNotificationRead(deps(), f.owner.id, f.org.id, n?.id ?? "", true);
  await addReaction(f.db, caio.id, f.org.id, mine.id, "🚀", f.pubsub);
  const list = (await inbox(f.owner.id, "reactions")).items;
  expect(list).toHaveLength(1);
  n = list[0];
  expect(n).toMatchObject({ count: 3, readAt: null });
  expect(n?.latest.emojis).toContain("🚀");

  // An agent's reaction (the `react` tool) reaches the author too, with the agent as actor.
  await addAgentReaction(f.db, { orgId: f.org.id, agentId: f.agent.id, messageId: mine.id, reaction: "🙌" }, f.pubsub);
  const [after] = (await inbox(f.owner.id, "reactions")).items;
  expect(after).toMatchObject({ count: 4 });
  expect(after?.actors[0]).toEqual({ type: "agent", id: f.agent.id });
  expect(after?.latest.emojis).toContain("🙌");
});

test("one-off notifications are idempotent; done, undo, read-all and the cursor", async () => {
  f = await setup();
  const { bia } = await people();
  const base = Date.now() - 60_000;
  for (let i = 0; i < 5; i++) {
    // One second apart: the order is by time.
    await notify(
      { ...deps(), now: () => new Date(base + i * 1000) },
      {
        orgId: f.org.id,
        userIds: [bia.id],
        kind: "mention",
        groupKey: `mention:test-${i}`,
        actor: { type: "agent", id: f.agent.id },
        source: { channelId: f.general.id },
        latest: { text: `n${i}` },
      },
    );
  }
  // The same key again (a retried job) changes nothing.
  await notify(deps(), {
    orgId: f.org.id,
    userIds: [bia.id],
    kind: "mention",
    groupKey: "mention:test-0",
    source: {},
  });
  // An approval waits: it comes first.
  await notify(deps(), {
    orgId: f.org.id,
    userIds: [bia.id, f.agent.id],
    kind: "approval",
    groupKey: "approval:test",
    waiting: true,
    actor: { type: "agent", id: f.agent.id },
    source: {},
  });
  expect(await f.db.select().from(schema.notifications)).toHaveLength(6); // never for an agent id

  const page1 = await listNotifications(deps(), bia.id, f.org.id, { limit: 4 });
  expect(page1.items.map((n) => n.latest.text ?? n.kind)).toEqual(["approval", "n4", "n3", "n2"]);
  expect(page1.counts).toMatchObject({ all: 6, waiting: 1, unread: 6 });
  const page2 = await listNotifications(deps(), bia.id, f.org.id, { limit: 4, cursor: page1.nextCursor });
  expect(page2.items.map((n) => n.latest.text)).toEqual(["n1", "n0"]);
  expect(page2.nextCursor).toBeNull();
  await expect(listNotifications(deps(), bia.id, f.org.id, { cursor: "nope" })).rejects.toBeInstanceOf(ValidationError);

  const target = page2.items[0]?.id ?? "";
  expect((await markNotificationDone(deps(), bia.id, f.org.id, target, true)).doneAt).not.toBeNull();
  expect((await inbox(bia.id)).counts.all).toBe(5);
  await markNotificationDone(deps(), bia.id, f.org.id, target, false);
  expect((await inbox(bia.id)).counts.all).toBe(6);

  const { ids } = await markAllNotificationsRead(deps(), bia.id, f.org.id, "mentions");
  expect(ids).toHaveLength(5);
  expect((await inbox(bia.id)).counts).toMatchObject({ unread: 1, waiting: 1 });

  // Someone else's notification is not found.
  await expect(markNotificationRead(deps(), f.owner.id, f.org.id, target, true)).rejects.toBeInstanceOf(NotFoundError);
});

test("a merged request-to-join notice keeps the first two names, each once, and counts every ask", async () => {
  f = await setup();
  for (const name of ["Ana Souza", "Ana Souza", "Bruno Lima", "Carla Dias"])
    await notify(deps(), {
      orgId: f.org.id,
      userIds: [f.owner.id],
      kind: "join_request",
      groupKey: `join_requests:${f.org.id}`,
      waiting: true,
      source: { label: "Acme" },
      latest: { title: name, names: [name] },
    });
  const [row] = (await inbox(f.owner.id)).items;
  expect([row?.count, row?.latest]).toEqual([4, { title: "Carla Dias", names: ["Ana Souza", "Bruno Lima"] }]);
});

test("snoozed notifications leave the inbox and come back on top when their time comes", async () => {
  f = await setup();
  const { bia } = await people();
  const [first] = await notify(deps(), {
    orgId: f.org.id,
    userIds: [bia.id],
    kind: "dm",
    groupKey: "dm:a",
    source: {},
  });
  await notify(deps(), { orgId: f.org.id, userIds: [bia.id], kind: "dm", groupKey: "dm:b", source: {} });
  await expect(snoozeNotification(deps(), bia.id, f.org.id, first?.id ?? "", new Date(0))).rejects.toBeInstanceOf(
    ValidationError,
  );
  const events = hear(bia.id);
  const until = new Date(Date.now() + 3600_000);
  await snoozeNotification(deps(), bia.id, f.org.id, first?.id ?? "", until);
  expect(events.map((e) => e.type)).toEqual(["notification.removed", "notification.counts"]);
  expect((await inbox(bia.id)).items).toHaveLength(1);
  expect((await inbox(bia.id)).counts.all).toBe(1);

  // Undo: back now, with `upserted` and the counts.
  const undone = await snoozeNotification(deps(), bia.id, f.org.id, first?.id ?? "", null);
  expect(undone.snoozedUntil).toBeNull();
  expect(events.map((e) => e.type).slice(2)).toEqual(["notification.upserted", "notification.counts"]);
  expect((await inbox(bia.id)).counts.all).toBe(2);
  await snoozeNotification(deps(), bia.id, f.org.id, first?.id ?? "", until);

  expect(await wakeSnoozedNotifications(deps())).toBe(0); // not yet
  expect(await wakeSnoozedNotifications({ ...deps(), now: () => new Date(until.getTime() + 1000) })).toBe(1);
  const back = await inbox(bia.id);
  expect(back.items.map((n) => n.id)[0]).toBe(first?.id);
  expect(back.items[0]?.snoozedUntil).toBeNull();
  expect(events.map((e) => e.type)).toContain("notification.upserted");
});

test("realtime goes to the recipient only; auto-resolve removes for everyone", async () => {
  f = await setup();
  const { bia, caio } = await people();
  const biaEvents = hear(bia.id);
  const caioEvents = hear(caio.id);
  const ownerEvents = hear(f.owner.id);
  await notify(deps(), {
    orgId: f.org.id,
    userIds: [bia.id, f.owner.id],
    kind: "forum_turn",
    groupKey: "forum_turn:topic-1:2",
    waiting: true,
    actor: { type: "user", id: f.owner.id },
    source: { topicId: "topic-1" },
    latest: { round: 2, rounds: 3 },
  });
  expect(biaEvents.map((e) => e.type)).toEqual(["notification.upserted", "notification.counts"]);
  expect(biaEvents[1]).toMatchObject({ unread: 1, waiting: 1 });
  expect(caioEvents).toEqual([]);
  expect(ownerEvents).toEqual([]); // the actor

  expect(await resolveNotifications(deps(), f.org.id, { groupKeyPrefix: "forum_turn:topic-1:" })).toBe(1);
  expect(biaEvents.map((e) => e.type).slice(2)).toEqual(["notification.removed", "notification.counts"]);
  expect((await inbox(bia.id)).items).toEqual([]);
  // Another group with the same start is untouched.
  expect(await resolveNotifications(deps(), f.org.id, { groupKeyPrefix: "forum_turn:topic-12:" })).toBe(0);
});

test("issues: assigned (resolved when unassigned), status by others, comments merge, mentions in comments", async () => {
  f = await setup();
  const { bia, caio } = await people();
  const owner = { type: "person" as const, userId: f.owner.id };
  const issue = await createIssue(deps(), owner, f.org.id, {
    title: "Export report as CSV",
    assignee: { type: "person", id: bia.id },
  });
  const [assigned] = (await inbox(bia.id)).items;
  expect(assigned).toMatchObject({
    kind: "issue_assigned",
    source: { issueId: issue.id, issueNumber: issue.number, label: "Export report as CSV" },
  });

  // An agent moves it: the people who follow it hear (author and assignee).
  const agentActor = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
  await updateIssue(deps(), agentActor, f.org.id, issue.id, { status: "in_review" });
  const status = (await inbox(f.owner.id)).items.find((n) => n.kind === "issue_status");
  expect(status).toMatchObject({
    actors: [{ type: "agent", id: f.agent.id }],
    latest: { statusFrom: "todo", statusTo: "in_review" },
  });

  // Comments: followers merge per issue; a mention is its own `mention`.
  await commentIssue(deps(), { type: "person", userId: caio.id }, f.org.id, issue.id, "Looks good");
  await commentIssue(deps(), agentActor, f.org.id, issue.id, "PR opened");
  await commentIssue(deps(), owner, f.org.id, issue.id, "@caio can you review?");
  const ownerComments = (await inbox(f.owner.id)).items.find((n) => n.kind === "issue_comment");
  expect(ownerComments).toMatchObject({ count: 2, latest: { text: "PR opened" } });
  const caioInbox = await inbox(caio.id);
  expect(caioInbox.items.find((n) => n.kind === "mention")).toMatchObject({
    source: { issueId: issue.id },
    latest: { text: "@caio can you review?" },
  });
  expect(caioInbox.items.find((n) => n.kind === "issue_comment")?.count).toBe(1); // the agent's, not the mention

  // Unassigned: "assigned to you" leaves Bia's inbox.
  await updateIssue(deps(), owner, f.org.id, issue.id, { assignee: null });
  const [row] = await f.db
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, bia.id), eq(schema.notifications.kind, "issue_assigned")));
  expect(row?.doneAt).not.toBeNull();
});

test("snippets are plain text and at most 280 characters", () => {
  expect(notificationSnippet("**Bold** and [a link](https://x.y) in `code`\n\n```ts\nconst a = 1\n```")).toBe(
    "Bold and a link in code const a = 1",
  );
  const long = notificationSnippet("x".repeat(500));
  expect(long).toHaveLength(280);
  expect(long.endsWith("…")).toBe(true);
});
