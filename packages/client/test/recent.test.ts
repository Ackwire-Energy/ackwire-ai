import { expect, test } from "bun:test";
import type { DirectMessage } from "../src/api/types";
import { recentDms } from "../src/lib/recent";

const dm = (id: string, type: "person" | "agent", at: string | null): DirectMessage => ({
  channelId: `dm-${id}`,
  with: { type, id, name: id, handle: null },
  lastMessage: at ? { id: `m-${id}`, body: "oi", createdAt: at, authorType: type } : null,
  unread: 0,
});

test("recentDms: only DMs with a message, latest first, people and agents together, hidden agents left out", () => {
  const list = [
    dm("ana", "person", "2026-11-01T10:00:00.000Z"),
    dm("ada", "agent", "2026-11-02T09:00:00.000Z"),
    dm("empty", "person", null),
    dm("secret", "agent", "2026-11-02T12:00:00.000Z"),
    dm("joao", "person", "2026-11-02T11:00:00.000Z"),
  ];
  expect(recentDms(list, new Set(["secret"])).map((d) => d.with.id)).toEqual(["joao", "ada", "ana"]);
  expect(recentDms(list).map((d) => d.with.id)).toEqual(["secret", "joao", "ada", "ana"]);
});
