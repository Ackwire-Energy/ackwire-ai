import { describe, expect, test } from "bun:test";
import type { AppNotification, NotificationPage } from "@agenteschat/client";
import {
  dayGroupOf,
  groupByDay,
  isExpandable,
  matchesFilter,
  type NotificationPages,
  opensOnComputer,
  openTarget,
  removeFromPages,
  replyTarget,
  snoozeTimes,
  sortWaiting,
  stepCells,
  upsertInPages,
} from "@agenteschat/client/lib/notifications";
import { notification } from "./fakes/notifications";

const NOW = new Date(2026, 9, 16, 15, 30); // Friday 15:30, local time
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

const page = (items: AppNotification[], counts: Partial<NotificationPage["counts"]> = {}): NotificationPages => ({
  pages: [
    {
      items,
      counts: { all: items.length, mentions: 0, waiting: 0, unread: 0, reactions: 0, ...counts },
      nextCursor: null,
    },
  ],
  pageParams: [""],
});

describe("filters", () => {
  test("mentions are mentions, DMs and agents' questions; done and snoozed ones are hidden everywhere", () => {
    const now = NOW.getTime();
    expect(matchesFilter(notification({ id: "a", kind: "dm" }), "mentions", now)).toBe(true);
    expect(matchesFilter(notification({ id: "b", kind: "agent_question" }), "mentions", now)).toBe(true);
    expect(matchesFilter(notification({ id: "c", kind: "thread_reply" }), "mentions", now)).toBe(false);
    expect(matchesFilter(notification({ id: "d", kind: "reaction" }), "reactions", now)).toBe(true);
    expect(matchesFilter(notification({ id: "e", kind: "mention", readAt: at(1) }), "unread", now)).toBe(false);
    expect(matchesFilter(notification({ id: "f", kind: "mention", doneAt: at(1) }), "all", now)).toBe(false);
    const snoozed = notification({ id: "g", kind: "mention", snoozedUntil: at(-60) });
    expect(matchesFilter(snoozed, "all", now)).toBe(false);
    // Back once the time passes.
    expect(matchesFilter(snoozed, "all", now + 2 * 3_600_000)).toBe(true);
  });
});

describe("live changes on a loaded list", () => {
  const a = notification({ id: "a", kind: "mention", updatedAt: at(30) });
  const b = notification({ id: "b", kind: "dm", updatedAt: at(10), readAt: at(5) });

  test("a new one lands in order (waiting first, then newest) and the counts move", () => {
    const data = page([b, a], { all: 2, mentions: 2, unread: 1 });
    const w = notification({ id: "w", kind: "approval", waiting: true, updatedAt: at(600) });
    const next = upsertInPages(data, "all", w, undefined, NOW.getTime());
    expect(next.pages[0]?.items.map((n) => n.id)).toEqual(["w", "b", "a"]);
    expect(next.pages[0]?.counts).toMatchObject({ all: 3, waiting: 1, unread: 2, mentions: 2 });
  });

  test("done leaves the list and every count it was in; read only moves unread", () => {
    const data = page([b, a], { all: 2, mentions: 2, unread: 1 });
    const done = upsertInPages(data, "all", { ...a, doneAt: at(0) }, undefined, NOW.getTime());
    expect(done.pages[0]?.items.map((n) => n.id)).toEqual(["b"]);
    expect(done.pages[0]?.counts).toMatchObject({ all: 1, mentions: 1, unread: 0 });
    const read = upsertInPages(data, "all", { ...a, readAt: at(0) }, undefined, NOW.getTime());
    expect(read.pages[0]?.items.map((n) => n.id)).toEqual(["b", "a"]);
    expect(read.pages[0]?.counts).toMatchObject({ all: 2, unread: 0 });
    // The unread list drops it.
    const unreadList = upsertInPages(page([a], { all: 2, unread: 1 }), "unread", { ...a, readAt: at(0) });
    expect(unreadList.pages[0]?.items).toEqual([]);
  });

  test("Concluídas: done joins it, the latest done first; Mover de volta takes it out; the counts stay the inbox's", () => {
    const old = notification({ id: "old", kind: "mention", doneAt: at(60) });
    const data = page([old], { all: 3, mentions: 3 });
    const done = upsertInPages(data, "done", { ...a, doneAt: at(0) }, a, NOW.getTime());
    expect(done.pages[0]?.items.map((n) => n.id)).toEqual(["a", "old"]);
    expect(done.pages[0]?.counts).toMatchObject({ all: 2, mentions: 2 });
    const back = upsertInPages(done, "done", { ...old, doneAt: null }, undefined, NOW.getTime());
    expect(back.pages[0]?.items.map((n) => n.id)).toEqual(["a"]);
    expect(
      groupByDay([old, { ...a, doneAt: at(0) }], NOW, (n) => n.doneAt ?? "").map(([, l]) => l.map((n) => n.id)),
    ).toEqual([["a", "old"]]);
  });

  test("removed (auto-resolved) goes away with its counts", () => {
    const data = page([b, a], { all: 2, mentions: 2, unread: 1 });
    const next = removeFromPages(data, "a", undefined, NOW.getTime());
    expect(next.pages[0]?.items.map((n) => n.id)).toEqual(["b"]);
    expect(next.pages[0]?.counts).toMatchObject({ all: 1, mentions: 1, unread: 0 });
  });
});

