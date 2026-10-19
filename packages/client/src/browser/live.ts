import type { BrowserHandoff } from "../api/types";
import { BACKOFF_MS, type Timers } from "../realtime/connection";

/**
 * The agent browser's live view (ADR 0040 §7) over the realtime socket
 * (`/api/ws`, apps/server/src/realtime/browser.ts). Transport-agnostic: the
 * web and the phone app pass their own `send` and feed incoming frames to
 * `handleMessage` (`RealtimeConnection.onBrowserFrame`).
 */

/** What a frame shows: the viewport in CSS pixels, and the active tab's address. */
export interface BrowserFrameMetadata {
  deviceWidth: number;
  deviceHeight: number;
  pageScaleFactor?: number;
  url?: string;
}

export interface BrowserFrame {
  agentId: string;
  seq: number;
  /** Base64 JPEG. */
  data: string;
  metadata: BrowserFrameMetadata;
}

/** Who is in control and the open request, on watch and whenever it changes. */
export interface BrowserLiveStatus {
  agentId: string;
  /** `watch`: about one frame a second; `control`: smooth while a person drives. */
  mode: "watch" | "control";
  controllerUserId: string | null;
  handoff: BrowserHandoff | null;
}

/**
 * Why the browser can't be shown now: `reconnecting` (retried here with backoff), `offline`,
 * `no_computer`, `unavailable` (with the computer's `message`), `forbidden` (no longer allowed: stopped).
 */
export type BrowserLiveUnavailable = "reconnecting" | "offline" | "no_computer" | "unavailable" | "forbidden";

/** Bits of the modifier mask: Alt 1, Control 2, Meta 4, Shift 8. */
export type BrowserModifiers = number;

/** A person's input while in control, in page coordinates (CSS pixels of the frame's viewport). */
export type BrowserInputEvent =
  | {
      kind: "mouse";
      type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
      x: number;
      y: number;
      button?: "left" | "right" | "middle" | "none";
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: BrowserModifiers;
    }
  | {
      kind: "key";
      type: "keyDown" | "keyUp" | "char";
      key: string;
      code?: string;
      text?: string;
      modifiers?: BrowserModifiers;
    }
  | {
      kind: "touch";
      type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel";
      touchPoints: { x: number; y: number }[];
      modifiers?: BrowserModifiers;
    }
  /** Whole text into the focused field: accents, paste, the app's own text field. */
  | { kind: "text"; text: string };

export type BrowserLiveMessage =
  | ({ type: "browser.frame" } & BrowserFrame)
  | ({ type: "browser.status" } & BrowserLiveStatus)
  | { type: "browser.unavailable"; agentId: string; reason: BrowserLiveUnavailable; message?: string }
  | { type: "browser.ended"; agentId: string; reason: "stopped" | "closed" | "error"; message?: string }
  | { type: "error"; agentId: string; code: string };

/** Most events in one `browser.input` frame (the server's limit). */
export const BROWSER_INPUT_BATCH = 100;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);

/** A live-view frame from the socket, checked; null for anything else. */
export function parseBrowserLiveMessage(v: unknown): BrowserLiveMessage | null {
  if (!isObject(v) || typeof v.type !== "string" || typeof v.agentId !== "string") return null;
  switch (v.type) {
    case "browser.frame": {
      const m = v.metadata;
      if (typeof v.data !== "string" || !num(v.seq) || !isObject(m) || !num(m.deviceWidth) || !num(m.deviceHeight))
        return null;
      return {
        type: "browser.frame",
        agentId: v.agentId,
        seq: v.seq as number,
        data: v.data,
        metadata: {
          deviceWidth: m.deviceWidth as number,
          deviceHeight: m.deviceHeight as number,
          ...(num(m.pageScaleFactor) ? { pageScaleFactor: m.pageScaleFactor as number } : {}),
          ...(typeof m.url === "string" ? { url: m.url } : {}),
        },
      };
    }
    case "browser.status":
      return {
        type: "browser.status",
        agentId: v.agentId,
        mode: v.mode === "control" ? "control" : "watch",
        controllerUserId: typeof v.controllerUserId === "string" ? v.controllerUserId : null,
        handoff: isObject(v.handoff) ? (v.handoff as unknown as BrowserHandoff) : null,
      };
    case "browser.unavailable":
      return {
        type: "browser.unavailable",
        agentId: v.agentId,
        reason: (["reconnecting", "offline", "no_computer", "unavailable", "forbidden"] as const).includes(
          v.reason as BrowserLiveUnavailable,
        )
          ? (v.reason as BrowserLiveUnavailable)
          : "unavailable",
        ...(typeof v.message === "string" ? { message: v.message } : {}),
      };
    case "browser.ended":
      return {
        type: "browser.ended",
        agentId: v.agentId,
        reason: v.reason === "stopped" || v.reason === "closed" ? v.reason : "error",
        ...(typeof v.message === "string" ? { message: v.message } : {}),
      };
    case "error":
      return typeof v.code === "string" ? { type: "error", agentId: v.agentId, code: v.code } : null;
    default:
      return null;
  }
}

