import { describe, expect, test } from "bun:test";
import type { Artifact, Issue } from "@agenteschat/client";
import { cardPreview, cardShape, driveSections, gridRows, kindKey, matchesType } from "../../src/features/drive/logic";
import {
  conversationOf,
  criteriaProgress,
  currentStep,
  dueDateOf,
  filterCounts,
  isLate,
  issueNumberOf,
  issueSections,
  issueState,
  latestPr,
  minutesSince,
  passesFilter,
  waitsOnYou,
} from "../../src/features/issues/logic";
import { at } from "./fixtures";

const NOW = new Date(2026, 9, 17, 15, 0);

function issue(over: Partial<Issue> & { number: number }): Issue {
  return {
    id: `i${over.number}`,
    title: `Issue ${over.number}`,
    description: "",
    status: "todo",
    priority: "normal",
    assignee: null,
    labels: [],
    dueDate: null,
    criteria: [],
    createdBy: { type: "person", id: "me" },
    source: { type: "manual" },
    channelId: null,
    pullRequests: [],
    artifacts: [],
    work: null,
    createdAt: at(60, NOW),
    updatedAt: at(30, NOW),
    ...over,
  };
}

const work = (state: NonNullable<Issue["work"]>["state"], steps: { tool: string; at: string }[] = []) => ({
  agentId: "a1",
  runId: state === "stalled" ? null : "r1",
  state,
  since: at(6, NOW),
  steps,
});

describe("issue state", () => {
  test("follows the run, then the status (no manual 'working')", () => {
    expect(issueState(issue({ number: 1 }))).toBe("todo");
    expect(issueState(issue({ number: 2, status: "in_progress", work: work("running") }))).toBe("running");
    expect(issueState(issue({ number: 3, status: "in_progress", work: work("waiting_input") }))).toBe("waiting");
    expect(issueState(issue({ number: 4, status: "in_progress", work: work("waiting_approval") }))).toBe("waiting");
    expect(issueState(issue({ number: 5, status: "in_progress", work: work("stalled") }))).toBe("stalled");
    expect(issueState(issue({ number: 6, status: "in_review" }))).toBe("review");
    // A run alive on an issue in review still reads as working.
    expect(issueState(issue({ number: 7, status: "in_review", work: work("running") }))).toBe("running");
    expect(issueState(issue({ number: 8, status: "in_progress" }))).toBe("progress");
    expect(issueState(issue({ number: 9, status: "done", work: work("running") }))).toBe("done");
    expect(issueState(issue({ number: 10, status: "canceled" }))).toBe("canceled");
  });

  test("waits on you only while open and the agent waits", () => {
    expect(waitsOnYou(issue({ number: 1, status: "in_progress", work: work("waiting_input") }))).toBe(true);
    expect(waitsOnYou(issue({ number: 2, status: "in_progress", work: work("running") }))).toBe(false);
  });
});

describe("issue filters and sections", () => {
  const list = [
    issue({
      number: 134,
      status: "in_progress",
      priority: "high",
      assignee: { type: "agent", id: "a1" },
      work: work("running"),
    }),
    issue({
      number: 131,
      status: "in_review",
      assignee: { type: "agent", id: "a2" },
      pullRequests: [{ number: 212, url: "https://x", openedBy: null }],
    }),
    issue({ number: 129, status: "in_progress", assignee: { type: "agent", id: "a3" }, work: work("waiting_input") }),
    issue({ number: 127, dueDate: "2026-10-23", assignee: { type: "agent", id: "a4" } }),
    issue({ number: 126, assignee: { type: "person", id: "me" } }),
    issue({ number: 120, status: "done", updatedAt: at(5, NOW) }),
    issue({ number: 119, status: "canceled", updatedAt: at(50, NOW) }),
  ];

  test("each filter", () => {
    const nums = (f: Parameters<typeof passesFilter>[1]) =>
      list.filter((i) => passesFilter(i, f, "me")).map((i) => i.number);
    expect(nums("open")).toEqual([134, 131, 129, 127, 126]);
    expect(nums("mine")).toEqual([129, 126]);
    expect(nums("agents")).toEqual([134, 131, 129, 127]);
    expect(nums("done")).toEqual([120, 119]);
    expect(filterCounts(list, "me")).toEqual({ open: 5, mine: 2 });
    // Signed-in person not known yet: only what waits counts as "with you".
    expect(filterCounts(list, null).mine).toBe(1);
  });

  test("open issues: working, in review, to do (waiting first)", () => {
    const sections = issueSections(list, "open", "me").map((s) => [s.key, s.items.map((i) => i.number)]);
    expect(sections).toEqual([
      ["working", [134]],
      ["review", [131]],
      ["todo", [129, 127, 126]],
    ]);
  });

  test("to do is ordered by priority and due date after what waits", () => {
    const todo = [
      issue({ number: 1 }),
      issue({ number: 2, priority: "high" }),
      issue({ number: 3, dueDate: "2026-10-20" }),
      issue({ number: 4, priority: "low" }),
    ];
    expect(issueSections(todo, "open", null)[0]?.items.map((i) => i.number)).toEqual([2, 3, 1, 4]);
  });

  test("closed ones newest first; empty sections are left out", () => {
    expect(issueSections(list, "done", "me")).toEqual([{ key: "done", items: [list[5] as Issue, list[6] as Issue] }]);
    expect(issueSections([], "open", "me")).toEqual([]);
  });
});

