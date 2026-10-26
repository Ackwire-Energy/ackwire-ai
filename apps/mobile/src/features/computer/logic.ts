import { type BrowserHandoff, handoffScreen, isWaitingHandoff, type ScreenStep } from "@agenteschat/client";
import {
  type AgentComputerFacts,
  type EntryState,
  entryButton,
  surfaceOf,
} from "@agenteschat/client/lib/agent-computer";
import { type EtaView, etaLine, type SetupView } from "@agenteschat/client/lib/computer";
import type { TFunction } from "i18next";

/*
 * The agent's computer on the phone: the web's entry, states and words (`@agenteschat/client/lib/agent-computer`,
 * ADR 0065), with what only the phone decides. Pure, so it is unit-tested.
 */

/** What the full-screen view's stage shows. */
export type PhoneStage =
  /** Held while the workspace's computer isn't ready: the pause alone. */
  | "held"
  /** The workspace's computer on its way: the wait. */
  | "preparing"
  /** The agent's page, live: watch, take control (on the phone that means its browser). */
  | "page"
  /** The agent works in another app on its screen, which the phone doesn't show. */
  | "otherApp"
  /** Its computer serves a screen but no browser: nothing the phone can show. */
  | "laptop"
  | "offline"
  /** Cloud: the workspace's computer is ready and gives itself to this agent at its next hello. */
  | "joining"
  | "noComputer"
  | "noScreen"
  | "unavailable";

/** The agent's latest step on its computer was on its screen, outside its browser. */
export const onScreen = (steps: readonly Pick<ScreenStep, "screen">[]) => steps.at(-1)?.screen === "desktop";

/**
 * The stage, in the web's order (`surfaceOf`), this person in the agent's browser included (the page).
 * `screenWork`: the agent works on its screen now (`onScreen` of its run's steps, while it runs).
 */
export function phoneStage(f: AgentComputerFacts, screenWork: boolean): PhoneStage {
  const surface = surfaceOf(f);
  if (surface === "held" || surface === "preparing" || surface === "page") return surface;
  if (surface === "cover") {
    if (f.machine && !f.machine.online) return "offline";
    if (!f.machine) return f.edition === "cloud" ? "joining" : "noComputer";
    return f.desktop?.reason === "no_desktop" && !f.browserGranted ? "noScreen" : "unavailable";
  }
  // Where the web shows the agent's screen, the phone shows its page; a view of the screen on the phone
  // would be a stage of its own, picked here.
  if (screenWork) return "otherApp";
  return f.browser ? "page" : "laptop";
}

/**
 * The entry's one button on the phone: Help only for a browser request (a request on the screen is helped
 * from a laptop, never taken here), and no computer picker (Open says why there is none).
 */
export const phoneEntryButton = (s: EntryState): "help" | "open" =>
  entryButton(s) === "help" && s.kind === "needsYou" && handoffScreen(s.handoff) === "browser" ? "help" : "open";

/**
 * A request of the agent's on its screen, waiting for someone: the phone says to help from a laptop. Not a take
 * over (it asks nothing) nor a request someone already helps with (the sub-line says who is in control).
 */
export const screenRequest = (h: BrowserHandoff | null, nowMs = Date.now()) =>
  h && h.kind === "ask" && isWaitingHandoff(h, nowMs) && handoffScreen(h) === "desktop" ? h : null;

/** "Trocar computador" on an offline computer: only on self-host (the Cloud has no other), for who manages it. */
export const offersSwitch = (f: Pick<AgentComputerFacts, "edition">, manages: boolean, hasOutage: boolean) =>
  f.edition === "selfhost" && manages && hasOutage;

/**
 * The wait notice's line under "Preparando o computador da Acme": the time left (`setupEta`), else where it is; in
 * the wait for a computer, "avisamos por e-mail" after it for those who get the email (`emailed`).
 */
export function setupNoticeLine(t: TFunction, view: SetupView, eta: EtaView | null, emailed: boolean): string {
  if (eta) return etaLine(t, eta);
  return view.phase === "waiting" && emailed
    ? `${t(view.textKey)} · ${t("computerSetup.email.short")}`
    : t(view.textKey);
}
