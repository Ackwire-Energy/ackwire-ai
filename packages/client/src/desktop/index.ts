import { useQuery } from "@tanstack/react-query";
import { useApi } from "../api/context";
import { keys } from "../api/keys";
import type { DesktopStatus } from "../api/types";
import { handoffScreen } from "../browser";
import { type SocketBase, socketUrl } from "../realtime/connection";

/**
 * The agent's screen in the apps (ADR 0058): what the dialog's screen shows, the
 * viewer sockets' addresses, and what each of their close codes means.
 */

/** What the screen shows. */
export type DesktopViewState =
  /** The socket opens, or the screen starts: opening it starts a screen that isn't running. */
  | "connecting"
  | "live"
  /** Someone else is in control: their screen stays theirs until they hand it back. */
  | "hidden"
  /** The computer is offline, or its socket is on another server (retrying). */
  | "offline"
  /** As many viewers as the screen takes, or too many opens in a minute (retrying). */
  | "busy"
  /** The computer shows as many screens as its memory allows (`desktop_busy`): "Tentar de novo". */
  | "noRoom"
  /** Its owner paused the computer: control waits for the resume (retrying). */
  | "paused"
  /** The agent or its workspace is held and its screen isn't running: nothing starts it until the hold ends. */
  | "held"
  | "forbidden"
  /** The agentes app on the computer is too old for screens. */
  | "outdated"
  /** Its switch is off on the computer, it can't run screens, or the agent may not use one. */
  | "unavailable"
  /** The computer ended the stream for good: only "Tentar de novo" opens it again. */
  | "ended";

/** How the panel opens the screen again after a close: at once, after a wait (`desktopRetryMs`), or not by itself. */
export type DesktopRetry = "now" | "later" | "never";

/** Close codes of the viewer sockets; mirrors `STREAM_CLOSE` in packages/adapters/src/machine-protocol.ts. */
export const DESKTOP_CLOSE = {
  normal: 1000,
  forbidden: 4403,
  notFound: 4404,
  hidden: 4409,
  controlEnded: 4410,
  tooMany: 4429,
  refused: 4502,
  unreachable: 4503,
} as const;

/** What a viewer socket's close means for the panel; `reason` is the server's (4502: the computer's error code). */
export function desktopCloseState(code: number, reason = ""): { state: DesktopViewState; retry: DesktopRetry } {
  switch (code) {
    // Control isn't this person's (any more): open again, now as a watcher.
    case DESKTOP_CLOSE.controlEnded:
      return { state: "connecting", retry: "now" };
    case DESKTOP_CLOSE.hidden:
      return { state: "hidden", retry: "later" };
    case DESKTOP_CLOSE.forbidden:
      return { state: "forbidden", retry: "never" };
    case DESKTOP_CLOSE.notFound:
      return { state: "unavailable", retry: "never" };
    case DESKTOP_CLOSE.tooMany:
      return { state: "busy", retry: "later" };
    case DESKTOP_CLOSE.unreachable:
      return { state: "offline", retry: "later" };
    case DESKTOP_CLOSE.normal:
      return { state: "ended", retry: "never" };
    case DESKTOP_CLOSE.refused:
      // An older computer refuses a screen that isn't running: the server starts it, the next try opens it.
      if (reason === "desktop_off") return { state: "connecting", retry: "later" };
      if (reason === "desktop_busy") return { state: "noRoom", retry: "never" };
      if (reason === "machine_paused") return { state: "paused", retry: "later" };
      if (reason === "held") return { state: "held", retry: "later" };
      if (reason === "runner_outdated") return { state: "outdated", retry: "never" };
      if (reason === "not_allowed" || reason === "desktop_unavailable") return { state: "unavailable", retry: "never" };
      return { state: "connecting", retry: "later" };
    // 1001 the server restarts, 1006 the network dropped, 1013 too slow, 4408 the computer was late…
    default:
      return { state: "connecting", retry: "later" };
  }
}

