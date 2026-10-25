import type { TFunction } from "i18next";
import type { BrowserHandoff, DesktopStatus, Edition, Machine } from "../api/types";
import { handoffMinutesLeft, handoffScreen, isWaitingHandoff } from "../browser";
import { type EtaView, type SetupView, setupEta, setupPending } from "./computer";
import { clockAt } from "./format";
import { isPaused } from "./machines";

/*
 * The agent's computer as one entry and one dialog, on the web and the phone: what its status line says
 * and what the dialog's stage shows, from what the apps already know of the agent.
 */

/** What the entry and the dialog read of an agent's computer. */
export interface AgentComputerFacts {
  edition: Edition;
  /** The agent is held, or the workspace is on hold. */
  held: boolean;
  /** The workspace's own computer (the Cloud's), else null. */
  setup: SetupView | null;
  /** The computer the agent works on, from the computers list; null: none. */
  machine: Pick<Machine, "name" | "online" | "lastSeenAt" | "paused"> | null;
  /** Its screen as `GET …/desktop` says it; null while unknown. */
  desktop: Pick<DesktopStatus, "available" | "reason"> | null;
  /** Its browser can run on its computer now. */
  browser: boolean;
  /** The agent may use its browser (`browser:use`). */
  browserGranted: boolean;
  /** Its open request or take over, on either screen. */
  handoff: BrowserHandoff | null;
  /** Who is looking. */
  userId: string;
  /** A run of the agent works on its computer now. */
  working: boolean;
}

/** The entry's status line, first match wins (the order the dialog's covers follow too). */
export type EntryState =
  | { kind: "held" }
  | { kind: "preparing"; eta: EtaView | null }
  | { kind: "slow" }
  | { kind: "problem" }
  | { kind: "offline" }
  | { kind: "paused"; until: string | null }
  | { kind: "needsYou"; handoff: BrowserHandoff }
  | { kind: "needsOther"; handoff: BrowserHandoff; userId: string }
  | { kind: "you" }
  | { kind: "other"; userId: string }
  | { kind: "working" }
  | { kind: "unavailable"; outdated: boolean }
  | { kind: "noScreen" }
  | { kind: "noComputer" }
  | { kind: "available" };

/** The workspace's own computer isn't ready, and the agent has none yet: it waits for that one. */
const waitsForWorkspace = (f: Pick<AgentComputerFacts, "edition" | "setup" | "machine">) =>
  f.edition === "cloud" && f.machine === null && setupPending(f.setup);

/** A request waits for this person: it went to them, or to nobody in particular. */
export const asksMe = (h: BrowserHandoff, userId: string) =>
  h.requestedForUserId === null || h.requestedForUserId === userId;

/**
 * The entry's state. A hold wins over everything: a workspace on hold isn't listed to its provisioner, so a
 * countdown would freeze, then read late. Then the wait, the computer's own trouble, the people on it, the
 * agent at work, and why nothing can be shown.
 */
export function entryState(f: AgentComputerFacts, nowMs = Date.now()): EntryState {
  if (f.held) return { kind: "held" };
  if (waitsForWorkspace(f) && f.setup) {
    if (f.setup.phase === "waiting") return { kind: "slow" };
    if (f.setup.phase === "problem") return { kind: "problem" };
    return { kind: "preparing", eta: setupEta(f.setup, nowMs) };
  }
  if (f.machine && !f.machine.online) return { kind: "offline" };
  if (f.edition === "selfhost" && f.machine && isPaused(f.machine, nowMs)) {
    return { kind: "paused", until: f.machine.paused?.until ?? null };
  }
  const h = f.handoff;
  if (h && isWaitingHandoff(h, nowMs)) {
    return asksMe(h, f.userId)
      ? { kind: "needsYou", handoff: h }
      : { kind: "needsOther", handoff: h, userId: h.requestedForUserId ?? "" };
  }
  if (h?.status === "active" && h.controllerUserId) {
    return h.controllerUserId === f.userId ? { kind: "you" } : { kind: "other", userId: h.controllerUserId };
  }
  if (f.working) return { kind: "working" };
  const neither = f.desktop?.reason === "no_desktop" && !f.browserGranted;
  const shown = f.desktop?.available === true || f.browser;
  if (!shown && !neither && (f.machine || f.edition === "cloud")) {
    return { kind: "unavailable", outdated: f.desktop?.reason === "runner_outdated" };
  }
  if (neither) return { kind: "noScreen" };
  if (!f.machine && f.edition === "selfhost") return { kind: "noComputer" };
  return { kind: "available" };
}

