import { describe, expect, test } from "bun:test";
import {
  appendedKeys,
  type HeldRun,
  HOLD_FINISHED_RUN_MS,
  lastSeenKey,
  runsToShow,
  type ScrollRow,
  unreadBelow,
} from "../../src/features/chat/scroll";

describe("appendedKeys", () => {
  test("new rows at the bottom", () => {
    expect(appendedKeys(["a", "b"], ["a", "b", "c", "d"])).toEqual(["c", "d"]);
  });
  test("an older page prepended above is not new at the bottom", () => {
    expect(appendedKeys(["c", "d"], ["a", "b", "c", "d"])).toEqual([]);
  });
  test("prepend and append together: only the bottom ones", () => {
    expect(appendedKeys(["c"], ["a", "c", "e"])).toEqual(["e"]);
  });
  test("first load and a replaced list give nothing", () => {
    expect(appendedKeys([], ["a", "b"])).toEqual([]);
    expect(appendedKeys(["x"], ["a", "b"])).toEqual([]);
  });
  test("a streaming row swapped for its message: the message is the new one", () => {
    expect(appendedKeys(["a", "run-1"], ["a", "m2"])).toEqual(["m2"]);
  });
});

const row = (key: string, kind: ScrollRow["kind"] = "message", mine = false): ScrollRow => ({ key, kind, mine });

describe("unread below", () => {
  test("the last message row is where the person read up to", () => {
    expect(lastSeenKey([row("day", "other"), row("a"), row("run-1", "run")])).toBe("a");
    expect(lastSeenKey([row("day", "other")])).toBeNull();
  });
  test("counts messages and replies from others after the seen one", () => {
    const rows = [row("a"), row("day2", "other"), row("b"), row("mine", "message", true), row("run-1", "run")];
    expect(unreadBelow(rows, "a")).toBe(2);
    expect(unreadBelow(rows, "b")).toBe(1);
  });
  test("nothing seen yet, or the seen row is gone: nothing counts", () => {
    expect(unreadBelow([row("a"), row("b")], null)).toBe(0);
    expect(unreadBelow([row("a"), row("b")], "zz")).toBe(0);
  });
  test("a streaming reply that becomes its message still counts once", () => {
    expect(unreadBelow([row("a"), row("run-1", "run")], "a")).toBe(1);
    expect(unreadBelow([row("a"), row("m1")], "a")).toBe(1);
  });
});

describe("runsToShow", () => {
  const run = (runId: string) => ({ runId, text: `words of ${runId}` });
  const none = new Map<string, HeldRun<ReturnType<typeof run>>>();

  test("writing runs show", () => {
    const r = runsToShow(none, [], [run("1")], new Set(), 0);
    expect(r.shown.map((x) => x.runId)).toEqual(["1"]);
    expect(r.nextExpiry).toBeNull();
  });
  test("a run that stopped writing stays, with its last words, until its message arrives", () => {
    const first = runsToShow(none, [run("1")], [], new Set(), 1000);
    expect(first.shown).toEqual([run("1")]);
    expect(first.nextExpiry).toBe(1000 + HOLD_FINISHED_RUN_MS);
    const arrived = runsToShow(first.held, first.shown, [], new Set(["1"]), 1200);
    expect(arrived.shown).toEqual([]);
    expect(arrived.held.size).toBe(0);
  });
  test("a held run goes after the hold even without its message, and is not held again", () => {
    const first = runsToShow(none, [run("1")], [], new Set(), 0);
    const late = runsToShow(first.held, first.shown, [], new Set(), HOLD_FINISHED_RUN_MS + 1);
    expect(late.shown).toEqual([]);
    const again = runsToShow(late.held, late.shown, [], new Set(), HOLD_FINISHED_RUN_MS + 2);
    expect(again.shown).toEqual([]);
  });
  test("a run whose message is already listed never shows (no duplicate reply)", () => {
    expect(runsToShow(none, [], [run("1")], new Set(["1"]), 0).shown).toEqual([]);
  });
  test("held rows come before the ones still writing", () => {
    const first = runsToShow(none, [run("1"), run("2")], [run("2")], new Set(), 0);
    expect(first.shown.map((x) => x.runId)).toEqual(["1", "2"]);
  });
});
