import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AppNotification } from "../src/api/types";
import { upcomingAt } from "../src/lib/format";
import {
  DONE_MS,
  firstSteps,
  homeDone,
  homeMentions,
  homeWaiting,
  homeWidgetFailures,
  startingOut,
  startPlace,
  stepPermissions,
  upcomingRoutines,
} from "../src/lib/home";

const NOW = new Date(2026, 9, 31, 14, 0).getTime();
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const n = (over: Partial<AppNotification> & Pick<AppNotification, "id" | "kind">): AppNotification => ({
  waiting: false,
  actors: [{ type: "agent", id: "ada" }],
  count: 1,
  source: {},
  latest: {},
  readAt: null,
  doneAt: null,
  snoozedUntil: null,
  createdAt: at(5),
  updatedAt: at(5),
  ...over,
});

describe("what opens when the app starts", () => {
  const mine = (id: string) => id === "c-eng";
  test("the chosen channel while I'm in it, the place this device kept, else the home", () => {
    expect(startPlace(undefined, { last: "/org/o/c/c-eng", inChannel: mine })).toEqual({ kind: "home" });
    expect(startPlace({ page: "home", channelId: null }, { last: "/x", inChannel: mine })).toEqual({ kind: "home" });
    expect(startPlace({ page: "channel", channelId: "c-eng" }, { last: null, inChannel: mine })).toEqual({
      kind: "channel",
      channelId: "c-eng",
    });
    // Left (or archived): the home.
    expect(startPlace({ page: "channel", channelId: "c-old" }, { last: null, inChannel: mine })).toEqual({
      kind: "home",
    });
    expect(startPlace({ page: "last", channelId: null }, { last: "/org/o/wiki", inChannel: mine })).toEqual({
      kind: "last",
      place: "/org/o/wiki",
    });
    // Nowhere kept on this device yet: the home.
    expect(startPlace({ page: "last", channelId: null }, { last: null, inChannel: mine })).toEqual({ kind: "home" });
  });
});

describe("Início's sections", () => {
  test("waiting: what still waits on me, in the inbox's order; snoozed and done ones wait elsewhere", () => {
    const items = [
      n({ id: "approval", kind: "approval", waiting: true, updatedAt: at(1) }),
      n({ id: "question", kind: "agent_question", waiting: true, updatedAt: at(30) }),
      n({ id: "snoozed", kind: "agent_question", waiting: true, snoozedUntil: new Date(NOW + 60_000).toISOString() }),
      n({ id: "done", kind: "approval", waiting: true, doneAt: at(2) }),
      n({ id: "reply", kind: "agent_reply" }),
    ];
    expect(homeWaiting(items, NOW).map((x) => x.id)).toEqual(["question", "approval"]);
  });

  test("mentions: only the unread ones", () => {
    const items = [
      n({ id: "new", kind: "mention", actors: [{ type: "user", id: "joao" }] }),
      n({ id: "read", kind: "mention", readAt: at(1) }),
      n({ id: "dm", kind: "dm" }),
    ];
    expect(homeMentions(items, NOW).map((x) => x.id)).toEqual(["new"]);
  });

  test("done since my last visit: what agents finished that I haven't read, from the last 7 days, newest first", () => {
    const items = [
      n({ id: "mission", kind: "mission_finished", updatedAt: at(120) }),
      n({ id: "routine", kind: "routine_finished", updatedAt: at(10) }),
      n({ id: "answer", kind: "agent_reply", updatedAt: at(60) }),
      n({ id: "task", kind: "issue_status", latest: { statusTo: "done" }, updatedAt: at(30) }),
      n({ id: "moved", kind: "issue_status", latest: { statusTo: "in_review" } }),
      n({ id: "seen", kind: "mission_finished", readAt: at(1) }),
      n({ id: "old", kind: "routine_finished", updatedAt: new Date(NOW - DONE_MS - 60_000).toISOString() }),
      n({ id: "failed", kind: "routine_failed" }),
    ];
    expect(homeDone(items, NOW).map((x) => x.id)).toEqual(["routine", "task", "answer", "mission"]);
  });

  test("coming up: the next runs of active routines, soonest first", () => {
    const r = (id: string, minutes: number | null, active = true) => ({
      id,
      active,
      nextRunAt: minutes === null ? null : new Date(NOW + minutes * 60_000).toISOString(),
    });
    const list = [
      r("later", 600),
      r("soon", 30),
      r("paused", 5, false),
      r("event", null),
      r("past", -5),
      r("next", 90),
    ];
    expect(upcomingRoutines(list, NOW).map((x) => x.id)).toEqual(["soon", "next", "later"]);
    expect(upcomingRoutines(list, NOW, 1).map((x) => x.id)).toEqual(["soon"]);
    // A widget's own routine redoes its widget in place (ADR 0134): never in "Coming up".
    const widget = { ...r("widget", 10), target: { type: "widget" as const, widgetId: "w", dashboardId: "d" } };
    expect(upcomingRoutines([...list, widget], NOW).map((x) => x.id)).toEqual(["soon", "next", "later"]);
  });

  test("widgets that stopped updating wait on me until resolved, newest first (ADR 0134)", () => {
    const list = [
      n({ id: "old", kind: "widget_failed", updatedAt: at(60) }),
      n({ id: "new", kind: "widget_failed", updatedAt: at(5) }),
      n({ id: "done", kind: "widget_failed", updatedAt: at(1), doneAt: at(1) }),
      n({ id: "alert", kind: "widget_alert", waiting: true, updatedAt: at(2) }),
    ];
    expect(homeWidgetFailures(list, NOW).map((x) => x.id)).toEqual(["new", "old"]);
  });

  test("when it comes: today, tomorrow, a day of this week, then the date", () => {
    const t = ((key: string, values: { time: string }) => `${key} ${values.time}`) as unknown as TFunction;
    const now = new Date(NOW);
    const day = (d: number, h: number) => new Date(2026, 9, 31 + d, h, 0).toISOString();
    expect(upcomingAt(t, "pt-BR", day(0, 18), now)).toBe("format.todayAt 18:00");
    expect(upcomingAt(t, "pt-BR", day(1, 9), now)).toBe("format.tomorrowAt 09:00");
    expect(upcomingAt(t, "pt-BR", day(3, 10), now)).toBe("ter 10:00");
    expect(upcomingAt(t, "pt-BR", day(9, 10), now)).toBe("9 nov");
  });
});