describe("issue row details", () => {
  test("criteria, PR, current step, minutes", () => {
    expect(criteriaProgress(issue({ number: 1 }))).toBeNull();
    expect(
      criteriaProgress(
        issue({
          number: 2,
          criteria: [
            { id: "c1", text: "a", done: true },
            { id: "c2", text: "b", done: false },
          ],
        }),
      ),
    ).toEqual({ done: 1, total: 2 });
    expect(latestPr(issue({ number: 3 }))).toBeNull();
    const w = work("running", [
      { tool: "sentry", at: at(5, NOW) },
      { tool: "read_file", at: at(2, NOW) },
    ]);
    expect(currentStep(w)?.tool).toBe("read_file");
    expect(currentStep({ ...w, state: "stalled" })).toBeNull();
    expect(minutesSince(at(6, NOW), NOW.getTime())).toBe(6);
    expect(minutesSince(at(-3, NOW), NOW.getTime())).toBe(0);
  });

  test("late only while open", () => {
    expect(isLate(issue({ number: 1, dueDate: "2026-10-16" }), NOW)).toBe(true);
    expect(isLate(issue({ number: 2, dueDate: "2026-10-17" }), NOW)).toBe(false);
    expect(isLate(issue({ number: 3, dueDate: "2026-10-16", status: "done" }), NOW)).toBe(false);
  });

  test("due choices (Saturday 17 Oct 2026)", () => {
    expect(dueDateOf("none", NOW)).toBeNull();
    expect(dueDateOf("today", NOW)).toBe("2026-10-17");
    expect(dueDateOf("tomorrow", NOW)).toBe("2026-10-18");
    expect(dueDateOf("friday", NOW)).toBe("2026-10-23");
    expect(dueDateOf("friday", new Date(2026, 9, 23, 9))).toBe("2026-10-30");
    expect(dueDateOf("friday", new Date(2026, 9, 21, 9))).toBe("2026-10-23");
    expect(dueDateOf("nextWeek", NOW)).toBe("2026-10-24");
  });

  test("Conversar: the channel, the source message's channel, else the agent", () => {
    expect(conversationOf(issue({ number: 1, channelId: "c1" }))).toEqual({ channelId: "c1" });
    expect(conversationOf(issue({ number: 2, source: { type: "message", channelId: "c2", messageId: "m1" } }))).toEqual(
      { channelId: "c2" },
    );
    expect(conversationOf(issue({ number: 3, assignee: { type: "agent", id: "a1" } }))).toEqual({ agentId: "a1" });
    expect(conversationOf(issue({ number: 4 }))).toBeNull();
  });

  test("route numbers", () => {
    expect(issueNumberOf("134")).toBe(134);
    expect(issueNumberOf("0")).toBeNull();
    expect(issueNumberOf("12a")).toBeNull();
    expect(issueNumberOf(undefined)).toBeNull();
  });
});

function artifact(over: Partial<Artifact> & { id: string }): Artifact {
  return {
    kind: "document",
    title: "Doc",
    version: 1,
    channelId: null,
    threadId: null,
    createdBy: { type: "agent", id: "a1" },
    updatedBy: { type: "agent", id: "a1" },
    createdAt: at(60, NOW),
    updatedAt: at(60, NOW),
    canEdit: false,
    untrusted: false,
    ...over,
  };
}

