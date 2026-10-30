import { describe, expect, test } from "bun:test";
import type { Channel } from "@agenteschat/client";
import { categoryHrefs, movesChannel, stepBefore } from "../../src/features/categories/logic";
import {
  buildConversations,
  categoryListKind,
  categoryOfListKind,
  homeLayout,
  parseHomeCollapsed,
  toggleHomeCollapsed,
} from "../../src/features/chats/logic";
import { at } from "./fixtures";

const channel = (id: string, minutesAgo: number, over: Partial<Channel> = {}): Channel => ({
  id,
  name: id,
  topic: "",
  visibility: "public",
  isMember: true,
  createdAt: at(1000),
  lastMessage: {
    id: `m-${id}`,
    authorType: "person",
    authorId: "u1",
    authorName: "Caio",
    preview: "oi",
    meta: null,
    createdAt: at(minutesAgo),
  },
  ...over,
});

const CATEGORIES = [
  { id: "mkt", name: "Marketing", position: 0 },
  { id: "eng", name: "Engenharia", position: 1 },
  { id: "empty", name: "Vazia", position: 2 },
];

describe("the home with channel categories", () => {
  const rows = buildConversations({
    channels: [
      channel("general", 5),
      channel("campanhas", 1, { categoryId: "mkt", unreadCount: 2 }),
      channel("bugs", 3, { categoryId: "eng" }),
      channel("marketing", 9, { categoryId: "mkt" }),
      // A category this phone doesn't know yet: with the ones with none.
      channel("novo", 7, { categoryId: "gone" }),
    ],
    dms: [],
    threads: [],
  });

  test("Canais holds the ones with no category, then one section per category in order, empty ones left out", () => {
    const blocks = homeLayout(rows, CATEGORIES);
    expect(blocks.map((b) => [b.key, b.name, b.rows.map((r) => r.key)])).toEqual([
      ["channels", undefined, ["c:general", "c:novo"]],
      ["category:mkt", "Marketing", ["c:campanhas", "c:marketing"]],
      ["category:eng", "Engenharia", ["c:bugs"]],
    ]);
  });

  test("a category's unread channels are kept for when it is closed", () => {
    const mkt = homeLayout(rows, CATEGORIES).find((b) => b.categoryId === "mkt");
    expect(mkt?.unread.map((r) => r.key)).toEqual(["c:campanhas"]);
  });

  test("closed sections keep any key, and toggle", () => {
    expect(parseHomeCollapsed(JSON.stringify(["agents", "category:mkt", 3]))).toEqual(["agents", "category:mkt"]);
    expect(parseHomeCollapsed("nope")).toEqual([]);
    expect(toggleHomeCollapsed(["agents"], "category:mkt")).toEqual(["agents", "category:mkt"]);
    expect(toggleHomeCollapsed(["agents", "category:mkt"], "agents")).toEqual(["category:mkt"]);
  });

  test("a category's Ver todos route", () => {
    expect(categoryOfListKind(categoryListKind("mkt"))).toBe("mkt");
    expect(categoryOfListKind("channels")).toBeNull();
  });
});

describe("arranging categories", () => {
  test("moving one step up or down says what it then sits before", () => {
    const ids = ["a", "b", "c"];
    expect(stepBefore(ids, "c", -1)).toBe("b");
    expect(stepBefore(ids, "a", 1)).toBe("c");
    expect(stepBefore(ids, "b", 1)).toBeNull();
    expect(stepBefore(ids, "a", -1)).toBeUndefined();
    expect(stepBefore(ids, "c", 1)).toBeUndefined();
  });

  test("a channel's creator or an admin may move it", () => {
    expect(movesChannel({ createdByUserId: "u1" }, "u1", "member")).toBe(true);
    expect(movesChannel({ createdByUserId: "u2" }, "u1", "member")).toBe(false);
    expect(movesChannel({ createdByUserId: "u2" }, "u1", "admin")).toBe(true);
    expect(movesChannel({ createdByUserId: null }, null, "member")).toBe(false);
  });

  test("the screens' addresses", () => {
    expect(categoryHrefs.pick("c 1")).toBe("/channel-category?channelId=c%201");
    expect(categoryHrefs.create()).toBe("/channel-category-new");
    expect(categoryHrefs.edit("x")).toBe("/channel-category-edit?id=x");
  });
});
