import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { keys } from "../src/api/keys";
import type { BrowserHandoff, ComputerSetup } from "../src/api/types";
import { screenSteps, usesScreen } from "../src/browser";
import {
  type AgentComputerFacts,
  askLine,
  type EntryWords,
  entryButton,
  entryKind,
  entryLine,
  entryPortrait,
  entryState,
  liveSubLine,
  surfaceOf,
} from "../src/lib/agent-computer";
import {
  computerEdition,
  etaLine,
  etaView,
  promisesEmail,
  setupEta,
  setupView,
  WORKSPACE_COMPUTER_KIND,
} from "../src/lib/computer";
import { clockAt } from "../src/lib/format";
import { applyWorkspaceEvent } from "../src/realtime/machines";
import type { LiveWork } from "../src/realtime/streams";

/** The key and its values, so a test sees which words were picked (the words themselves: packages/i18n). */
const t = ((key: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length > 0 ? `${key} ${JSON.stringify(o)}` : key) as unknown as TFunction;

const NOW = Date.parse("2026-10-24T21:05:00.000Z");

const external = (patch: Partial<ComputerSetup> = {}): ComputerSetup => ({
  mode: "external",
  state: "preparing",
  step: "installing",
  reason: null,
  since: "2026-10-24T21:00:00.000Z",
  requestedAt: "2026-10-24T21:04:30.000Z",
  expectedReadyAt: null,
  secondsLeft: null,
  secondsWaited: 30,
  notifyByEmail: true,
  specs: null,
  machineId: null,
  ...patch,
});

const request = (over: Partial<BrowserHandoff> = {}): BrowserHandoff => ({
  id: "h1",
  agentId: "desk",
  runId: "r1",
  machineId: "m1",
  screen: "browser",
  kind: "ask",
  instructions: "Sign in to gov.br",
  status: "pending",
  requestedForUserId: null,
  controllerUserId: null,
  note: null,
  expiresAt: new Date(NOW + 4 * 60_000).toISOString(),
  createdAt: new Date(NOW - 60_000).toISOString(),
  resolvedAt: null,
  ...over,
});

const MAC = { name: "Mac mini", online: true, lastSeenAt: "2026-10-24T21:00:00.000Z", paused: null };

/** Desk on a self-host Mac mini, its browser ready, nothing going on. */
const facts = (over: Partial<AgentComputerFacts> = {}): AgentComputerFacts => ({
  edition: "selfhost",
  held: false,
  setup: null,
  machine: MAC,
  desktop: { available: true, reason: null },
  browser: true,
  browserGranted: true,
  handoff: null,
  userId: "me",
  working: false,
  ...over,
});

const preparing = (patch: Partial<ComputerSetup> = {}) =>
  facts({ edition: "cloud", setup: setupView(external(patch), NOW), machine: null, desktop: null, browser: false });

describe("the edition: which words the computers get", () => {
  test("the Cloud where a provisioner prepares each workspace's computer, self-host where people pair theirs", () => {
    expect(computerEdition(external())).toBe("cloud");
    expect(computerEdition({ ...external(), mode: "pair" })).toBe("selfhost");
    // Loading: no edition's words yet.
    expect(computerEdition(undefined)).toBeNull();
    expect(computerEdition(null)).toBeNull();
    // Before a workspace exists, the server says whether each gets its own; a workspace's setup says for it.
    expect(computerEdition(undefined, true)).toBe("cloud");
    expect(computerEdition(null, false)).toBe("selfhost");
    expect(computerEdition({ ...external(), mode: "pair" }, true)).toBe("selfhost");
  });
});

describe("the time left", () => {
  test("from the server's seconds left less the seconds since its answer came, never the device's clock", () => {
    // Six minutes, rounded up, when it came; the person's clock is whatever it is.
    expect(etaView(330, NOW, NOW)).toEqual({ kind: "minutes", count: 6 });
    expect(etaView(330, NOW, NOW + 30_000)).toEqual({ kind: "minutes", count: 5 });
    expect(etaView(60, NOW, NOW)).toEqual({ kind: "minutes", count: 1 });
    expect(etaView(59, NOW, NOW)).toEqual({ kind: "underMinute" });
    expect(etaView(15, NOW, NOW)).toEqual({ kind: "underMinute" });
    expect(etaView(14, NOW, NOW)).toEqual({ kind: "almost" });
    // Up to a minute past the time it is still almost ready; past that, a little longer.
    expect(etaView(-60, NOW, NOW)).toEqual({ kind: "almost" });
    expect(etaView(30, NOW, NOW + 91_000)).toEqual({ kind: "late" });
    expect(etaView(-61, NOW, NOW)).toEqual({ kind: "late" });
    // A device clock behind the answer counts no time back.
    expect(etaView(120, NOW, NOW - 600_000)).toEqual({ kind: "minutes", count: 2 });
    // No time said: no line.
    expect(etaView(null, NOW, NOW)).toBeNull();
  });

  test("only while it is being prepared, and its words", () => {
    expect(setupEta(setupView(external({ secondsLeft: 330 }), NOW) as never, NOW)).toEqual({
      kind: "minutes",
      count: 6,
    });
    expect(setupEta(setupView(external({ state: "waiting", secondsLeft: 330 }), NOW) as never, NOW)).toBeNull();
    expect(setupEta(setupView(external({ state: "problem", secondsLeft: 330 }), NOW) as never, NOW)).toBeNull();
    expect(etaLine(t, { kind: "minutes", count: 6 })).toBe('computerSetup.eta.minutes {"count":6}');
    expect(etaLine(t, { kind: "underMinute" })).toBe("computerSetup.eta.underMinute");
    expect(etaLine(t, { kind: "almost" })).toBe("computerSetup.eta.almost");
    expect(etaLine(t, { kind: "late" })).toBe("computerSetup.eta.late");
  });
});

describe("we'll email you", () => {
  const view = (patch: Partial<ComputerSetup>) =>
    setupView(external(patch), NOW) as NonNullable<ReturnType<typeof setupView>>;

  test("when the server sends email and the wait is or will be over a minute", () => {
    // More than a minute left when it answered.
    expect(promisesEmail(view({ secondsLeft: 61 }), NOW)).toBe(true);
    expect(promisesEmail(view({ secondsLeft: 60 }), NOW)).toBe(false);
    // Waiting for capacity, or a problem: the email is certain.
    expect(promisesEmail(view({ state: "waiting" }), NOW)).toBe(true);
    expect(promisesEmail(view({ state: "problem" }), NOW)).toBe(true);
    // No time said: only once a minute has gone since people started waiting (30 s at the answer here).
    expect(promisesEmail(view({}), NOW)).toBe(false);
    expect(promisesEmail(view({}), NOW + 31_000)).toBe(true);
    // Never without an email sender, never once ready.
    expect(promisesEmail(view({ state: "waiting", notifyByEmail: false }), NOW)).toBe(false);
    expect(promisesEmail(view({ state: "ready" }), NOW)).toBe(false);
  });

  test("the wait is the server's own count of seconds, whatever this device's clock says", () => {
    // People started waiting at 20:54 by the server's word, but the server counted 20 s: this device's clock is
    // off, and the minute isn't up.
    const early = view({ requestedAt: "2026-10-24T20:54:00.000Z", secondsWaited: 20 });
    expect(early.waited).toBe(20);
    expect(promisesEmail(early, NOW)).toBe(false);
    expect(promisesEmail(early, NOW + 41_000)).toBe(true);
    // And the other way: a `requestedAt` ahead of this device's clock, 90 s by the server's.
    const late = view({ requestedAt: "2026-10-24T21:30:00.000Z", secondsWaited: 90 });
    expect(promisesEmail(late, NOW)).toBe(true);
    // A server that doesn't count: no promise from the wait alone.
    const unknown = view({ secondsWaited: null });
    expect(unknown.waited).toBeNull();
    expect(promisesEmail(unknown, NOW + 3_600_000)).toBe(false);
  });

  test("an event keeps whether the server sends email when it doesn't say", () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.computerSetup("o1"), external({ notifyByEmail: true }));
    applyWorkspaceEvent(qc, "o1", {
      type: "machine.provisioning",
      state: "preparing",
      secondsLeft: 300,
      secondsWaited: 75,
    } as {
      type: string;
    });
    expect(qc.getQueryData<ComputerSetup>(keys.computerSetup("o1"))).toMatchObject({
      notifyByEmail: true,
      secondsLeft: 300,
      secondsWaited: 75,
    });
    applyWorkspaceEvent(qc, "o1", { type: "machine.provisioning", state: "preparing", notifyByEmail: false } as {
      type: string;
    });
    expect(qc.getQueryData<ComputerSetup>(keys.computerSetup("o1"))?.notifyByEmail).toBe(false);
  });
});

