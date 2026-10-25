import {
  type AgentAccess,
  BROWSER_TOOL_SCOPE,
  type BrowserHandoff,
  type BrowserLiveUnavailable,
  handoffScreen,
} from "@agenteschat/client";

/**
 * The agent's browser on the phone (ADR 0040): what only the app decides. The
 * request, the live connection and the input events are shared with the web (`@agenteschat/client`,
 * `browser/*`). Pure, so it is unit-tested.
 */

/**
 * What the card shows: waiting for someone, me in control, someone else helping, or how it ended;
 * `computer`: an open request on the agent's desktop, which the phone can't show (ADR 0058), so it is
 * never taken here.
 */
export type CardState = "waiting" | "mine" | "helping" | "computer" | "done" | "failed" | "expired" | "cancelled";

export function cardStateOf(
  h: Pick<BrowserHandoff, "status" | "controllerUserId" | "screen">,
  meId: string | null,
): CardState {
  if ((h.status === "pending" || h.status === "active") && handoffScreen(h) === "desktop") return "computer";
  if (h.status === "pending") return "waiting";
  if (h.status === "active") return h.controllerUserId && h.controllerUserId === meId ? "mine" : "helping";
  return h.status;
}

/** "dashboard.stripe.com" from a frame's URL (or nothing). */
export function hostOf(url: string | undefined | null): string {
  if (!url) return "";
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url.trim());
  return m?.[1]?.toLowerCase() ?? "";
}

/** The site the card names: the live page's host, else the last page the agent opened ("loja.exemplo"). */
export function siteOf(frameUrl: string | null | undefined, steps: { tool: string; detail: string | null }[]): string {
  const live = hostOf(frameUrl);
  if (live) return live;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    const tool = s?.tool.replace(/^mcp__agentes__/, "");
    if ((tool !== "browser_open" && tool !== "browser_tabs") || !s?.detail) continue;
    return hostOf(s.detail) || s.detail.trim().toLowerCase();
  }
  return "";
}

/** The site's letter tile ("L" for loja.exemplo, without "www."), or nothing. */
export function siteLetter(host: string): string {
  const name = host.replace(/^www\./, "");
  return name ? name.charAt(0).toUpperCase() : "";
}

/** The live view's key row: Tab, Enter, Apagar, Esc. */
export const LIVE_KEYS = ["Tab", "Enter", "Backspace", "Escape"] as const;
export type LiveKey = (typeof LIVE_KEYS)[number];

/** Quick reasons on "Não consegui" (the person may also write their own). */
export const FAILED_REASONS = ["code", "password", "blocked"] as const;
export type FailedReason = (typeof FAILED_REASONS)[number];

/** The longest note the server takes on Pronto, Devolver or Não consegui. */
export const NOTE_MAX = 1000;

/** The agent may use its browser: `browser:use` granted to it ("all tools" doesn't cover it). */
export const browserGranted = (access: Pick<AgentAccess, "builtins"> | null | undefined) =>
  Boolean(access?.builtins.some((s) => s.scope === BROWSER_TOOL_SCOPE && s.state === "granted"));

/**
 * The agent's browser on its profile: its card (watch, take over) for whoever may take it over (its owner
 * and admins, while its computer serves the browser) and while a person is in it; a request still waiting,
 * for anyone else, as the row that opens the request's conversation; else nothing.
 */
export function profileBrowserOf(
  open: Pick<BrowserHandoff, "status"> | null,
  mayTakeOver: boolean,
): "card" | "waiting" | null {
  if (mayTakeOver) return "card";
  if (!open) return null;
  return open.status === "pending" ? "waiting" : "card";
}

/** Why the card has no live page: the server's reason, or the stream ended. */
export type PageGap = BrowserLiveUnavailable | "ended";

/** The words for why the page shows nothing; the Cloud's computer is always on, so offline there isn't answering. */
export const pageGapKey = (gap: PageGap, gender: "F" | "M", cloud: boolean) =>
  `mobile.browser.live.unavailable.${gap === "offline" && cloud ? "offlineCloud" : gap}${gender}` as const;

export interface PageNote {
  say: PageGap | "starting" | "hidden";
  /** Only while the page may still come by itself. */
  spin: boolean;
  help: "grace" | "closedHelp" | null;
}

/**
 * The page box with no page to show: opening, hidden while someone else is in control (their screen
 * stays theirs), or why it can't be shown, with a line of help where waiting means something. A closed
 * or ended browser holds until a frame comes, and none comes to a hidden view: there, who holds it wins.
 */
export function pageNoteOf(gap: PageGap | null, hidden: boolean, mine: boolean): PageNote {
  if (gap && !(hidden && (gap === "closed" || gap === "ended"))) {
    const help = gap === "closed" ? "closedHelp" : gap === "reconnecting" && mine ? "grace" : null;
    return { say: gap, spin: gap === "reconnecting", help };
  }
  return hidden ? { say: "hidden", spin: false, help: null } : { say: "starting", spin: true, help: null };
}
