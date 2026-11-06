import { expect, test } from "bun:test";
import type { DirectMessage } from "../src/api/types";
import { recentDms } from "../src/lib/recent";

const dm = (id: string, type: "person" | "agent", at: string | null): DirectMessage => ({
  channelId: `dm-${id}`,
  with: { type, id, name: id, handle: null },
  lastMessage: at ? { id: `m-${id}`, body: "oi", createdAt: at, authorType: type } : null,
  unread: 0,
});

test("recentDms: latest first, people and agents together, hidden agents left out", () => {
  const list = [
    dm("ana", "person", "2026-11-01T10:00:00.000Z"),
    dm("ada", "agent", "2026-11-02T09:00:00.000Z"),
    dm("secret", "agent", "2026-11-02T12:00:00.000Z"),
    dm("joao", "person", "2026-11-02T11:00:00.000Z"),
  ];
  expect(recentDms(list, new Set(["secret"])).map((d) => d.with.id)).toEqual(["joao", "ada", "ana"]);
  expect(recentDms(list).map((d) => d.with.id)).toEqual(["secret", "joao", "ada", "ana"]);
});

test("recentDms: a DM with no message yet sorts by when it began, so a new one is on top; from an older server, last", () => {
  const list = [
    dm("ana", "person", "2026-11-01T10:00:00.000Z"),
    { ...dm("new", "person", null), openedAt: "2026-11-02T10:00:00.000Z" },
    { ...dm("old", "person", null), openedAt: "2026-10-01T10:00:00.000Z" },
    dm("older-server", "person", null),
  ];
  expect(recentDms(list).map((d) => d.with.id)).toEqual(["new", "ana", "old", "older-server"]);
});
