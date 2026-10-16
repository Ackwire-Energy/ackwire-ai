import { describe, expect, test } from "bun:test";
import { layoutTrack, roundLabelBoxes, trackItemAt } from "@agenteschat/ui";
import type { ForumPost, ForumTopic, ForumTopicDetail, ForumTrack } from "@/api/types";
import {
  addAgentSeat,
  convergence,
  deadlineChoices,
  decisionLine,
  filterTopics,
  issuesWithState,
  liveNow,
  moveSeat,
  needsOf,
  nextSeat,
  outOfBudget,
  pendingIssues,
  postsByRound,
  standings,
  statusShown,
  stripStanceHeader,
  tableInput,
  toggleSeat,
  trackGroups,
  turnNow,
} from "@/lib/forum";

const ME = "me";
const A = (id: string) => ({ type: "agent" as const, id });
const P = (id: string) => ({ type: "person" as const, id });

const topic = (over: Partial<ForumTopic> = {}): ForumTopic => ({
  id: "t",
  title: "Migrar a fila?",
  goal: "Decidir",
  status: "open",
  phase: "discussing",
  format: "decision",
  round: 1,
  rounds: 2,
  agentIds: ["a", "b"],
  userIds: [],
  seats: [A("a"), A("b")],
  createdBy: { type: "person", id: "other" },
  origin: {
    kind: "direct",
    channelId: null,
    messageId: null,
    issueId: null,
    issueNumber: null,
    routineId: null,
    agentId: null,
  },
  originChannelId: null,
  responsibleUserId: "other",
  requestedByUserId: null,
  ownerAgentId: null,
  deadline: null,
  waitingUserId: null,
  stall: null,
  reopened: null,
  channelId: "c",
  createdAt: "2026-10-16T09:00:00.000Z",
  lastActivityAt: "2026-10-16T10:00:00.000Z",
  activeAgentIds: [],
  track: { rounds: [], synthesis: null },
  synthesis: null,
  ...over,
});

const entry = (
  seat: { type: "agent" | "person"; id: string },
  status: ForumTrack["rounds"][number]["entries"][number]["status"],
  postId: string | null = null,
  length = 0,
) => ({
  seat,
  status,
  postId,
  length,
});

const post = (id: string, over: Partial<ForumPost>): ForumPost => ({
  id,
  topicId: "t",
  round: 1,
  author: A("a"),
  body: id,
  agentRunId: null,
  kind: "turn",
  stance: null,
  replyTo: null,
  position: null,
  createdAt: "2026-10-16T10:00:00.000Z",
  ...over,
});

const at = (m: number) => new Date(Date.UTC(2026, 9, 16, 10, m)).toISOString();

describe("forum lists", () => {
  test("Em discussão holds open and stalled; Concluídos done and canceled; Meus what I'm in", () => {
    const list = [
      topic({ id: "open" }),
      topic({ id: "stalled", status: "stalled" }),
      topic({ id: "done", status: "done", responsibleUserId: ME }),
      topic({ id: "canceled", status: "canceled", userIds: [ME] }),
      topic({ id: "asked", requestedByUserId: ME }),
      topic({ id: "seated", seats: [A("a"), P(ME)] }),
    ];
    expect(filterTopics(list, "open", ME).map((t) => t.id)).toEqual(["open", "stalled", "asked", "seated"]);
    expect(filterTopics(list, "done", ME).map((t) => t.id)).toEqual(["done", "canceled"]);
    expect(filterTopics(list, "mine", ME).map((t) => t.id)).toEqual(["done", "canceled", "asked", "seated"]);
  });

  test("status shown: reopened while it goes on after a new round from a comment", () => {
    expect(statusShown(topic({ reopened: { byUserId: ME, at: at(1) } }))).toBe("reopened");
    expect(statusShown(topic({ status: "stalled", reopened: { byUserId: ME, at: at(1) } }))).toBe("stalled");
    expect(statusShown(topic({ status: "done" }))).toBe("done");
  });

  test("the decision line: the decision, or the plan's objective", () => {
    const plan = topic({
      synthesis: {
        artifactId: null,
        version: 1,
        revision: 1,
        format: "plan",
        suggestedIssues: [],
        structured: {
          format: "plan",
          objective: "Captar lead pelo LinkedIn",
          summaryForRequester: "",
          inScope: [],
          outOfScope: [],
          steps: [],
          risks: [],
          metrics: [],
          openQuestions: [],
          suggestedIssues: [],
          changes: [],
        },
        versions: [],
        createdIssues: [],
      },
    });
    expect(decisionLine(plan)).toBe("Captar lead pelo LinkedIn");
    expect(decisionLine(topic())).toBeNull();
  });
});

