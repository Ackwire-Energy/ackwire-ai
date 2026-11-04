import { useQuery } from "@tanstack/react-query";
import { useApi } from "../api/context";
import { keys } from "../api/keys";
import type { BrowserHandoff, DesktopStatus } from "../api/types";
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

/** A person's stream of the desktop: watching it, or in control of it. */
export type DesktopMode = "watch" | "control";

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

/**
 * Whether helping with `h` happens on the agent's whole screen: a request on the screen itself, or one in its browser
 * whose window is on that screen (`status.handoff` is the same one) for someone who may drive the screen. Who may only
 * drive the browser helps in its page.
 */
export function drivesOnDesktop(
  h: Pick<BrowserHandoff, "id" | "screen">,
  status: Partial<Pick<DesktopStatus, "available" | "canControl" | "handoff">> | null | undefined,
): boolean {
  if (handoffScreen(h) === "desktop") return true;
  return status?.available === true && status.canControl === true && status.handoff?.id === h.id;
}

/** Control while the handoff holding the desktop is this person's and they help there (`drivesOnDesktop`). */
export function desktopMode(
  status: Pick<DesktopStatus, "handoff" | "available" | "canControl">,
  userId: string,
): DesktopMode {
  const h = status.handoff;
  return h?.status === "active" && h.controllerUserId === userId && drivesOnDesktop(h, status) ? "control" : "watch";
}

/** Why this person drives only the agent's browser, not its whole computer (`controlRefusal`), as its words' key. */
export const browserOnlyWhy = (status: Pick<DesktopStatus, "controlRefusal"> | null | undefined) =>
  status?.controlRefusal === "owner_plan"
    ? ("desktop.browserOnly.plan" as const)
    : status?.controlRefusal === "role"
      ? ("desktop.browserOnly.role" as const)
      : ("desktop.browserOnly.other" as const);

/** Waits between tries to open the screen again: 1 s, then up to 10 s. */
const RETRY_MS = [1000, 2000, 5000, 10_000];
export const desktopRetryMs = (attempt: number) => RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)] ?? 10_000;

/**
 * A person's socket to the agent's desktop (raw RFB). `switches`: it takes its mode changing in place (ADR 0058 §17),
 * with `{"type":"mode"}` text frames around each new RFB session (`DesktopLink` in the web app).
 */
export function desktopSocketUrl(
  base: SocketBase,
  v: { orgId: string; agentId: string; mode: DesktopMode; switches?: boolean },
) {
  const params = { orgId: v.orgId, agentId: v.agentId, ...(v.switches ? { switch: 1 } : {}), mode: v.mode };
  return socketUrl(base, "/api/desktop", params);
}

/** The mode a desktop socket's text frame names (`{"type":"mode","mode"}`, ADR 0058 §17); null for any other. */
export function desktopModeFrame(text: string): DesktopMode | null {
  try {
    const frame = JSON.parse(text) as { type?: unknown; mode?: unknown };
    return frame.type === "mode" && (frame.mode === "watch" || frame.mode === "control") ? frame.mode : null;
  } catch {
    return null;
  }
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

/**
 * Xvnc's MaxCutText (its default): a larger clipboard from a viewer is dropped without a word. It counts what noVNC
 * sends: UTF-8 with every line break as CRLF, and a NUL at the end. The agent's browser takes the same at most: a
 * paste goes in 10,000-character frames, and the server takes 60 frames a second.
 */
export const PASTE_MAX_BYTES = 262_144;

/** What a text takes on the desktop's clipboard, in the bytes `PASTE_MAX_BYTES` counts. */
export const pasteBytes = (text: string) =>
  new TextEncoder().encode(text.replace(/\r\n|\r|\n/g, "\r\n")).byteLength + 1;
