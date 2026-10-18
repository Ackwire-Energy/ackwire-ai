import { describe, expect, test } from "bun:test";
import type { AgentAction } from "@agenteschat/client";
import {
  anyLive,
  boldRuns,
  groupStart,
  optimisticRedo,
  optimisticUndo,
  receiptIcon,
  receiptLayout,
  receiptView,
  targetHref,
  viewerCanUndo,
} from "../../src/features/chat/actions";

const now = Date.parse("2026-10-18T12:00:00Z");
const action = (over: Partial<AgentAction> = {}): AgentAction => ({
  id: "a1",
  kind: "issue.created",
  agentId: "ag",
  messageId: "m1",
  requestedByUserId: "u1",
  target: { type: "issue", id: "i1", number: 23, title: "Prompt" },
  params: { number: 23, title: "Prompt" },
  createdAt: "2026-10-18T11:59:00Z",
  undoableUntil: "2026-10-18T12:04:58Z",
  undoneAt: null,
  undoneByUserId: null,
  redoneAt: null,
  ...over,
});

describe("receipts under an agent's reply", () => {
  test("one change is a row (A), two or more a group (B)", () => {
    expect(receiptLayout(undefined)).toBe("none");
    expect(receiptLayout([])).toBe("none");
    expect(receiptLayout([action()])).toBe("one");
    expect(receiptLayout([action(), action({ id: "a2" })])).toBe("group");
  });

  test("phases: Desfazer with the time left, Refazer once undone, plain history after the window", () => {
    expect(receiptView(action(), true, now)).toEqual({
      phase: "undo",
      timeLeft: "4:58",
      struck: false,
      button: "undo",
    });
    const undone = action({ undoneAt: "2026-10-18T11:59:30Z", undoneByUserId: "u1" });
    expect(receiptView(undone, true, now)).toEqual({ phase: "redo", timeLeft: "", struck: true, button: "redo" });
    const old = action({ undoableUntil: "2026-10-18T11:58:00Z" });
    expect(receiptView(old, true, now)).toEqual({ phase: "settled", timeLeft: "", struck: false, button: null });
    // Undone and expired: still crossed out, no button.
    expect(receiptView({ ...old, undoneAt: "2026-10-18T11:57:00Z" }, true, now).struck).toBe(true);
    // Who may not undo sees no button.
    expect(receiptView(action(), false, now).button).toBeNull();
  });

  test("the clock ticks only while something counts down", () => {
    expect(anyLive([action()], now)).toBe(true);
    expect(anyLive([action({ undoableUntil: "2026-10-18T11:00:00Z" })], now)).toBe(false);
  });

  test("who sees the buttons: the person it worked for, admins, the agent's owner", () => {
    const a = action();
    expect(viewerCanUndo(a, { userId: "u1", role: "member", ownsAgent: false })).toBe(true);
    expect(viewerCanUndo(a, { userId: "u2", role: "member", ownsAgent: false })).toBe(false);
    expect(viewerCanUndo(a, { userId: "u2", role: "admin", ownsAgent: false })).toBe(true);
    expect(viewerCanUndo(a, { userId: "u2", role: "member", ownsAgent: true })).toBe(true);
    // Still loading who I am: no buttons.
    expect(viewerCanUndo(a, { userId: null, role: "owner", ownsAgent: false })).toBe(false);
    expect(viewerCanUndo(a, { userId: "u1", role: undefined, ownsAgent: false })).toBe(false);
  });

  test("the group's age is its first change", () => {
    expect(
      groupStart([action({ createdAt: "2026-10-18T11:59:30Z" }), action({ createdAt: "2026-10-18T11:58:00Z" })]),
    ).toBe("2026-10-18T11:58:00Z");
    expect(groupStart([])).toBeNull();
  });

  test("optimistic undo, undo all and redo", () => {
    const list = [action(), action({ id: "a2" }), action({ id: "a3", undoableUntil: "2026-10-18T11:00:00Z" })];
    const one = optimisticUndo(list, ["a1"], "me", now);
    expect(one[0]?.undoneByUserId).toBe("me");
    expect(one[1]?.undoneAt).toBeNull();
    const all = optimisticUndo(list, ["a1", "a2", "a3"], "me", now);
    expect(all.map((a) => Boolean(a.undoneAt))).toEqual([true, true, false]);
    const back = optimisticRedo(all, "a1", now);
    expect(back[0]?.undoneAt).toBeNull();
    expect(back[0]?.redoneAt).toBe(new Date(now).toISOString());
    expect(back[1]?.undoneAt).not.toBeNull();
  });

  test("tapping the target opens what the phone has", () => {
    expect(targetHref({ type: "issue", id: "i1", number: 23 }, "c1")).toBe("/issues/23");
    expect(targetHref({ type: "issue", id: "i1" }, "c1")).toBeNull();
    expect(targetHref({ type: "channel", id: "c9", title: "tech" }, "c1")).toBe("/chat/c9");
    expect(targetHref({ type: "thread", id: "t1" }, "c1")).toBe("/chat/c1?thread=t1");
    expect(targetHref({ type: "wiki_page", id: "w1", slug: "x" }, "c1")).toBeNull();
    expect(targetHref({ type: "memory", id: "m1" }, "c1")).toBeNull();
    expect(targetHref({ type: "routine", id: "r1" }, "c1")).toBeNull();
  });

  test("icons per kind and bold runs of the sentence", () => {
    expect(receiptIcon("issue.created")).toBe("issue");
    expect(receiptIcon("memory.saved")).toBe("brain");
    expect(receiptIcon("routine.updated")).toBe("clock");
    expect(boldRuns("Criei a issue <b>#23</b> · Prompt")).toEqual([
      { text: "Criei a issue ", bold: false },
      { text: "#23", bold: true },
      { text: " · Prompt", bold: false },
    ]);
    expect(boldRuns("sem marca")).toEqual([{ text: "sem marca", bold: false }]);
  });
});
