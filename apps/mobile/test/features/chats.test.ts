import { describe, expect, test } from "bun:test";
import type { Channel, DirectMessage } from "@agenteschat/client";
import {
  buildConversations,
  CHAT_FILTERS,
  filterConversations,
  filterCounts,
  isListedThread,
  missionsWaiting,
  missionWaitingItems,
  openQuestions,
  unreadConversationCount,
  unreadConversations,
  waitingTotal,
} from "../../src/features/chats/logic";
import { at, thread } from "./fixtures";

const channel = (id: string, name: string, isMember = true, over: Partial<Channel> = {}): Channel => ({
  id,
  name,
  topic: "",
  visibility: "public",
  isMember,
  createdAt: at(1000),
  ...over,
});

const dm = (channelId: string, name: string, unread: number, minutesAgo: number | null): DirectMessage => ({
  channelId,
  with: { type: "agent", id: `a-${name}`, name, handle: name.toLowerCase() },
  lastMessage:
    minutesAgo === null
      ? null
      : { id: `m-${channelId}`, body: "**Feito!** Já anotei.", createdAt: at(minutesAgo), authorType: "agent" },
  unread,
});

describe("which threads are conversations of their own", () => {
  test("a mission, a titled thread, or two people talking", () => {
    expect(
      isListedThread(
        thread({
          id: "t",
          mission: { id: "m", agentId: "a", status: "active", planDone: 1, planTotal: 3, waitingYou: 0 },
        }),
      ),
    ).toBe(true);
    expect(isListedThread(thread({ id: "t", title: "Erro no login" }))).toBe(true);
    expect(
      isListedThread(
        thread({
          id: "t",
          participants: [
            { type: "person", id: "u1" },
            { type: "person", id: "u2" },
          ],
        }),
      ),
    ).toBe(true);
  });
  test("an agent answering one person is not a thread to list; archived ones never are", () => {
    expect(
      isListedThread(
        thread({
          id: "t",
          participants: [
            { type: "person", id: "u1" },
            { type: "agent", id: "a1" },
          ],
        }),
      ),
    ).toBe(false);
    expect(isListedThread(thread({ id: "t", title: "x", state: "archived" }))).toBe(false);
  });
});

describe("the list", () => {
  const rows = buildConversations({
    channels: [channel("c2", "marketing"), channel("c1", "geral"), channel("c3", "secreto", false)],
    dms: [dm("d1", "Dev", 0, 60), dm("d2", "Ana", 2, 5)],
    threads: [
      thread({ id: "t1", title: "Erro no login", lastActivityAt: at(30) }),
      thread({ id: "t2", lastActivityAt: at(1) }),
    ],
  });

  test("newest activity first, channels without activity last by name, not-joined channels left out", () => {
    expect(rows.map((r) => r.key)).toEqual(["d:d2", "t:t1", "d:d1", "c:c1", "c:c2"]);
  });

  test("previews drop Markdown marks", () => {
    const dev = rows.find((r) => r.key === "d:d1");
    expect(dev?.kind === "dm" ? dev.last?.text : null).toBe("Feito! Já anotei.");
  });

  test("filters and counts", () => {
    expect(filterConversations(rows, "unread").map((r) => r.key)).toEqual(["d:d2"]);
    expect(filterConversations(rows, "threads").map((r) => r.key)).toEqual(["t:t1"]);
    expect(filterConversations(rows, "dm").map((r) => r.key)).toEqual(["d:d2", "d:d1"]);
    expect(filterConversations(rows, "all")).toHaveLength(5);
    expect(filterCounts(rows)).toEqual({ all: 5, unread: 1, threads: 1, dm: 2 });
    expect(unreadConversations(rows)).toBe(1);
  });
});