/** The entry's one button: Help on a request for this person, a picker for an agent with no computer. */
export const entryButton = (s: EntryState): "help" | "choose" | "open" =>
  s.kind === "needsYou" ? "help" : s.kind === "noComputer" ? "choose" : "open";

/** What the entry's words need from the platform. */
export interface EntryWords {
  edition: Edition;
  locale: string;
  /** The agent's computer's name (its pause and its update say it). */
  computer: string;
  /** When its computer was last seen (the offline line's time). */
  lastSeenAt: string | null;
  /** A person's name by id (whom a request went to, who is in control). */
  person: (userId: string) => string;
  /** The agent's latest step in words, when this device hears its run. */
  step: string | null;
  /** "We'll email you": only owners hear it, and only when the email is promised (`promisesEmail`). */
  emailPromised: boolean;
  now?: Date;
}

/** "Sign in to gov.br · 4 min": the request and the minutes it has left. */
export function askLine(t: TFunction, h: BrowserHandoff, nowMs = Date.now()) {
  const minutes = handoffMinutesLeft(h, nowMs);
  return minutes === null ? h.instructions : `${h.instructions} · ${t("browser.card.leftShort", { count: minutes })}`;
}

/** The entry's status line in the person's words (`agentComputer.status.*`). */
export function entryLine(t: TFunction, s: EntryState, w: EntryWords): string {
  const now = w.now ?? new Date();
  switch (s.kind) {
    case "held":
      return t("agentComputer.status.held");
    case "preparing":
      if (s.eta?.kind === "minutes") return t("agentComputer.status.preparing", { count: s.eta.count });
      return s.eta?.kind === "underMinute" || s.eta?.kind === "almost"
        ? t("agentComputer.status.preparingSoon")
        : t("agentComputer.status.preparingPlain");
    case "slow":
      return w.emailPromised ? t("agentComputer.status.slow") : t("agentComputer.status.slowPlain");
    case "problem":
      return t("agentComputer.status.problem");
    case "offline":
      if (w.edition === "cloud") return t("agentComputer.status.notAnswering");
      return w.lastSeenAt
        ? t("agentComputer.status.offline", { time: clockAt(w.locale, w.lastSeenAt, now) })
        : t("machines.offline");
    case "paused":
      return s.until
        ? t("agentComputer.status.paused", { computer: w.computer, time: clockAt(w.locale, s.until, now) })
        : t("agentComputer.status.pausedPlain", { computer: w.computer });
    case "needsYou":
      return t("agentComputer.status.needsYou", { ask: askLine(t, s.handoff, now.getTime()) });
    case "needsOther":
      return t("agentComputer.status.needsOther", {
        person: w.person(s.userId),
        ask: askLine(t, s.handoff, now.getTime()),
      });
    case "you":
      return t("agentComputer.status.you");
    case "other":
      return t("agentComputer.status.other", { person: w.person(s.userId) });
    case "working":
      return w.step ? t("agentComputer.status.working", { now: w.step }) : t("agentComputer.status.workingPlain");
    case "unavailable":
      return s.outdated && w.edition === "selfhost"
        ? t("agentComputer.status.outdated", { computer: w.computer })
        : t("agentComputer.status.unavailable");
    case "noScreen":
      return t("agentComputer.status.noScreen");
    case "noComputer":
      return t("agentComputer.status.noComputer");
    default:
      return t("agentComputer.status.available");
  }
}

/** What the dialog's stage shows (checked in this order). */
export type ComputerSurface =
  /** Held while the workspace's computer isn't ready: the pause alone, no countdown. */
  | "held"
  /** The workspace's computer on its way, the agent without one: the progress. */
  | "preparing"
  /** The agent's browser's page: a computer without screens, or this person in its browser. */
  | "page"
  /** The agent's screen, its browser a window on it. */
  | "screen"
  /** Why nothing shows. */
  | "cover";

/**
 * The dialog's stage. A person helping with a browser request gets the page, never the whole screen; a
 * computer that serves screens shows the agent's; one without them (a Mac) its browser's page.
 */
export function surfaceOf(f: AgentComputerFacts): ComputerSurface {
  if (f.held && waitsForWorkspace(f)) return "held";
  if (waitsForWorkspace(f)) return "preparing";
  const h = f.handoff;
  if (h?.status === "active" && h.controllerUserId === f.userId && handoffScreen(h) === "browser") return "page";
  if (f.desktop?.available) return "screen";
  if (f.browser) return "page";
  return "cover";
}