describe("Precisa de você", () => {
  test("my seated turn, issues to approve, a stalled topic of mine, an agent out of budget", () => {
    const turn = topic({ phase: "waiting_person", waitingUserId: ME });
    expect(needsOf(turn, ME)?.kind).toBe("turn");
    const issues = topic({
      status: "done",
      responsibleUserId: ME,
      synthesis: {
        artifactId: "art",
        version: 1,
        revision: 1,
        format: "decision",
        suggestedIssues: [
          { title: "Flag no schema", description: "" },
          { title: "Alerta de conexões", description: "" },
        ],
        structured: null,
        versions: [],
        createdIssues: [{ id: "i1", number: 141, title: "flag no schema" }],
      },
    });
    expect(needsOf(issues, ME)).toEqual({ kind: "issues", topic: issues, count: 1 });
    expect(needsOf(topic({ status: "stalled", userIds: [ME] }), ME)?.kind).toBe("stalled");
    const broke = topic({
      round: 2,
      responsibleUserId: ME,
      track: {
        rounds: [
          { round: 1, personPosts: [], entries: [entry(A("a"), "skipped_budget"), entry(A("b"), "spoke", "p", 10)] },
          { round: 2, personPosts: [], entries: [entry(A("a"), "pending"), entry(A("b"), "spoke", "q", 10)] },
        ],
        synthesis: null,
      },
    });
    expect(outOfBudget(broke)).toEqual(["a"]);
    expect(needsOf(broke, ME)).toEqual({ kind: "budget", topic: broke, agentId: "a" });
    // Not mine: nothing waits on me (only a seated turn would).
    expect(needsOf({ ...broke, responsibleUserId: "other" }, ME)).toBeNull();
    expect(liveNow([turn, topic({ id: "x" })], ME).map((t) => t.id)).toEqual(["x"]);
  });

  test("issues approved are matched by title (case aside)", () => {
    const s = {
      suggestedIssues: [
        { title: "A", description: "" },
        { title: "B", description: "" },
      ],
      createdIssues: [{ id: "1", number: 7, title: "a" }],
    };
    expect(pendingIssues(s).map((i) => i.title)).toEqual(["B"]);
    expect(issuesWithState(s).map((x) => x.created?.number ?? null)).toEqual([7, null]);
    expect(pendingIssues(null)).toEqual([]);
  });
});

describe("turns", () => {
  test("who speaks now and who is next, with a seated person at the table", () => {
    const seats = [A("a"), A("b"), P(ME)];
    const t1 = topic({
      seats,
      track: {
        rounds: [
          {
            round: 1,
            personPosts: [],
            entries: [entry(A("a"), "spoke", "p1", 50), entry(A("b"), "live"), entry(P(ME), "pending")],
          },
          {
            round: 2,
            personPosts: [],
            entries: [entry(A("a"), "pending"), entry(A("b"), "pending"), entry(P(ME), "pending")],
          },
        ],
        synthesis: null,
      },
    });
    expect(turnNow(t1)).toEqual({ kind: "agent", agentId: "b", round: 1, writing: true });
    expect(nextSeat(t1)).toEqual(P(ME));
    const t2 = topic({
      seats,
      phase: "waiting_person",
      waitingUserId: ME,
      track: {
        rounds: [
          {
            round: 1,
            personPosts: [],
            entries: [entry(A("a"), "spoke", "p1", 50), entry(A("b"), "spoke", "p2", 50), entry(P(ME), "waiting")],
          },
          {
            round: 2,
            personPosts: [],
            entries: [entry(A("a"), "pending"), entry(A("b"), "pending"), entry(P(ME), "pending")],
          },
        ],
        synthesis: null,
      },
    });
    expect(turnNow(t2)).toEqual({ kind: "person", userId: ME, round: 1 });
    expect(nextSeat(t2)).toEqual(A("a"));
    // The server runs it but nothing streams yet: reading the discussion.
    const t3 = topic({
      activeAgentIds: ["a"],
      track: {
        rounds: [{ round: 1, personPosts: [], entries: [entry(A("a"), "pending"), entry(A("b"), "pending")] }],
        synthesis: null,
      },
    });
    expect(turnNow(t3)).toEqual({ kind: "agent", agentId: "a", round: 1, writing: false });
    expect(nextSeat(t3)).toEqual(A("b"));
    expect(
      turnNow(
        topic({
          status: "stalled",
          stall: { reason: "stopped", byUserId: ME, agentId: "b", round: 1, synthesis: false, at: at(0) },
        }),
      ),
    ).toEqual({
      kind: "stalled",
      agentId: "b",
      round: 1,
      synthesis: false,
    });
    expect(turnNow(topic({ phase: "synthesizing" }))).toEqual({ kind: "synthesis", agentId: "a", round: 1 });
    expect(turnNow(topic({ status: "done" }))).toBeNull();
  });
});