describe("the entry's status line, first match wins", () => {
  test("a hold wins over everything, the wait included", () => {
    expect(entryState(facts({ held: true }), NOW)).toEqual({ kind: "held" });
    expect(entryState({ ...preparing({ secondsLeft: 330 }), held: true }, NOW)).toEqual({ kind: "held" });
    expect(entryState(facts({ held: true, handoff: request() }), NOW)).toEqual({ kind: "held" });
  });

  test("the Cloud's wait: the time left, almost ready, or no time; longer than usual; a problem", () => {
    expect(entryState(preparing({ secondsLeft: 330 }), NOW)).toEqual({
      kind: "preparing",
      eta: { kind: "minutes", count: 6 },
    });
    expect(entryState(preparing({ secondsLeft: 10 }), NOW)).toEqual({ kind: "preparing", eta: { kind: "almost" } });
    expect(entryState(preparing({}), NOW)).toEqual({ kind: "preparing", eta: null });
    expect(entryState(preparing({ state: "waiting", reason: "capacity" }), NOW)).toEqual({ kind: "slow" });
    expect(entryState(preparing({ state: "problem" }), NOW)).toEqual({ kind: "problem" });
    // Ready, and the agent on it: no wait any more.
    const ready = { ...preparing({ state: "ready" }), machine: MAC, desktop: { available: true, reason: null } };
    expect(entryState(ready, NOW)).toEqual({ kind: "available" });
  });

  test("its computer offline, then paused on the computer itself (self-host)", () => {
    expect(entryState(facts({ machine: { ...MAC, online: false } }), NOW)).toEqual({ kind: "offline" });
    const until = new Date(NOW + 3_600_000).toISOString();
    expect(entryState(facts({ machine: { ...MAC, paused: { until } } }), NOW)).toEqual({ kind: "paused", until });
    // The Cloud's computer is never paused by a person.
    expect(entryState(facts({ edition: "cloud", machine: { ...MAC, paused: { until } } }), NOW)).toEqual({
      kind: "available",
    });
  });

  test("a request for this person, or for nobody in particular, needs them; one for someone else names them", () => {
    expect(entryState(facts({ handoff: request() }), NOW)).toMatchObject({ kind: "needsYou" });
    expect(entryState(facts({ handoff: request({ requestedForUserId: "me" }) }), NOW)).toMatchObject({
      kind: "needsYou",
    });
    expect(entryState(facts({ handoff: request({ requestedForUserId: "ana" }) }), NOW)).toMatchObject({
      kind: "needsOther",
      userId: "ana",
    });
    // Expired: nobody is waited for.
    expect(entryState(facts({ handoff: request({ expiresAt: new Date(NOW - 1).toISOString() }) }), NOW)).toEqual({
      kind: "available",
    });
  });

  test("whoever holds control, then the agent at work", () => {
    const active = request({ status: "active", controllerUserId: "me", expiresAt: null });
    expect(entryState(facts({ handoff: active }), NOW)).toEqual({ kind: "you" });
    expect(entryState(facts({ handoff: { ...active, controllerUserId: "ana" } }), NOW)).toEqual({
      kind: "other",
      userId: "ana",
    });
    expect(entryState(facts({ working: true }), NOW)).toEqual({ kind: "working" });
  });

  test("why nothing can show: the screen can't, it uses neither, no computer yet; else available", () => {
    const blocked = { desktop: { available: false, reason: "not_allowed" }, browser: false };
    expect(entryState(facts(blocked), NOW)).toEqual({ kind: "unavailable", outdated: false });
    expect(entryState(facts({ ...blocked, desktop: { available: false, reason: "runner_outdated" } }), NOW)).toEqual({
      kind: "unavailable",
      outdated: true,
    });
    // A Mac has no screens: its browser's page shows, so it is available.
    expect(entryState(facts({ desktop: { available: false, reason: "desktop_unavailable" } }), NOW)).toEqual({
      kind: "available",
    });
    expect(
      entryState(facts({ desktop: { available: false, reason: "no_desktop" }, browserGranted: false }), NOW),
    ).toEqual({ kind: "noScreen" });
    expect(entryState(facts({ machine: null, desktop: { available: false, reason: "no_computer" } }), NOW)).toEqual({
      kind: "noComputer",
    });
    expect(entryState(facts(), NOW)).toEqual({ kind: "available" });
  });

  test("its one button: Help on a request for this person, a picker for no computer, else Open", () => {
    expect(entryButton({ kind: "needsYou", handoff: request() })).toBe("help");
    expect(entryButton({ kind: "needsOther", handoff: request(), userId: "ana" })).toBe("open");
    expect(entryButton({ kind: "noComputer" })).toBe("choose");
    expect(entryButton({ kind: "held" })).toBe("open");
  });

  test("its words, by edition", () => {
    const w: EntryWords = {
      edition: "cloud",
      locale: "en",
      computer: "Oficina's computer",
      lastSeenAt: "2026-10-24T14:05:00.000Z",
      person: (id: string) => (id === "ana" ? "Ana" : "?"),
      step: null,
      emailPromised: false,
      now: new Date(NOW),
    };
    const line = (s: Parameters<typeof entryLine>[1], over: Partial<EntryWords> = {}) =>
      entryLine(t, s, { ...w, ...over });
    expect(line({ kind: "held" })).toBe("agentComputer.status.held");
    expect(line({ kind: "preparing", eta: { kind: "minutes", count: 6 } })).toBe(
      'agentComputer.status.preparing {"count":6}',
    );
    expect(line({ kind: "preparing", eta: { kind: "underMinute" } })).toBe("agentComputer.status.preparingSoon");
    expect(line({ kind: "preparing", eta: { kind: "late" } })).toBe("agentComputer.status.preparingPlain");
    expect(line({ kind: "preparing", eta: null })).toBe("agentComputer.status.preparingPlain");
    // "We'll email you" only where it was promised (owners).
    expect(line({ kind: "slow" })).toBe("agentComputer.status.slowPlain");
    expect(line({ kind: "slow" }, { emailPromised: true })).toBe("agentComputer.status.slow");
    expect(line({ kind: "problem" })).toBe("agentComputer.status.problem");
    // The Cloud's computer isn't answering; a self-hoster's is offline since a time.
    expect(line({ kind: "offline" })).toBe("agentComputer.status.notAnswering");
    expect(line({ kind: "offline" }, { edition: "selfhost" })).toBe(
      `agentComputer.status.offline {"time":"${clockAt("en", w.lastSeenAt ?? "", new Date(NOW))}"}`,
    );
    expect(line({ kind: "offline" }, { edition: "selfhost", lastSeenAt: null })).toBe("machines.offline");
    expect(line({ kind: "paused", until: null }, { edition: "selfhost", computer: "Mac mini" })).toBe(
      'agentComputer.status.pausedPlain {"computer":"Mac mini"}',
    );
    expect(line({ kind: "needsYou", handoff: request() })).toBe(
      `agentComputer.status.needsYou {"ask":"Sign in to gov.br · browser.card.leftShort {\\"count\\":4}"}`,
    );
    expect(line({ kind: "needsOther", handoff: request(), userId: "ana" })).toContain(
      'agentComputer.status.needsOther {"person":"Ana"',
    );
    expect(line({ kind: "you" })).toBe("agentComputer.status.you");
    expect(line({ kind: "other", userId: "ana" })).toBe('agentComputer.status.other {"person":"Ana"}');
    expect(line({ kind: "working" })).toBe("agentComputer.status.workingPlain");
    expect(line({ kind: "working" }, { step: "filled in a field" })).toBe(
      'agentComputer.status.working {"now":"filled in a field"}',
    );
    // The step as the run card says it, after the "·" in lower case.
    expect(line({ kind: "working" }, { step: "Filled in a field" })).toBe(
      'agentComputer.status.working {"now":"filled in a field"}',
    );
    expect(line({ kind: "unavailable", outdated: true })).toBe("agentComputer.status.unavailable");
    expect(line({ kind: "unavailable", outdated: true }, { edition: "selfhost", computer: "Mac mini" })).toBe(
      'agentComputer.status.outdated {"computer":"Mac mini"}',
    );
    expect(line({ kind: "noScreen" })).toBe("agentComputer.status.noScreen");
    expect(line({ kind: "noComputer" })).toBe("agentComputer.status.noComputer");
    expect(line({ kind: "available" })).toBe("agentComputer.status.available");
    // A request with no deadline says only what it asks.
    expect(askLine(t, request({ expiresAt: null }), NOW)).toBe("Sign in to gov.br");
  });

  test("its portrait: the workspace's computer drawn as a server, its light by the state", () => {
    expect(entryKind("cloud", null)).toBe(WORKSPACE_COMPUTER_KIND);
    expect(entryKind("selfhost", { kind: "managed", os: "other" })).toBe(WORKSPACE_COMPUTER_KIND);
    expect(entryKind("selfhost", { kind: "connected", os: "darwin" })).toBe("mac");
    expect(entryPortrait({ kind: "preparing", eta: null }, null)).toBe("paused");
    expect(entryPortrait({ kind: "problem" }, setupView(external({ state: "problem" }), NOW))).toBe("offline");
    expect(entryPortrait({ kind: "offline" }, null)).toBe("offline");
    expect(entryPortrait({ kind: "held" }, null)).toBe("paused");
    expect(entryPortrait({ kind: "paused", until: null }, null)).toBe("paused");
    expect(entryPortrait({ kind: "working" }, null)).toBe("online");
  });
});

