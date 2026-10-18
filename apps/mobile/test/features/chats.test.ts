import { describe, expect, test } from "bun:test";
import type { Channel, DirectMessage } from "@agenteschat/client";
import {
  buildConversations,
  homeSections,
  isListedThread,
  isListKind,
  missionsWaiting,
  missionWaitingItems,
  openQuestions,
  parseCollapsed,
  rowPlace,
  rowsOfKind,
  threadRows,
  toggleCollapsed,
  unreadConversationCount,
  unreadConversations,
  unreadThreadCount,
  waitingPreview,
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

  test("rows by kind, in the list's order", () => {
    expect(rowsOfKind(rows, "threads").map((r) => r.key)).toEqual(["t:t1"]);
    expect(rowsOfKind(rows, "agents").map((r) => r.key)).toEqual(["d:d2", "d:d1"]);
    expect(rowsOfKind(rows, "channels").map((r) => r.key)).toEqual(["c:c1", "c:c2"]);
    expect(rowsOfKind(rows, "people")).toEqual([]);
    expect(unreadConversations(rows)).toBe(1);
  });
});

describe("where a thread or mission lives", () => {
  const mission = { id: "m", agentId: "a-theo", status: "active", planDone: 3, planTotal: 8, waitingYou: 0 } as const;
  const rows = buildConversations({
    channels: [],
    dms: [dm("dm-67aa", "Theo", 0, 50)],
    threads: [
      thread({ id: "t1", channelId: "c1", channelName: "vendas", mission, lastActivityAt: at(1) }),
      thread({ id: "t2", channelId: "dm-67aa", channelName: "dm-67aa4c9adff8625b9433", channelKind: "dm", mission }),
      thread({ id: "t3", channelId: "dm-zz", channelName: "dm-zz", channelKind: "dm", mission }),
    ],
  });
  const place = (key: string, nameOf?: (who: { type: string; id: string | null }) => string) => {
    const r = rows.find((x) => x.key === key);
    return r && (r.kind === "thread" || r.kind === "mission") ? rowPlace(r, nameOf) : "missing";
  };

  test("a channel by its name", () => {
    expect(place("t:t1")).toEqual({ kind: "channel", name: "vendas" });
  });
  test("a DM by who it is with, never its internal name", () => {
    expect(place("t:t2")).toEqual({ kind: "with", name: "Theo" });
  });
  test("a DM not in the list falls back to the mission's agent, else nothing", () => {
    expect(place("t:t3", (w) => (w.id === "a-theo" ? "Theo" : ""))).toEqual({ kind: "with", name: "Theo" });
    expect(place("t:t3")).toBeNull();
    expect(place("t:t3", () => "")).toBeNull();
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
    expect(unreadConversations(rows)).toBe(2);
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

describe("the home by kind", () => {
  const person = (channelId: string, name: string, minutesAgo: number): DirectMessage => ({
    ...dm(channelId, name, 0, minutesAgo),
    with: { type: "person", id: `u-${name}`, name, handle: null },
  });
  const rows = buildConversations({
    channels: [channel("c1", "geral", true, { lastMessage: undefined })],
    dms: [
      ...["A", "B", "C", "D", "E", "F", "G"].map((n, i) => dm(`d${i}`, n, i === 6 ? 2 : 0, (i + 1) * 10)),
      person("p1", "Ana", 15),
    ],
    threads: [
      thread({ id: "t1", title: "Fechamento de setembro", lastActivityAt: at(3) }),
      thread({
        id: "t2",
        lastActivityAt: at(40),
        mission: { id: "m", agentId: "a-A", status: "active", planDone: 1, planTotal: 3, waitingYou: 0 },
      }),
    ],
  });

  test("Agentes, Canais, Pessoas: the first five by latest activity and how many in all; threads stay out", () => {
    const s = homeSections(rows);
    expect(s.map((x) => [x.key, x.total, x.more])).toEqual([
      ["agents", 7, true],
      ["channels", 1, false],
      ["people", 1, false],
    ]);
    expect(s[0]?.rows.map((r) => r.key)).toEqual(["d:d0", "d:d1", "d:d2", "d:d3", "d:d4"]);
    expect(s.flatMap((x) => x.rows).some((r) => r.kind === "thread" || r.kind === "mission")).toBe(false);
  });

  test("empty sections are left out", () => {
    const only = buildConversations({ channels: [], dms: [person("p1", "Ana", 1)], threads: [] });
    expect(homeSections(only).map((x) => x.key)).toEqual(["people"]);
    expect(homeSections([])).toEqual([]);
  });

  test("the Threads tab: threads and missions by latest activity", () => {
    expect(threadRows(rows).map((r) => [r.key, r.kind])).toEqual([
      ["t:t1", "thread"],
      ["t:t2", "mission"],
    ]);
    expect(threadRows([])).toEqual([]);
  });

  test("the Threads badge counts only its own unread rows (an unread DM is Conversas')", () => {
    // The server sends no per-thread unread (reads are per channel): nothing to count yet.
    expect(unreadThreadCount(rows)).toBe(0);
    const withUnread = rows.map((r) => (r.key === "t:t2" || r.key === "d:d0" ? { ...r, unread: 2 } : r));
    expect(unreadThreadCount(withUnread)).toBe(1);
    expect(unreadThreadCount(withUnread.filter((r) => r.kind !== "mission"))).toBe(0);
  });

  test("the pushed lists are the sections' Ver todos; threads are a tab", () => {
    expect(["agents", "channels", "people"].every(isListKind)).toBe(true);
    expect(isListKind("threads")).toBe(false);
    expect(isListKind("nope")).toBe(false);
  });

  test("collapsed sections are remembered as a list; anything unreadable is none", () => {
    expect(parseCollapsed(null)).toEqual([]);
    expect(parseCollapsed("{oops")).toEqual([]);
    expect(parseCollapsed('{"a":1}')).toEqual([]);
    expect(parseCollapsed('["people","x","agents"]')).toEqual(["agents", "people"]);
    expect(toggleCollapsed([], "people")).toEqual(["people"]);
    expect(toggleCollapsed(["people"], "agents")).toEqual(["agents", "people"]);
    expect(toggleCollapsed(["agents", "people"], "agents")).toEqual(["people"]);
  });
});

describe("the Esperando você shortcut's line", () => {
  test("a request first, then a mission, then a question; nothing when nothing waits", () => {
    const approval = { agentId: "theo", title: "Publicar a página" };
    const missionItem = { agentId: "dev", title: "Migrar o banco" };
    const question = {
      actors: [{ type: "agent" as const, id: "nina" }],
      latest: { text: "Qual mês?", title: null },
    } as unknown as Parameters<typeof waitingPreview>[0]["questions"][number];
    expect(waitingPreview({ approvals: [approval], missions: [missionItem], questions: [question] })).toEqual({
      kind: "approval",
      agentId: "theo",
      title: "Publicar a página",
    });
    expect(waitingPreview({ approvals: [], missions: [missionItem], questions: [question] })).toEqual({
      kind: "mission",
      agentId: "dev",
      title: "Migrar o banco",
    });
    expect(waitingPreview({ approvals: [], missions: [], questions: [question] })).toEqual({
      kind: "question",
      agentId: "nina",
      title: "Qual mês?",
    });
    expect(waitingPreview({ approvals: [], missions: [], questions: [] })).toBeNull();
  });
});