describe("channels with their last message and unread", () => {
  const rows = buildConversations({
    channels: [
      channel("c1", "geral", true, {
        unreadCount: 3,
        lastMessage: {
          id: "m1",
          authorType: "person",
          authorId: "u2",
          authorName: "Ana",
          preview: "**Subiu** a página nova",
          createdAt: at(2),
        },
      }),
      channel("c2", "marketing", true, { unreadCount: 0, lastMessage: null }),
      channel("c3", "secreto", false, { unreadCount: 7 }),
    ],
    dms: [dm("d1", "Dev", 1, 10), dm("d2", "Iris", 0, 20)],
    threads: [],
  });

  test("a channel sorts by its last message and says who wrote it", () => {
    expect(rows.map((r) => r.key)).toEqual(["c:c1", "d:d1", "d:d2", "c:c2"]);
    const geral = rows[0];
    expect(geral?.kind === "channel" ? geral.last : null).toEqual({
      author: { type: "person", id: "u2" },
      name: "Ana",
      text: "Subiu a página nova",
    });
    expect(geral?.unread).toBe(3);
  });

  test("Não lidas and the tab badge count channels and DMs with something unread", () => {
    expect(filterConversations(rows, "unread").map((r) => r.key)).toEqual(["c:c1", "d:d1"]);
    expect(filterCounts(rows).unread).toBe(2);
    expect(
      unreadConversationCount({
        channels: [
          channel("c1", "geral", true, { unreadCount: 3 }),
          channel("c2", "marketing", true),
          channel("c3", "secreto", false, { unreadCount: 7 }),
        ],
        dms: [dm("d1", "Dev", 1, 10), dm("d2", "Iris", 0, 20)],
      }),
    ).toBe(2);
  });

  test("after reading a channel its row has nothing unread", () => {
    const read = buildConversations({
      channels: [channel("c1", "geral", true, { unreadCount: 0 })],
      dms: [],
      threads: [],
    });
    expect(unreadConversations(read)).toBe(0);
  });
});

describe("agents at work in the list", () => {
  test("an agent DM says it is working when the agent has a run there; a person DM never does", () => {
    const person: DirectMessage = {
      ...dm("d3", "Ana", 0, 3),
      with: { type: "person", id: "u2", name: "Ana", handle: "ana" },
    };
    const rows = buildConversations({
      channels: [channel("c1", "geral")],
      dms: [dm("d1", "Dev", 0, 10), dm("d2", "Iris", 0, 20), person],
      threads: [],
      workingChannels: new Set(["d1", "d3", "c1"]),
    });
    const working = Object.fromEntries(rows.map((r) => [r.key, r.kind === "dm" ? r.working : null]));
    expect(working).toEqual({ "d:d3": false, "d:d1": true, "d:d2": false, "c:c1": null });
  });

  test("without who is working, nobody is", () => {
    const rows = buildConversations({ channels: [], dms: [dm("d1", "Dev", 0, 10)], threads: [] });
    expect(rows[0]?.kind === "dm" && rows[0].working).toBe(false);
  });

  test("the chips' order: Todas, Não lidas, Diretas, Threads e missões", () => {
    expect(CHAT_FILTERS).toEqual(["all", "unread", "dm", "threads"]);
  });
});

describe("Esperando você", () => {
  const mission = (id: string, canAct: boolean, reviews: number, decisions: number) => ({
    id,
    canAct,
    pending: { reviews, decisions },
  });

  test("missions you can act on with something pending, and their items", () => {
    const list = [mission("m1", true, 1, 1), mission("m2", false, 2, 0), mission("m3", true, 0, 0)];
    expect(missionsWaiting(list).map((m) => m.id)).toEqual(["m1"]);
    expect(missionWaitingItems(mission("m", true, 2, 3))).toBe(5);
  });

  test("open agent questions only", () => {
    const items = [
      { id: "1", kind: "agent_question", doneAt: null },
      { id: "2", kind: "agent_question", doneAt: at(1) },
      { id: "3", kind: "mention", doneAt: null },
    ] as const;
    expect(openQuestions([...items]).map((n) => n.id)).toEqual(["1"]);
  });

  test("the count: requests, mission items and questions", () => {
    expect(waitingTotal({ approvals: 2, missions: [mission("m", true, 1, 2)], questions: 1 })).toBe(6);
    expect(waitingTotal({ approvals: 0, missions: [], questions: 0 })).toBe(0);
  });
});