describe("drive", () => {
  test("types by kind and, for uploads, by name", () => {
    const png = artifact({ id: "1", kind: "file", title: "home.png" });
    const pdf = artifact({ id: "2", kind: "file", title: "contrato.pdf" });
    const csv = artifact({ id: "3", kind: "file", title: "vendas.csv" });
    const doc = artifact({ id: "4" });
    const diff = artifact({ id: "5", kind: "diff" });
    const table = artifact({ id: "6", kind: "table" });
    const all = [png, pdf, csv, doc, diff, table];
    const ids = (t: Parameters<typeof matchesType>[1]) => all.filter((a) => matchesType(a, t)).map((a) => a.id);
    expect(ids("all")).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(ids("documents")).toEqual(["2", "4"]);
    expect(ids("images")).toEqual(["1"]);
    expect(ids("tables")).toEqual(["3", "6"]);
    expect(ids("diffs")).toEqual(["5"]);
    expect(cardShape(png)).toBe("image");
    expect(cardShape(pdf)).toBe("file");
    expect(cardShape(artifact({ id: "7", kind: "diagram" }))).toBe("file");
    expect(kindKey(pdf)).toBe("document");
    expect(kindKey(artifact({ id: "8", kind: "file", title: "x.zip" }))).toBe("file");
  });

  test("sections: today, this week, then by month, newest first", () => {
    const list = [
      artifact({ id: "old", updatedAt: new Date(2026, 7, 3, 10).toISOString() }),
      artifact({ id: "today", updatedAt: at(30, NOW) }),
      artifact({ id: "sep2", updatedAt: new Date(2026, 8, 2, 10).toISOString() }),
      artifact({ id: "week", updatedAt: new Date(2026, 9, 14, 10).toISOString() }),
      artifact({ id: "sep1", updatedAt: new Date(2026, 8, 20, 10).toISOString() }),
    ];
    const s = driveSections(list, NOW);
    expect(s.map((x) => [x.key, x.items.map((a) => a.id)])).toEqual([
      ["today", ["today"]],
      ["week", ["week"]],
      ["2026-09", ["sep1", "sep2"]],
      ["2026-08", ["old"]],
    ]);
    expect(s[2]?.label).toEqual({ kind: "month", year: 2026, month: 8 });
    expect(gridRows([1, 2, 3])).toEqual([[1, 2], [3]]);
  });

  test("previews: document, table, diff, file", () => {
    expect(
      cardPreview("T", { kind: "document", markdown: "# Resultado\n\nVendas *subiram*.\n- 12%\n```\ncode\n```\nFim" }),
    ).toEqual({
      kind: "document",
      head: "Resultado",
      lines: ["Vendas subiram.", "12%", "Fim"],
    });
    expect(cardPreview("T", { kind: "document", markdown: "" })).toEqual({ kind: "document", head: "T", lines: [] });
    expect(
      cardPreview("T", {
        kind: "table",
        columns: ["Mês", "Meta", "Real", "Obs"],
        rows: [
          ["Set", "120k", "134k", "x"],
          ["Ago", "110k"],
          ["Jul", "1", "2"],
          ["Jun", "1", "2"],
          ["Mai", "1", "2"],
        ],
      }),
    ).toEqual({
      kind: "table",
      columns: ["Mês", "Meta", "Real"],
      rows: [
        ["Set", "120k", "134k"],
        ["Ago", "110k", ""],
        ["Jul", "1", "2"],
        ["Jun", "1", "2"],
      ],
    });
    const patch =
      "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n ctx\n-if (token) redirect()\n+if (token && !expired)\n+  redirect(next)\n same\n";
    expect(cardPreview("T", { kind: "diff", files: [{ path: "x", patch }] })).toEqual({
      kind: "diff",
      lines: [
        { kind: "del", text: "if (token) redirect()" },
        { kind: "add", text: "if (token && !expired)" },
        { kind: "add", text: "  redirect(next)" },
        { kind: "same", text: "same" },
      ],
    });
    const file = { kind: "file" as const, size: 1, sha256: "" };
    expect(cardPreview("x", { ...file, name: "a.png", contentType: "image/png" })).toEqual({ kind: "image" });
    expect(cardPreview("x", { ...file, name: "contrato.pdf", contentType: "application/pdf" })).toEqual({
      kind: "file",
      ext: "PDF",
    });
    expect(cardPreview("x", { kind: "html", html: "" })).toEqual({ kind: "file", ext: "HTML" });
  });
});
