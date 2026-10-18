import { describe, expect, test } from "bun:test";
import type { ActivityEntry } from "@agenteschat/adapters/runner-control";
import { groupByDay, hasMore, homesToFetch, mergePages, startCursor } from "../src/control/activity";

const at = (min: number) => new Date(Date.UTC(2026, 9, 17, 12, 0) - min * 60_000).toISOString();
const entry = (min: number, summary = `e${min}`): ActivityEntry => ({ at: at(min), kind: "file", summary });

describe("activity paging across organizations", () => {
  test("merges newest first and keeps only the page size", () => {
    const cursor = startCursor(["a", "b"]);
    const { entries, cursor: next } = mergePages(
      [
        { homeId: "a", entries: [entry(1), entry(5), entry(9)], more: false },
        { homeId: "b", entries: [entry(2), entry(3), entry(20)], more: false },
      ],
      cursor,
      4,
    );
    expect(entries.map((e) => `${e.homeId}:${e.summary}`)).toEqual(["a:e1", "b:e2", "b:e3", "a:e5"]);
    // a showed e1 and e5; e9 is left over, so a has more, starting before e5.
    expect(next.a).toEqual({ before: at(5), more: true });
    // b showed e2 and e3; e20 is left over.
    expect(next.b).toEqual({ before: at(3), more: true });
    expect(hasMore(next)).toBe(true);
  });

  test("the next page asks again from each home's cursor", () => {
    const first = mergePages(
      [
        { homeId: "a", entries: [entry(1), entry(5), entry(9)], more: false },
        { homeId: "b", entries: [entry(2), entry(3), entry(20)], more: false },
      ],
      startCursor(["a", "b"]),
      4,
    );
    expect(homesToFetch(first.cursor).sort()).toEqual(["a", "b"]);
    const second = mergePages(
      [
        { homeId: "a", entries: [entry(9)], more: false },
        { homeId: "b", entries: [entry(20)], more: false },
      ],
      first.cursor,
      4,
    );
    expect(second.entries.map((e) => e.summary)).toEqual(["e9", "e20"]);
    expect(hasMore(second.cursor)).toBe(false);
    expect(homesToFetch(second.cursor)).toEqual([]);
  });

  test("a home that shows nothing keeps its cursor", () => {
    const cursor = { a: { before: at(1), more: true }, b: { more: true } };
    const { cursor: next } = mergePages(
      [
        { homeId: "a", entries: [entry(50)], more: true },
        { homeId: "b", entries: [entry(2)], more: false },
      ],
      cursor,
      1,
    );
    expect(next.a).toEqual({ before: at(1), more: true });
    expect(next.b).toEqual({ before: at(2), more: false });
  });

  test("a runner saying it has more keeps paging", () => {
    const { cursor } = mergePages([{ homeId: "a", entries: [entry(1)], more: true }], startCursor(["a"]), 40);
    expect(cursor.a?.more).toBe(true);
  });
});

describe("groupByDay", () => {
  test("today, yesterday, then dates", () => {
    const now = new Date(2026, 9, 17, 15, 0);
    const local = (d: number, h: number) => new Date(2026, 9, d, h, 0).toISOString();
    const groups = groupByDay(
      [{ at: local(17, 14) }, { at: local(17, 9) }, { at: local(16, 20) }, { at: local(12, 8) }],
      now,
    );
    expect(groups.map((g) => [g.kind, g.entries.length])).toEqual([
      ["today", 2],
      ["yesterday", 1],
      ["date", 1],
    ]);
  });
});
