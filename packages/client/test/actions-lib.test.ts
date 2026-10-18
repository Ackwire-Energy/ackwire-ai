import { describe, expect, test } from "bun:test";
import type { AgentAction } from "../src/api/types";
import {
  actionErrorKey,
  actionPhase,
  actionTextKey,
  actionTimeLeft,
  canUndoAction,
  formatTimeLeft,
  undoableNow,
} from "../src/lib/actions";

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
  undoableUntil: "2026-10-18T12:04:00Z",
  undoneAt: null,
  undoneByUserId: null,
  redoneAt: null,
  ...over,
});

describe("receipts", () => {
  test("phase: undo, then redo once undone, settled after the window", () => {
    expect(actionPhase(action(), now)).toBe("undo");
    expect(actionPhase(action({ undoneAt: "2026-10-18T11:59:30Z" }), now)).toBe("redo");
    expect(actionPhase(action({ undoableUntil: "2026-10-18T11:00:00Z" }), now)).toBe("settled");
  });

  test("time left and countdown", () => {
    expect(actionTimeLeft(action(), now)).toBe(240_000);
    expect(formatTimeLeft(238_000)).toBe("3:58");
    expect(actionTimeLeft(action({ undoableUntil: "2026-10-18T11:00:00Z" }), now)).toBe(0);
  });

  test("who sees the buttons", () => {
    expect(canUndoAction(action(), { userId: "u1", role: "member", ownsAgent: false })).toBe(true);
    expect(canUndoAction(action(), { userId: "u2", role: "member", ownsAgent: false })).toBe(false);
    expect(canUndoAction(action(), { userId: "u2", role: "admin", ownsAgent: false })).toBe(true);
    expect(canUndoAction(action(), { userId: "u2", role: "member", ownsAgent: true })).toBe(true);
  });

  test("Desfazer tudo takes only the undoable ones; i18n keys", () => {
    const list = [action(), action({ id: "a2", undoneAt: "2026-10-18T11:59:30Z" })];
    expect(undoableNow(list, now).map((a) => a.id)).toEqual(["a1"]);
    expect(actionTextKey(action())).toBe("agentActions.issue.created");
    expect(actionErrorKey("action.changed_since")).toBe("agentActions.errors.changed_since");
  });
});