describe("the dialog's sub-line while its stage is live", () => {
  const w = { name: "Desk", computer: "Mac mini", person: (id: string) => (id === "ana" ? "Ana" : "?"), nowMs: NOW };
  const active = (over: Partial<BrowserHandoff> = {}) =>
    request({ status: "active", controllerUserId: "me", expiresAt: null, ...over });

  test("who holds it first, then the hold, the pause on the computer, a request, the agent at work", () => {
    expect(liveSubLine(t, facts(), w)).toBe("agentComputer.sub.watching");
    expect(liveSubLine(t, facts({ working: true }), w)).toContain("agentComputer.sub.working ");
    expect(liveSubLine(t, facts({ working: true, handoff: request() }), w)).toContain("agentComputer.sub.needsYou ");
    expect(liveSubLine(t, facts({ handoff: request({ requestedForUserId: "ana" }) }), w)).toContain(
      'agentComputer.sub.askedOther {"name":"Desk"',
    );
    const paused = { ...MAC, paused: { until: new Date(NOW + 600_000).toISOString() } };
    expect(liveSubLine(t, facts({ machine: paused, handoff: request() }), w)).toBe(
      'agentComputer.sub.paused {"computer":"Mac mini"}',
    );
    // A pause on the computer is self-host's: the Cloud's computer has none.
    expect(liveSubLine(t, facts({ edition: "cloud", machine: paused }), w)).toBe("agentComputer.sub.watching");
    expect(liveSubLine(t, facts({ held: true, machine: paused, handoff: request() }), w)).toBe(
      "agentComputer.sub.held",
    );
    // In control: mine (a take over, or the agent's own request), or someone else's, its screen hidden.
    expect(liveSubLine(t, facts({ held: true, handoff: active({ kind: "takeover" }) }), w)).toContain(
      "desktop.sub.control ",
    );
    expect(liveSubLine(t, facts({ handoff: active() }), w)).toContain("desktop.sub.controlAsked ");
    expect(liveSubLine(t, facts({ handoff: active({ controllerUserId: "ana" }) }), w)).toBe(
      'desktop.sub.hidden {"person":"Ana"}',
    );
  });
});