describe("a new workspace's first steps", () => {
  const may = { createAgents: true, connectAi: true, talk: true, invite: true, routines: true };
  const none = { agents: 0, hasAi: false, asked: false, people: 1, routines: 0, may };
  test("an AI, a request and a routine wait for an agent; each step shown only to who may take it", () => {
    expect(firstSteps(none)).toEqual([
      { id: "agent", done: false },
      { id: "team", done: false },
    ]);
    expect(firstSteps({ ...none, agents: 2 })).toEqual([
      { id: "agent", done: true },
      { id: "ai", done: false },
      { id: "ask", done: false },
      { id: "team", done: false },
      { id: "routine", done: false },
    ]);
    // A member who owns no agent can't connect an AI (the dialog would send them to someone else): no such step.
    const member = { createAgents: false, connectAi: false, talk: true, invite: false, routines: false };
    expect(firstSteps({ ...none, agents: 2, may: member })).toEqual([{ id: "ask", done: false }]);
    // Owning an agent, they connect its AI.
    expect(firstSteps({ ...none, agents: 2, may: { ...member, connectAi: true } })).toEqual([
      { id: "ai", done: false },
      { id: "ask", done: false },
    ]);
  });

  test("none once every step shown is done", () => {
    expect(firstSteps({ agents: 2, hasAi: true, asked: true, people: 3, routines: 1, may })).toEqual([]);
  });

  test("starting out while an agent, its AI or a first request is to do; a team and a routine can wait for good", () => {
    expect(startingOut(firstSteps(none))).toBe(true);
    expect(startingOut(firstSteps({ ...none, agents: 1, hasAi: true }))).toBe(true);
    // A workspace of one in use for months: invite and routine still open, nothing new about it.
    expect(startingOut(firstSteps({ ...none, agents: 1, hasAi: true, asked: true }))).toBe(false);
    expect(startingOut([])).toBe(false);
  });

  test("who may take each step: their permissions, and an AI for the workspace's key or an agent of their own", () => {
    const agents = [{ ownerUserId: "u-joao" }, { ownerUserId: null }];
    expect(stepPermissions({ permissions: ["read", "talk_to_agents"] }, "u-ana", agents)).toEqual({
      createAgents: false,
      connectAi: false,
      talk: true,
      invite: false,
      routines: false,
    });
    expect(stepPermissions({ permissions: ["read"] }, "u-joao", agents).connectAi).toBe(true);
    expect(stepPermissions({ permissions: ["manage_credentials"] }, "u-ana", agents).connectAi).toBe(true);
    // Before the person loads, an agent with no owner isn't theirs.
    expect(stepPermissions({ permissions: ["read"] }, null, agents).connectAi).toBe(false);
  });
});
