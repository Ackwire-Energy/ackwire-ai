import { describe, expect, test } from "bun:test";
import type { RunConsultation } from "../src/api/types";
import {
  consultGroupSummary,
  consultLineState,
  consultSeconds,
  firstOfRun,
  foldsNotice,
  groupsByRun,
  shownConsultations,
} from "../src/lib/consult-group";

const T0 = Date.parse("2026-10-29T10:00:00Z");
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

const q = (over: Partial<RunConsultation> = {}): RunConsultation => ({
  id: "q1",
  runId: "r1",
  agentId: "lia",
  consultedAgentId: "theo",
  status: "open",
  waiting: null,
  question: "How are rates today?",
  answer: null,
  createdAt: iso(0),
  answeredAt: null,
  expiresAt: iso(900),
  ...over,
});

describe("consultLineState", () => {
  const now = T0 + 60_000;
  test("open: working, or waiting on a person", () => {
    expect(consultLineState(q(), now)).toBe("working");
    expect(consultLineState(q({ waiting: "approval" }), now)).toBe("waiting");
    expect(consultLineState(q({ waiting: "input" }), now)).toBe("waiting");
  });
  test("open past its deadline reads as expired before the worker closes it", () => {
    expect(consultLineState(q(), T0 + 901_000)).toBe("expired");
  });
  test("closed: answered (with words), failed, expired", () => {
    expect(consultLineState(q({ status: "answered", answer: "Up 6 bp" }), now)).toBe("answered");
    expect(consultLineState(q({ status: "answered", answer: "  " }), now)).toBe("failed");
    expect(consultLineState(q({ status: "failed", answer: "no reply" }), now)).toBe("failed");
    expect(consultLineState(q({ status: "expired" }), now)).toBe("expired");
  });
});

describe("groupsByRun", () => {
  test("by the asking run, each run's oldest first", () => {
    const groups = groupsByRun([
      q({ id: "b", createdAt: iso(5) }),
      q({ id: "x", runId: "r2" }),
      q({ id: "a", createdAt: iso(1) }),
    ]);
    expect([...groups.keys()]).toEqual(["r1", "r2"]);
    expect(groups.get("r1")?.map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("consultGroupSummary", () => {
  test("counts what came back and whether some question is still out", () => {
    const now = T0 + 60_000;
    const s = consultGroupSummary(
      [
        q({ id: "1", status: "answered", answer: "A" }),
        q({ id: "2", status: "failed" }),
        q({ id: "3", waiting: "approval" }),
        q({ id: "4" }),
      ],
      now,
    );
    expect(s).toEqual({ total: 4, closed: 2, answered: 1, open: true, waiting: true });
    expect(consultGroupSummary([q({ status: "answered", answer: "A" })], now)).toMatchObject({
      closed: 1,
      open: false,
      waiting: false,
    });
  });
});

describe("foldsNotice", () => {
  const notice = (consultationId?: string) => ({
    notice: { kind: "consult_reply", text: "…", refs: consultationId ? { consultationId } : {} },
  });
  test("a consult_reply whose question a reply here shows", () => {
    expect(foldsNotice(notice("q1"), new Set(["q1"]))).toBe(true);
    expect(foldsNotice(notice("q9"), new Set(["q1"]))).toBe(false);
    expect(foldsNotice(notice(), new Set(["q1"]))).toBe(false);
  });
  test("other notices and plain messages never fold", () => {
    const note = { notice: { kind: "agent_note", text: "hi", refs: { consultationId: "q1" } } };
    expect(foldsNotice(note, new Set(["q1"]))).toBe(false);
    expect(foldsNotice(undefined, new Set(["q1"]))).toBe(false);
  });
});

describe("shownConsultations", () => {
  test("only the questions of runs with a reply in view", () => {
    const list = [q({ id: "a", runId: "r1" }), q({ id: "b", runId: "r2" })];
    expect([...shownConsultations(list, new Set(["r1"]))]).toEqual(["a"]);
    expect(shownConsultations(list, new Set()).size).toBe(0);
  });
});

describe("consultSeconds", () => {
  test("until it closed, or until now while open", () => {
    expect(consultSeconds(q({ status: "answered", answeredAt: iso(80) }), T0 + 999_000)).toBe(80);
    expect(consultSeconds(q(), T0 + 12_400)).toBe(12);
  });
});

describe("firstOfRun", () => {
  test("the run's earliest message, whatever the list's order", () => {
    const list = [
      { id: "m3", agentRunId: "r1", createdAt: iso(30) },
      { id: "m1", agentRunId: "r1", createdAt: iso(10) },
      { id: "m2", agentRunId: "r2", createdAt: iso(1) },
    ];
    expect(firstOfRun(list, "r1")).toBe("m1");
    expect(firstOfRun(list, "r9")).toBeNull();
  });
});