describe("grouping and order", () => {
  test("Hoje, Ontem, Esta semana, Mais antigas by the last update in local time", () => {
    expect(dayGroupOf(at(10), NOW)).toBe("today");
    expect(dayGroupOf(new Date(2026, 9, 15, 23, 59).toISOString(), NOW)).toBe("yesterday");
    expect(dayGroupOf(new Date(2026, 9, 11, 9).toISOString(), NOW)).toBe("week");
    expect(dayGroupOf(new Date(2026, 9, 9, 9).toISOString(), NOW)).toBe("older");
    const groups = groupByDay(
      [
        notification({ id: "old", kind: "mention", updatedAt: new Date(2026, 8, 1).toISOString() }),
        notification({ id: "now", kind: "mention", updatedAt: at(1) }),
      ],
      NOW,
    );
    expect(groups.map(([g, l]) => [g, l.map((n) => n.id)])).toEqual([
      ["today", ["now"]],
      ["older", ["old"]],
    ]);
  });

  test("waiting: an agent's question, then my turn at the table, then an approval", () => {
    const list = sortWaiting([
      notification({ id: "ap", kind: "approval", waiting: true }),
      notification({ id: "f", kind: "forum_turn", waiting: true }),
      notification({ id: "q", kind: "agent_question", waiting: true }),
    ]);
    expect(list.map((n) => n.id)).toEqual(["q", "f", "ap"]);
  });

  test("a thread with several replies (or an issue with several comments) expands", () => {
    expect(
      isExpandable(
        notification({ id: "t", kind: "thread_reply", count: 3, source: { channelId: "c", threadId: "r" } }),
      ),
    ).toBe(true);
    expect(isExpandable(notification({ id: "t", kind: "thread_reply", count: 1, source: { threadId: "r" } }))).toBe(
      false,
    );
    expect(isExpandable(notification({ id: "i", kind: "issue_comment", count: 2, source: { issueId: "i1" } }))).toBe(
      true,
    );
  });
});