describe("what the dialog's stage shows", () => {
  test("held with no ready computer, then the wait, then the page while this person holds the browser", () => {
    expect(surfaceOf({ ...preparing(), held: true })).toBe("held");
    expect(surfaceOf(preparing())).toBe("preparing");
    const mine = request({ status: "active", controllerUserId: "me", expiresAt: null });
    expect(surfaceOf(facts({ handoff: mine }))).toBe("page");
    // Held with a ready computer: the screen, under the pause's banner.
    expect(surfaceOf(facts({ held: true }))).toBe("screen");
  });

  test("the screen where the computer serves screens; else the page; else a cover", () => {
    expect(surfaceOf(facts())).toBe("screen");
    // Someone helping on the screen itself stays on the screen.
    const onScreen = request({ screen: "desktop", status: "active", controllerUserId: "me", expiresAt: null });
    expect(surfaceOf(facts({ handoff: onScreen }))).toBe("screen");
    // A Mac: no screens, the agent's page.
    expect(surfaceOf(facts({ desktop: { available: false, reason: "desktop_unavailable" } }))).toBe("page");
    expect(surfaceOf(facts({ desktop: { available: false, reason: "offline" }, browser: false }))).toBe("cover");
    // Offline, the browser it last reported is no page to show: its cover says it isn't answering.
    const offline = { name: "Oficina's computer", online: false, lastSeenAt: null, paused: null };
    expect(surfaceOf(facts({ machine: offline, desktop: { available: false, reason: "offline" } }))).toBe("cover");
    expect(surfaceOf(facts({ machine: null, desktop: null, browser: false }))).toBe("cover");
  });
});