describe("the round track", () => {
  const look = (id: string) => (id === "a" ? { color: "amber", eyes: "round" } : { color: "teal" });
  test("spoken turns, budget skips, people's posts leading a round, the live turn, turns to come", () => {
    const t = topic({
      round: 2,
      track: {
        rounds: [
          { round: 1, personPosts: [], entries: [entry(A("a"), "spoke", "p1", 100), entry(A("b"), "skipped_budget")] },
          {
            round: 2,
            personPosts: [{ userId: ME, postId: "f1", length: 40 }],
            entries: [entry(A("a"), "live"), entry(A("b"), "pending")],
          },
        ],
        synthesis: null,
      },
    });
    const groups = trackGroups(t, look);
    expect(groups.map((g) => g.items.map((i) => i.kind))).toEqual([
      ["spoke", "budget"],
      ["person", "live", "pending"],
    ]);
    expect(groups[0]?.items[0]).toMatchObject({ agentId: "a", color: "amber", postId: "p1", length: 100 });
    expect(groups[1]?.items[0]).toMatchObject({ userId: ME, postId: "f1" });
  });

  test("the synthesis closes a concluded topic; the turn that stopped sleeps", () => {
    const done = topic({
      status: "done",
      round: 1,
      track: {
        rounds: [
          { round: 1, personPosts: [], entries: [entry(A("a"), "spoke", "p1", 10), entry(A("b"), "spoke", "p2", 10)] },
        ],
        synthesis: { agentId: "a", status: "done", revision: 1 },
      },
    });
    expect(trackGroups(done, look)[0]?.items.at(-1)).toMatchObject({
      kind: "synthesis",
      synthesis: true,
      agentId: "a",
    });
    const stalled = topic({
      status: "stalled",
      stall: { reason: "stopped", byUserId: ME, agentId: "b", round: 1, synthesis: false, at: at(0) },
      track: {
        rounds: [{ round: 1, personPosts: [], entries: [entry(A("a"), "spoke", "p1", 10), entry(A("b"), "stopped")] }],
        synthesis: null,
      },
    });
    expect(trackGroups(stalled, look)[0]?.items.map((i) => i.kind)).toEqual(["spoke", "sleep"]);
    // A concluded topic shows only the rounds it had.
    expect(trackGroups({ ...done, rounds: 3 }, look)).toHaveLength(1);
  });

  test("layout: columns side by side, a wider gap between rounds; a click finds the column", () => {
    const L = layoutTrack(
      [
        {
          round: 1,
          items: [
            { kind: "spoke", round: 1, postId: "p1", length: 10 },
            { kind: "budget", round: 1, postId: null, length: 0 },
          ],
        },
        {
          round: 2,
          items: [
            { kind: "person", round: 2, postId: "f1", length: 4 },
            { kind: "live", round: 2, postId: null, length: 0 },
            { kind: "pending", round: 2, postId: null, length: 0 },
          ],
        },
      ],
      "mini",
    );
    expect(L.groups.map((g) => g.items.map((i) => [i.x, i.w]))).toEqual([
      [
        [0, 3],
        [4, 3],
      ],
      [
        [11, 2],
        [14, 9],
        [24, 3],
      ],
    ]);
    expect(L.width).toBe(28);
    expect(trackItemAt(L, 15)?.kind).toBe("live");
    expect(trackItemAt(L, 9.9)).toBeNull();
    expect(roundLabelBoxes(L)[0]).toEqual({ round: 1, left: 0, width: 25, narrow: true });
  });
});

