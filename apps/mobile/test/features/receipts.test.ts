import { describe, expect, test } from "bun:test";
import { AGENT_ACTION_KINDS, type AgentAction, type AgentActionKind } from "@agenteschat/client";
import {
  boldRuns,
  groupStart,
  RECEIPT_ICONS,
  receiptIcon,
  receiptLayout,
  targetHref,
} from "../../src/features/chat/actions";

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

  test("the group's age is its first change", () => {
    expect(
      groupStart([action({ createdAt: "2026-10-18T11:59:30Z" }), action({ createdAt: "2026-10-18T11:58:00Z" })]),
    ).toBe("2026-10-18T11:58:00Z");
    expect(groupStart([])).toBeNull();
  });

  test("tapping the target opens what the phone has", () => {
    expect(targetHref({ type: "issue", id: "i1", number: 23 }, "c1")).toBe("/issues/23");
    expect(targetHref({ type: "issue", id: "i1" }, "c1")).toBeNull();
    expect(targetHref({ type: "channel", id: "c9", title: "tech" }, "c1")).toBe("/chat/c9");
    expect(targetHref({ type: "thread", id: "t1" }, "c1")).toBe("/chat/c1?thread=t1");
    expect(targetHref({ type: "wiki_page", id: "w1", slug: "x" }, "c1")).toBeNull();
    // A memory opens its own screen, where it is fixed or forgotten; a skill its page.
    expect(targetHref({ type: "memory", id: "m1" }, "c1")).toBe("/memory/m1");
    expect(targetHref({ type: "memory", id: "../x" }, "c1")).toBeNull();
    expect(targetHref({ type: "skill", id: "s1" }, "c1")).toBe("/settings/skills/s1");
    expect(targetHref({ type: "routine", id: "r1" }, "c1")).toBe("/routines/r1");
    expect(targetHref({ type: "routine", id: "" }, "c1")).toBeNull();
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

  test("every kind the app knows has its icon; one it doesn't yet gets the plain check", () => {
    expect(Object.keys(RECEIPT_ICONS).sort()).toEqual([...AGENT_ACTION_KINDS].sort());
    expect(receiptIcon("channel.created")).toBe("hash");
    expect(receiptIcon("something.new" as AgentActionKind)).toBe("checkc");
  });
});