describe("answering and opening", () => {
  test("reply goes through the endpoint of the source", () => {
    expect(replyTarget(notification({ id: "1", kind: "agent_question", source: { questionId: "q" } }))).toEqual({
      kind: "question",
      questionId: "q",
    });
    expect(replyTarget(notification({ id: "2", kind: "forum_turn", source: { topicId: "t" } }))).toEqual({
      kind: "forum",
      topicId: "t",
    });
    expect(replyTarget(notification({ id: "3", kind: "issue_comment", source: { issueId: "i" } }))).toEqual({
      kind: "issue",
      issueId: "i",
    });
    expect(replyTarget(notification({ id: "4", kind: "dm", source: { dmId: "d" } }))).toEqual({
      kind: "message",
      channelId: "d",
      threadId: null,
    });
    expect(replyTarget(notification({ id: "5", kind: "mention", source: { channelId: "c", threadId: "r" } }))).toEqual({
      kind: "message",
      channelId: "c",
      threadId: "r",
    });
    expect(replyTarget(notification({ id: "6", kind: "approval", source: { approvalId: "a" } }))).toBeNull();
    expect(replyTarget(notification({ id: "7", kind: "reaction", source: { channelId: "c" } }))).toBeNull();
  });

  test("Abrir: the thread, the message in its channel, the DM, the issue, the topic, Aprovações", () => {
    expect(
      openTarget(notification({ id: "1", kind: "thread_reply", source: { channelId: "c", threadId: "r" } })),
    ).toEqual({ to: "/org/$orgId/threads/$threadId", params: { threadId: "r" } });
    expect(openTarget(notification({ id: "2", kind: "mention", source: { channelId: "c", messageId: "m" } }))).toEqual({
      to: "/org/$orgId/c/$channelId",
      params: { channelId: "c" },
      search: { m: "m" },
    });
    expect(
      openTarget(notification({ id: "3", kind: "dm", actors: [{ type: "agent", id: "ada" }], source: { dmId: "d" } })),
    ).toEqual({ to: "/org/$orgId/dm/agent/$agentId", params: { agentId: "ada" } });
    // An agent's request in my DM with it: that DM (the web has no channel page for a DM).
    const asked = notification({
      id: "3h",
      kind: "browser_handoff",
      actors: [{ type: "agent", id: "ada" }],
      source: { channelId: "d", dmId: "d", messageId: "h", handoffId: "h", agentId: "ada" },
    });
    expect(openTarget(asked)).toEqual({ to: "/org/$orgId/dm/agent/$agentId", params: { agentId: "ada" } });
    expect(opensOnComputer(asked)).toBeNull();
    // One whose conversation I can't open names none: it opens on the agent's computer.
    expect(opensOnComputer({ ...asked, source: { handoffId: "h", agentId: "ada" } })).toBe("ada");
    expect(openTarget(notification({ id: "4", kind: "issue_assigned", source: { issueNumber: 131 } }))).toEqual({
      to: "/org/$orgId/issues/$number",
      params: { number: "131" },
    });
    expect(openTarget(notification({ id: "5", kind: "forum_turn", source: { topicId: "t" } }))).toEqual({
      to: "/org/$orgId/forum/$topicId",
      params: { topicId: "t" },
    });
    expect(openTarget(notification({ id: "6", kind: "approval", source: { approvalId: "a" } }))).toEqual({
      to: "/org/$orgId/approvals",
    });
  });
});

describe("pieces", () => {
  test("steps: done, the one it stopped at, the rest to do", () => {
    expect(stepCells({ done: 3, total: 5, failedAt: 4 })).toEqual(["done", "done", "done", "stopped", "todo"]);
    expect(stepCells({ done: 4, total: 4 })).toEqual(["done", "done", "done", "done"]);
  });

  test("Lembrar depois: in 1 hour, tomorrow at 9, next Monday at 9 (local time)", () => {
    const friday = snoozeTimes(NOW);
    expect(friday.hour.getTime() - NOW.getTime()).toBe(3_600_000);
    expect([friday.tomorrow.getDay(), friday.tomorrow.getHours(), friday.tomorrow.getMinutes()]).toEqual([6, 9, 0]);
    expect([friday.nextWeek.getDay(), friday.nextWeek.getDate(), friday.nextWeek.getHours()]).toEqual([1, 19, 9]);
    // From a Monday, the Monday after.
    const monday = snoozeTimes(new Date(2026, 9, 19, 8, 0));
    expect([monday.nextWeek.getDay(), monday.nextWeek.getDate()]).toEqual([1, 26]);
  });
});
