import { describe, expect, test } from "bun:test";
import {
  appendedKeys,
  type HeldRun,
  HOLD_FINISHED_RUN_MS,
  lastSeenKey,
  type Place,
  placeCorrection,
  runsToShow,
  type ScrollRow,
  type TurnKey,
  turnKeys,
  turnRowByRun,
  unseenBelow,
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

const row = (key: string, kind: ScrollRow["kind"] = "message", mine = false, who?: string): ScrollRow => ({
  key,
  kind,
  mine,
  ...(who ? { who } : {}),
});

describe("what arrived below", () => {
  test("the last message row is where the person read up to", () => {
    expect(lastSeenKey([row("day", "other"), row("a"), row("run-1", "run")])).toBe("a");
    expect(lastSeenKey([row("day", "other")])).toBeNull();
  });
  test("new messages from others after the seen one, who wrote them, who is at work", () => {
    const rows = [
      row("a"),
      row("day2", "other"),
      row("b", "message", false, "person:marina"),
      row("mine", "message", true, "person:me"),
      row("c", "message", false, "agent:ada"),
      row("d", "message", false, "person:marina"),
      row("turn-1", "run", false, "agent:theo"),
    ];
    expect(unseenBelow(rows, "a")).toEqual({
      messages: 3,
      firstKey: "b",
      authors: ["person:marina", "agent:ada"],
      working: ["agent:theo"],
      mentionsMe: false,
    });
    expect(unseenBelow(rows, "c").messages).toBe(1);
    expect(unseenBelow(rows, "c").firstKey).toBe("d");
  });
  test("an agent at work below is not a message yet, but the line goes before it", () => {
    const u = unseenBelow([row("a"), row("turn-1", "run", false, "agent:theo")], "a");
    expect(u.messages).toBe(0);
    expect(u.firstKey).toBe("turn-1");
    expect(u.working).toEqual(["agent:theo"]);
  });
  test("a new message that mentions me turns the round button's count red; one I already saw doesn't", () => {
    const called = { ...row("b", "message", false, "person:marina"), mentionsMe: true };
    expect(unseenBelow([row("a"), called, row("c")], "a").mentionsMe).toBe(true);
    expect(unseenBelow([row("a"), called, row("c")], "b").mentionsMe).toBe(false);
  });
  test("my own messages never count", () => {
    expect(unseenBelow([row("a"), row("mine", "message", true)], "a").firstKey).toBeNull();
  });
  test("nothing seen yet, or the seen row is gone: nothing counts", () => {
    expect(unseenBelow([row("a"), row("b")], null).messages).toBe(0);
    expect(unseenBelow([row("a"), row("b")], "zz").firstKey).toBeNull();
  });
  test("a reply posted since I was at the end, in its place above what I saw last, is new too; the line goes before it", () => {
    // Ids sort in the order the server posted them. At the end "b" (v2) was the newest, below a block at work; its
    // reply (v3) took the block's row once I read above.
    const said = (key: string, id: string, who?: string) => ({ ...row(key, "message", false, who), id });
    const rows = [said("a", "v1"), said("turn-1", "v3", "agent:ada"), said("b", "v2", "person:marina")];
    expect(unseenBelow(rows, "b", "v2")).toEqual({
      messages: 1,
      firstKey: "turn-1",
      authors: ["agent:ada"],
      working: [],
      mentionsMe: false,
    });
    // Still at work there: nothing new yet.
    expect(unseenBelow([said("a", "v1"), row("turn-1", "run"), said("b", "v2")], "b", "v2").firstKey).toBeNull();
    // Its run ended with nothing more to say: the card it posted before takes the block's row again, and isn't new.
    const old = [said("a", "v1"), said("turn-1", "v0", "agent:ada"), said("b", "v2", "person:marina")];
    expect(unseenBelow(old, "b", "v2").firstKey).toBeNull();
  });
});

describe("turnKeys", () => {
  const run = (runId: string, agentId = "theo", threadId = "t1", provisional = false) => ({
    runId,
    agentId,
    channelId: "c1",
    threadId,
    provisional,
  });
  const none = new Map<string, TurnKey>();

  test("a run keeps its key", () => {
    const first = turnKeys(none, [run("r1")]);
    expect(first.get("r1")?.key).toBe("turn-r1");
    expect(turnKeys(first, [run("r1")]).get("r1")?.key).toBe("turn-r1");
  });
  test("the real run takes the key of the guessed 'pensando…' once the guess is gone", () => {
    const guessed = turnKeys(none, [run("p:theo", "theo", "t1", true)]);
    const real = turnKeys(guessed, [run("r1")]);
    expect(real.get("r1")?.key).toBe(guessed.get("p:theo")?.key);
    expect(real.get("r1")?.key).toStartWith("turn-p:theo");
    expect(real.has("p:theo")).toBe(false);
  });
  test("the same agent asked again in the same thread: a new guess, a new key", () => {
    const guessed = turnKeys(none, [run("p:theo", "theo", "t1", true)]);
    const real = turnKeys(guessed, [run("r1")]);
    const again = turnKeys(real, [run("p:theo", "theo", "t1", true)]);
    expect(again.get("p:theo")?.key).not.toBe(real.get("r1")?.key);
  });
  test("while the guess is still shown, or for another agent, the run gets its own key", () => {
    const guessed = turnKeys(none, [run("p:theo", "theo", "t1", true)]);
    expect(turnKeys(guessed, [run("p:theo", "theo", "t1", true), run("r1")]).get("r1")?.key).toBe("turn-r1");
    expect(turnKeys(guessed, [run("r2", "ada")]).get("r2")?.key).toBe("turn-r2");
  });
  test("a guess in another thread of the same conversation still hands over (a DM's flat reply)", () => {
    const guessed = turnKeys(none, [run("p:theo", "theo", "m1", true)]);
    expect(turnKeys(guessed, [run("r1", "theo", "t9")]).get("r1")?.key).toBe(guessed.get("p:theo")?.key);
  });
});

describe("turnRowByRun", () => {
  const msg = (key: string, agentRunId: string | null) => ({ kind: "message", key, message: { agentRunId } });
  const rows = [msg("m1", "r1"), { kind: "day", key: "d" }, msg("m2", null), msg("m3", "r1"), msg("m4", "r2")];
  test("only a run's last message takes its block key", () => {
    expect(turnRowByRun(rows, new Set())).toEqual(
      new Map([
        ["r1", "m3"],
        ["r2", "m4"],
      ]),
    );
  });
  test("none while the run still draws its own block", () => {
    expect(turnRowByRun(rows, new Set(["r1"]))).toEqual(new Map([["r2", "m4"]]));
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
  test("a run resumed after an approval or a question shows again, though its card is listed", () => {
    // The card landed and the run left the live store: its block goes (the card takes its place).
    const gone = runsToShow(none, [run("1")], [], new Set(["1"]), 0);
    expect(gone.shown).toEqual([]);
    // Approved: the same run works again, its card still in the list.
    const resumed = runsToShow(gone.held, gone.shown, [run("1")], new Set(["1"]), 100);
    expect(resumed.shown).toEqual([run("1")]);
    // Done: its reply is listed and the run left the store: no block, nothing held.
    const done = runsToShow(resumed.held, resumed.shown, [], new Set(["1"]), 200);
    expect(done.shown).toEqual([]);
    expect(done.held.size).toBe(0);
  });
  test("a run that wrote nothing is not held", () => {
    const first = runsToShow(none, [run("1")], [], new Set(), 0, HOLD_FINISHED_RUN_MS, () => false);
    expect(first.shown).toEqual([]);
  });
  test("held rows come before the ones still writing", () => {
    const first = runsToShow(none, [run("1"), run("2")], [run("2")], new Set(), 0);
    expect(first.shown.map((x) => x.runId)).toEqual(["1", "2"]);
  });
});

describe("placeCorrection", () => {
  const list = (scroll: number, distanceFromEnd = 500, positions: Record<string, number> = {}) => ({
    scroll,
    distanceFromEnd,
    positionOf: (key: string) => positions[key],
  });
  const reading: Place = { end: false, scroll: 1200, key: "m7", position: 1100 };

  test("a place still on screen needs nothing, a drift under the slack included", () => {
    expect(placeCorrection(reading, list(1200, 500, { m7: 1100 }))).toBeNull();
    expect(placeCorrection(reading, list(1230, 500, { m7: 1100 }))).toBeNull();
  });
  test("a jump toward older messages or toward the end is put back", () => {
    expect(placeCorrection(reading, list(0, 2000, { m7: 1100 }))).toBe(1200);
    expect(placeCorrection(reading, list(2400, 0, { m7: 1100 }))).toBe(1200);
  });
  test("rows above that grew move the place with its row", () => {
    // An older page loaded above: the row is 600 lower, and the list moved with it.
    expect(placeCorrection(reading, list(1800, 500, { m7: 1700 }))).toBeNull();
    // It didn't: the row is put back where it was on screen.
    expect(placeCorrection(reading, list(1200, 500, { m7: 1700 }))).toBe(1800);
  });
  test("without its row, the scroll it had", () => {
    expect(placeCorrection(reading, list(300))).toBe(1200);
    expect(placeCorrection({ end: false, scroll: 800, key: null, position: null }, list(300))).toBe(800);
  });
  test("at the end, it goes back to the end only when the list left it", () => {
    expect(placeCorrection({ end: true }, list(900, 0))).toBeNull();
    expect(placeCorrection({ end: true }, list(900, 30))).toBeNull();
    expect(placeCorrection({ end: true }, list(0, 900))).toBe("end");
  });
});
