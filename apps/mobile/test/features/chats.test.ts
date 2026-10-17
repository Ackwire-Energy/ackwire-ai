import { describe, expect, test } from "bun:test";
import type { Channel, DirectMessage } from "@agenteschat/client";
import {
  buildConversations,
  filterConversations,
  filterCounts,
  isListedThread,
  unreadConversations,
} from "../../src/features/chats/logic";
import { at, thread } from "./fixtures";

const channel = (id: string, name: string, isMember = true): Channel => ({
  id,
  name,
  topic: "",
  visibility: "public",
  isMember,
  createdAt: at(1000),
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
