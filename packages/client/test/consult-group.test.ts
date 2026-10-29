import { describe, expect, test } from "bun:test";
import type { RunConsultation } from "../src/api/types";
import {
  CONSULT_REQUEST_FRESH_MS,
  consultBlocksNearEnd,
  consultGroupSummary,
  consultLineState,
  consultLineTarget,
  consultNoticeFolds,
  consultSeconds,
  consultsForLine,
  firstOfRun,
  foldsNotice,
  groupsByRun,
  requestConsultBlock,
  shownConsultations,
  takeConsultBlockRequest,
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
  test("open, waiting for its computer to come back: still out, not on a person", () => {
    expect(consultLineState(q({ waiting: "computer" }), now)).toBe("offline");
    expect(consultLineState(q({ waiting: "computer" }), T0 + 901_000)).toBe("expired");
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
  test("an agent waiting for its computer keeps the question out, but no one is waited on", () => {
    const now = T0 + 60_000;
    expect(consultGroupSummary([q({ waiting: "computer" })], now)).toEqual({
      total: 1,
      closed: 0,
      answered: 0,
      open: true,
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

describe("consultLineTarget ('Ver' on the phone)", () => {
  const fold = { fold: "line" as const, consultation: q(), messageId: "m3" };
  test("the run's first message, which draws its block, not the one nearest the notice", () => {
    const shown = [
      { id: "m1", agentRunId: "r1", createdAt: iso(10) },
      { id: "x", agentRunId: null, createdAt: iso(20) },
      { id: "m3", agentRunId: "r1", createdAt: iso(30) },
    ];
    expect(consultLineTarget(shown, fold)).toBe("m1");
  });
  test("none of the run's messages shown: the one the fold names", () => {
    expect(consultLineTarget([{ id: "x", agentRunId: "r2", createdAt: iso(1) }], fold)).toBe("m3");
  });
});

// Rows as the conversation draws them: the reply that asked (run r1), others' messages, the answers' notices.
const asked = (id = "ask", runId = "r1") => ({ id, agentRunId: runId });
const said = (id: string) => ({ id, agentRunId: null });
const answerOf = (id: string, consultationId = "q1") => ({
  id,
  agentRunId: null,
  meta: { notice: { kind: "consult_reply", text: "…", refs: { consultationId, runId: "r1" } } },
});

describe("consultNoticeFolds", () => {
  const list = [q({ status: "answered", answer: "Up 6 bp", answeredAt: iso(80) })];

  test("the reply that asked close above: the notice folds away", () => {
    expect(consultNoticeFolds([asked(), answerOf("n1")], list).get("n1")).toEqual({ fold: "hide" });
    // Two messages between them: still close (CONSULT_NEAR_ROWS).
    expect(consultNoticeFolds([asked(), said("a"), said("b"), answerOf("n1")], list).get("n1")).toEqual({
      fold: "hide",
    });
  });

  test("farther up: one line that leads to it", () => {
    const folds = consultNoticeFolds([asked(), said("a"), said("b"), said("c"), answerOf("n1")], list);
    expect(folds.get("n1")).toEqual({ fold: "line", consultation: list[0] as RunConsultation, messageId: "ask" });
  });

  test("the reply isn't loaded, or the question isn't in the list: the notice keeps its card", () => {
    expect(consultNoticeFolds([said("a"), answerOf("n1")], list).get("n1")).toEqual({ fold: "card" });
    expect(consultNoticeFolds([asked(), answerOf("n1", "q9")], list).get("n1")).toEqual({ fold: "card" });
    expect(consultNoticeFolds([asked(), answerOf("n1")], []).get("n1")).toEqual({ fold: "card" });
  });

  test("a live block is at the end, under everything: its answers fold", () => {
    const rows = [answerOf("n1"), said("a"), said("b"), said("c"), said("d")];
    expect(consultNoticeFolds(rows, list, new Set(["r1"])).get("n1")).toEqual({ fold: "hide" });
  });

  test("answers to several questions in a row don't push their reply away; only notices are listed", () => {
    const four = ["q1", "q2", "q3", "q4"].map((id) => q({ id, status: "answered", answer: "ok" }));
    const rows = [asked(), ...four.map((c, i) => answerOf(`n${i}`, c.id))];
    const folds = consultNoticeFolds(rows, four);
    expect([...folds.values()].map((f) => f.fold)).toEqual(["hide", "hide", "hide", "hide"]);
    expect(folds.has("ask")).toBe(false);
  });

  test("a run that posted several messages: only the one that draws the block counts (web last, phone first)", () => {
    const rows = [asked("first"), said("a"), said("b"), said("c"), said("d"), answerOf("n1")];
    // The web draws the block on the run's last message: a later one right after the notice is close.
    expect(consultNoticeFolds([...rows, asked("later")], list).get("n1")).toEqual({ fold: "hide" });
    const after = [...rows, said("e"), said("f"), said("g"), asked("later")];
    expect(consultNoticeFolds(after, list).get("n1")).toMatchObject({ fold: "line", messageId: "later" });
    // The phone draws it on the first: far up, whatever came later; "Ver" goes to that first message.
    expect(consultNoticeFolds([...rows, asked("later")], list, undefined, "first").get("n1")).toMatchObject({
      fold: "line",
      messageId: "first",
    });
  });

  test("the working line: near the end means the message that draws the block", () => {
    const rows = [asked("first"), said("a"), said("b"), said("c"), asked("later")];
    expect([...consultBlocksNearEnd(rows, list)]).toEqual(["r1"]);
    expect(consultBlocksNearEnd(rows, list, undefined, "first").size).toBe(0);
  });
});

describe("consultBlocksNearEnd", () => {
  const list = [q()];

  test("a reply that asked among the last rows, or a live block", () => {
    expect([...consultBlocksNearEnd([said("a"), asked()], list)]).toEqual(["r1"]);
    expect([...consultBlocksNearEnd([asked(), said("a"), said("b")], list)]).toEqual(["r1"]);
    expect(consultBlocksNearEnd([asked(), said("a"), said("b"), said("c")], list).size).toBe(0);
    expect([...consultBlocksNearEnd([said("a")], list, new Set(["r1"]))]).toEqual(["r1"]);
  });

  test("only runs that asked something; an answer it shows takes no row", () => {
    expect(consultBlocksNearEnd([asked("x", "r2")], list).size).toBe(0);
    expect(consultBlocksNearEnd([said("a")], list, new Set(["r2"])).size).toBe(0);
    const answered = [q({ status: "answered", answer: "ok" })];
    expect([...consultBlocksNearEnd([asked(), said("a"), said("b"), answerOf("n1")], answered)]).toEqual(["r1"]);
  });
});

describe("consultsForLine", () => {
  test("the working line leaves out the runs whose block near the end shows their questions", () => {
    const live = [
      { runId: "r1", agentId: "lia" },
      { runId: "r2", agentId: "dev" },
    ];
    expect(consultsForLine(live, new Set(["r1"]))).toEqual([{ runId: "r2", agentId: "dev" }]);
    expect(consultsForLine(live, new Set())).toBe(live);
  });
});

describe("requestConsultBlock ('Ver' on an answer's line)", () => {
  test("waits for its run's block and is used once; a stale one opens nothing", () => {
    requestConsultBlock("r1", "q1", T0);
    expect(takeConsultBlockRequest("r2", T0 + 100)).toBeNull();
    expect(takeConsultBlockRequest("r1", T0 + 100)).toEqual({ runId: "r1", consultationId: "q1", at: T0 });
    expect(takeConsultBlockRequest("r1", T0 + 200)).toBeNull();
    requestConsultBlock("r1", "q1", T0);
    expect(takeConsultBlockRequest("r1", T0 + CONSULT_REQUEST_FRESH_MS + 1)).toBeNull();
    expect(takeConsultBlockRequest("r1", T0)).toBeNull();
  });
});