/** The wait before retrying `browser.watch` after the n-th `reconnecting` in a row. */
export function browserRetryDelay(attempt: number, backoff: number[] = BACKOFF_MS): number {
  return backoff[Math.min(Math.max(attempt, 0), backoff.length - 1)] ?? 10_000;
}

export interface BrowserLiveOptions {
  /** Sends a frame on the realtime socket (`RealtimeConnection.sendBrowserFrame`). */
  send(frame: { type: `browser.${string}`; agentId: string; [key: string]: unknown }): void;
  agentId: string;
  onFrame(frame: BrowserFrame): void;
  onStatus(status: BrowserLiveStatus): void;
  onUnavailable?(reason: BrowserLiveUnavailable, message?: string): void;
  onEnded?(reason: "stopped" | "closed" | "error", message?: string): void;
  /** `forbidden`, `not_found`, `not_in_control`, `too_many_browsers`, `rate_limited`. */
  onError?(code: string): void;
  timers?: Pick<Timers, "setTimeout" | "clearTimeout">;
  backoffMs?: number[];
}

export interface BrowserLiveConnection {
  /** Starts watching (`browser.watch`). */
  start(): void;
  /** Feed every live-view frame from the socket; frames of other agents are ignored. */
  handleMessage(message: unknown): void;
  /** Sends a person's input (in control only), in batches the server accepts. False when there was nothing to send. */
  sendInput(events: BrowserInputEvent[]): boolean;
  /** After the socket reconnected: watch again (the server forgot this socket). */
  resume(): void;
  /** Stops watching (`browser.unwatch`) and any pending retry. */
  close(): void;
}

/**
 * One agent's live view on the shared realtime socket: watch, retry with
 * backoff while the computer is `reconnecting`, forward input, unwatch.
 */
export function createBrowserLiveConnection(options: BrowserLiveOptions): BrowserLiveConnection {
  const timers = options.timers ?? {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  const { agentId } = options;
  let attempt = 0;
  let retry: unknown = null;
  let closed = false;
  const watch = () => options.send({ type: "browser.watch", agentId });
  /** `browser.watch` again after a backoff (a repeated watch restarts the view on the server). */
  const retryLater = () => {
    clearRetry();
    retry = timers.setTimeout(
      () => {
        retry = null;
        if (!closed) watch();
      },
      browserRetryDelay(attempt++, options.backoffMs),
    );
  };
  const clearRetry = () => {
    if (retry !== null) timers.clearTimeout(retry);
    retry = null;
  };
  return {
    start() {
      closed = false;
      attempt = 0;
      watch();
    },
    resume() {
      if (closed) return;
      clearRetry();
      watch();
    },
    handleMessage(raw) {
      if (closed) return;
      const m = parseBrowserLiveMessage(raw);
      if (!m || m.agentId !== agentId) return;
      switch (m.type) {
        case "browser.frame":
          attempt = 0;
          options.onFrame(m);
          return;
        case "browser.status":
          attempt = 0;
          options.onStatus(m);
          return;
        case "browser.unavailable":
          options.onUnavailable?.(m.reason, m.message);
          // The server dropped this watch: try again later unless it can't change by waiting.
          if (m.reason === "reconnecting" || m.reason === "unavailable" || m.reason === "offline") retryLater();
          return;
        case "browser.ended":
          options.onEnded?.(m.reason, m.message);
          // The browser closed or failed on the computer: watching again picks it up when it is back.
          if (m.reason !== "stopped") retryLater();
          return;
        case "error":
          options.onError?.(m.code);
          return;
      }
    },
    sendInput(events) {
      if (closed || events.length === 0) return false;
      for (let i = 0; i < events.length; i += BROWSER_INPUT_BATCH) {
        options.send({ type: "browser.input", agentId, events: events.slice(i, i + BROWSER_INPUT_BATCH) });
      }
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      clearRetry();
      options.send({ type: "browser.unwatch", agentId });
    },
  };
}