describe("posts and positions", () => {
  test("by round: a person's post leads the round after it; comments after the synthesis apart", () => {
    const t = {
      round: 2,
      track: {
        rounds: [
          { round: 1, personPosts: [], entries: [] },
          { round: 2, personPosts: [{ userId: ME, postId: "f1", length: 2 }], entries: [] },
        ],
        synthesis: null,
      },
      posts: [
        post("c1", { kind: "comment", round: 2, author: P(ME), createdAt: at(5) }),
        post("p2", { round: 2, createdAt: at(3) }),
        post("s1", { kind: "synthesis", round: 2, createdAt: at(4) }),
        post("f1", { kind: "free", round: 1, author: P(ME), createdAt: at(2) }),
        post("p1", { round: 1, createdAt: at(1) }),
      ],
    };
    const { rounds, comments } = postsByRound(t);
    expect(rounds.map((r) => [r.round, r.posts.map((p) => p.id)])).toEqual([
      [1, ["p1"]],
      [2, ["f1", "p2"]],
    ]);
    expect(comments.map((p) => p.id)).toEqual(["c1"]);
  });

  test("where each one stands: one cell per round, the live one flickers; convergence counts the latest stance", () => {
    const t: ForumTopicDetail = {
      ...topic({
        round: 2,
        track: {
          rounds: [
            {
              round: 1,
              personPosts: [],
              entries: [entry(A("a"), "spoke", "a1", 10), entry(A("b"), "spoke", "b1", 10)],
            },
            { round: 2, personPosts: [], entries: [entry(A("a"), "spoke", "a2", 10), entry(A("b"), "live")] },
          ],
          synthesis: null,
        },
      }),
      posts: [
        post("a1", { stance: { kind: "propose" }, position: "Trocar o polling", createdAt: at(1) }),
        post("b1", {
          author: A("b"),
          stance: { kind: "disagree", target: { type: "agent", id: "a" } },
          createdAt: at(2),
        }),
        post("a2", { round: 2, stance: { kind: "agree", target: { type: "agent", id: "b" } }, createdAt: at(3) }),
      ],
      syntheses: [],
    };
    expect(standings(t).map((s) => [s.agentId, s.lane, s.last?.id ?? null])).toEqual([
      ["a", [0, 0], "a2"],
      ["b", [2, "live"], "b1"],
    ]);
    expect(convergence(t)).toEqual({ agree: ["a"], askers: [], total: 2 });
  });

  test("the streaming text loses the stance header, even while it arrives", () => {
    expect(stripStanceHeader("Stance: agrees @ada\nPosition: Trocar o polling\n\nConcordo.")).toBe("Concordo.");
    expect(stripStanceHeader("Stan")).toBe("");
    expect(stripStanceHeader("Stance: agrees @ad")).toBe("");
    expect(stripStanceHeader("Sim, concordo")).toBe("Sim, concordo");
  });
});

describe("new topic", () => {
  test("the table: move, add an agent after the agents, sit a person down; the input", () => {
    expect(moveSeat([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveSeat([1, 2, 3], 0, 5)).toEqual([1, 2, 3]);
    expect(addAgentSeat([A("x"), P(ME)], "y")).toEqual([A("x"), A("y"), P(ME)]);
    expect(addAgentSeat([A("x")], "x")).toEqual([A("x")]);
    expect(toggleSeat([A("x")], ME)).toEqual([A("x"), P(ME)]);
    expect(toggleSeat([A("x"), P(ME)], ME)).toEqual([A("x")]);
    expect(tableInput([A("x"), P(ME), A("y")])).toEqual({ agentIds: ["x", "y"], seats: [A("x"), P(ME), A("y")] });
    expect(tableInput([A("x"), A("y")])).toEqual({ agentIds: ["x", "y"] });
  });

  test("deadline presets at 18:00: today only before 17:00, Friday when it isn't tomorrow", () => {
    const friday = deadlineChoices(new Date(2026, 9, 16, 10, 0));
    expect(friday.map((d) => d.key)).toEqual(["none", "today", "tomorrow", "friday"]);
    expect(friday[1]?.at?.getHours()).toBe(18);
    expect(friday[3]?.at?.getDate()).toBe(23);
    const thursdayEvening = deadlineChoices(new Date(2026, 9, 15, 18, 0));
    expect(thursdayEvening.map((d) => d.key)).toEqual(["none", "tomorrow"]);
  });
});