/** What `GET …/desktop`'s `reason` means for the screen. */
export function desktopReasonState(reason: string | null): "offline" | "outdated" | "unavailable" {
  if (reason === "offline" || reason === "other_server") return "offline";
  if (reason === "runner_outdated") return "outdated";
  return "unavailable";
}

/**
 * What the screen shows before any socket opens, from its state; null: open it (a screen that isn't running
 * starts on its first viewer).
 */
export function desktopStatusState(status: DesktopStatus, userId: string): DesktopViewState | null {
  if (!status.available) return desktopReasonState(status.reason);
  if (status.controllerUserId && status.controllerUserId !== userId) return "hidden";
  // A held agent's screen that runs may be watched; one that doesn't isn't started until the hold ends.
  if (status.held && !status.running) return "held";
  return null;
}

/** Control only while the desktop's own handoff is this person's; the browser's (same window) leaves them watching. */
export function desktopMode(status: Pick<DesktopStatus, "handoff">, userId: string): "watch" | "control" {
  const h = status.handoff;
  return h?.status === "active" && handoffScreen(h) === "desktop" && h.controllerUserId === userId
    ? "control"
    : "watch";
}

/** Waits between tries to open the screen again: 1 s, then up to 10 s. */
const RETRY_MS = [1000, 2000, 5000, 10_000];
export const desktopRetryMs = (attempt: number) => RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? 10_000;

/** The keyboard layouts the person in control may give the desktop; mirrors `DESKTOP_KEYBOARDS` in machine-protocol.ts. */
export const DESKTOP_KEYBOARDS = ["br", "us", "us-intl", "gb", "pt", "es", "fr", "de", "it"] as const;
export type DesktopKeyboard = (typeof DESKTOP_KEYBOARDS)[number];
export const isDesktopKeyboard = (v: unknown): v is DesktopKeyboard =>
  (DESKTOP_KEYBOARDS as readonly unknown[]).includes(v);

const BY_LANGUAGE: Record<string, DesktopKeyboard> = { pt: "pt", es: "es", fr: "fr", de: "de", it: "it" };

/**
 * The layout the person most likely types with: from the browser's language and, when the browser tells
 * (Chromium), the character on the key right of L: "ç" is a Brazilian ABNT2 keyboard.
 */
export function keyboardFor(language: string, semicolonKey?: string | null): DesktopKeyboard {
  if (semicolonKey === "ç") return "br";
  const lang = language.toLowerCase();
  // ponytail: a guess the panel lets the person change; a US keyboard in Brazil is mostly set to US-International.
  if (lang === "pt-br") return semicolonKey ? "us-intl" : "br";
  if (lang === "en-gb") return "gb";
  return BY_LANGUAGE[lang.split("-")[0] ?? ""] ?? "us";
}

/** A person's socket to the agent's desktop (raw RFB); `keyboard` only counts in control. */
export function desktopSocketUrl(
  base: SocketBase,
  v: { orgId: string; agentId: string; mode: "watch" | "control"; keyboard?: DesktopKeyboard },
) {
  const params: Record<string, string> = { orgId: v.orgId, agentId: v.agentId, mode: v.mode };
  if (v.mode === "control" && v.keyboard) params.keyboard = v.keyboard;
  return socketUrl(base, "/api/desktop", params);
}

/** The agent's screen as this person sees it; `poll`: ask again this often (nothing else says when it is handed back). */
export const useDesktopStatus = (
  orgId: string,
  agentId: string,
  options: { enabled?: boolean; poll?: number | false } = {},
) => {
  const api = useApi();
  return useQuery({
    queryKey: keys.agentDesktop(orgId, agentId),
    queryFn: () => api.desktop.status(orgId, agentId),
    enabled: options.enabled ?? true,
    retry: false,
    refetchInterval: options.poll ?? false,
  });
};