describe("the agent at work on its computer", () => {
  const call = (id: string, tool: string, detail: string | null, running: boolean, since?: number): LiveWork => ({
    kind: "call",
    id,
    tool,
    connector: null,
    detail,
    code: null,
    output: [],
    running,
    ...(since === undefined ? {} : { since }),
  });
  const work: LiveWork[] = [
    call("c1", "browser_open", "loja.exemplo", false),
    { kind: "text", id: "t1", text: "…" } as never,
    call("c2", "mcp__agentes__desktop_click", null, true, 5),
  ];

  test("its steps on both screens, in order, without the bridge's prefix", () => {
    expect(screenSteps(work)).toEqual([
      { id: "c1", tool: "browser_open", detail: "loja.exemplo", running: false, screen: "browser" },
      { id: "c2", tool: "desktop_click", detail: null, running: true, since: 5, screen: "desktop" },
    ]);
    expect(screenSteps(undefined)).toEqual([]);
  });

  test("it works on its computer while its current tool or its latest call is on a screen", () => {
    expect(usesScreen({ work })).toBe(true);
    expect(usesScreen({ tool: "browser_click" })).toBe(true);
    expect(usesScreen({ work: [...work, call("c3", "search", null, false)] })).toBe(false);
    expect(usesScreen({})).toBe(false);
  });
});

describe("times", () => {
  test("the time today, the date and time another day", () => {
    const today = new Date("2026-10-24T15:00:00");
    expect(clockAt("en-GB", "2026-10-24T14:05:00", today)).toBe("14:05");
    expect(clockAt("en-GB", "2026-10-23T14:05:00", today)).toMatch(/23 Oct.* 14:05$/);
  });
});
