import type { BrowserHandoff } from "../api/types";
import { BACKOFF_MS, type Timers } from "../realtime/connection";
import type { BrowserWatcher } from "./watches";

/**
 * The agent browser's live view (ADR 0040 §7) over the realtime socket
 * (`/api/ws`, apps/server/src/realtime/browser.ts). Transport-agnostic: the
 * web and the phone app pass their own `send` and feed incoming frames to
 * `handleMessage` (`RealtimeConnection.onBrowserFrame`).
 */

/** What a frame shows: the viewport in CSS pixels, and the active tab's address and title. */
export interface BrowserFrameMetadata {
  deviceWidth: number;
  deviceHeight: number;
  pageScaleFactor?: number;
  url?: string;
  /** Written by the site (show it as text); absent from older runners. */
  title?: string;
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
  /**
   * Someone else is in control: no frames reach this view until they hand it back (then the
   * page comes at once). Drop the frame on screen meanwhile; what they type stays theirs.
   */
  hidden: boolean;
}

/**
 * Why the browser can't be shown now: `reconnecting` (retried here with backoff), `offline`,
 * `no_computer`, `closed` (the agent's browser isn't open; retried with backoff, so the view shows it
 * once something opens it), `unavailable` (with the computer's `message`), `forbidden` (no longer
 * allowed: stopped).
 */
export type BrowserLiveUnavailable = (typeof UNAVAILABLE)[number];

const UNAVAILABLE = ["reconnecting", "offline", "no_computer", "closed", "unavailable", "forbidden"] as const;

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
  | {
      type: "browser.ended";
      agentId: string;
      reason: "stopped" | "closed" | "error";
      message?: string;
      /** Parar: who pressed it, and when. */
      byUserId?: string;
      at?: string;
    }
  | { type: "error"; agentId: string; code: string };

/** Most events in one `browser.input` frame (the server's limit). */
export const BROWSER_INPUT_BATCH = 100;
/** Moves while a button is down (a drag) or a finger moves go out at most once a frame, merged. */
export const BROWSER_DRAG_FLUSH_MS = 16;
/** A pointer just hovering sends its position at most about 15 times a second (the latest one). */
export const BROWSER_HOVER_MS = 66;

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
          ...(typeof m.title === "string" && m.title ? { title: m.title } : {}),
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
        hidden: v.hidden === true,
      };
    case "browser.unavailable":
      return {
        type: "browser.unavailable",
        agentId: v.agentId,
        reason: UNAVAILABLE.includes(v.reason as BrowserLiveUnavailable)
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
        ...(typeof v.byUserId === "string" ? { byUserId: v.byUserId } : {}),
        ...(typeof v.at === "string" ? { at: v.at } : {}),
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
  /** The stream ended: the browser closed, an error, or someone pressed Parar (`by`: who and when). */
  onEnded?(reason: "stopped" | "closed" | "error", message?: string, by?: { userId?: string; at?: string }): void;
  /** `forbidden`, `not_found`, `not_in_control`, `too_many_browsers`, `rate_limited`. */
  onError?(code: string): void;
  timers?: Pick<Timers, "setTimeout" | "clearTimeout">;
  backoffMs?: number[];
  /**
   * The socket's shared watches (`RealtimeConnection.browserWatcher`): views of the same agent
   * share one `browser.watch`, and leaving unwatches only after a moment. Without it this
   * connection sends `browser.watch` / `browser.unwatch` itself.
   */
  watcher?: BrowserWatcher;
  /** The clock for hover throttling (tests). */
  now?: () => number;
}

export interface BrowserLiveConnection {
  /** Starts watching (`browser.watch`). */
  start(): void;
  /** Feed every live-view frame from the socket; frames of other agents are ignored. */
  handleMessage(message: unknown): void;
  /**
   * Sends a person's input (in control only). Clicks, keys and text go at once, in order; a drag's
   * moves are merged and sent once a frame; hover moves at most ~15 a second. Batches fit the
   * server's limit. False when there was nothing to send.
   */
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
  const clock = options.now ?? Date.now;
  const { agentId, watcher } = options;
  let attempt = 0;
  let retry: unknown = null;
  let closed = false;
  let release: (() => void) | null = null;
  const watch = () => (watcher ? watcher.rewatch(agentId) : options.send({ type: "browser.watch", agentId }));
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

  // Input: one `browser.input` per burst, not one per event.
  let queue: BrowserInputEvent[] = [];
  let flushTimer: unknown = null;
  let hover: BrowserInputEvent | null = null;
  let hoverTimer: unknown = null;
  let hoverAt = Number.NEGATIVE_INFINITY;
  const flush = () => {
    if (flushTimer !== null) timers.clearTimeout(flushTimer);
    flushTimer = null;
    if (closed || queue.length === 0) return;
    const out = queue;
    queue = [];
    for (let i = 0; i < out.length; i += BROWSER_INPUT_BATCH) {
      options.send({ type: "browser.input", agentId, events: out.slice(i, i + BROWSER_INPUT_BATCH) });
    }
  };
  const flushSoon = () => {
    if (flushTimer === null) flushTimer = timers.setTimeout(flush, BROWSER_DRAG_FLUSH_MS);
  };
  const dropHover = () => {
    hover = null;
    if (hoverTimer !== null) timers.clearTimeout(hoverTimer);
    hoverTimer = null;
  };
  const sendHover = () => {
    hoverTimer = null;
    if (!hover || closed) return;
    queue.push(hover);
    hover = null;
    hoverAt = clock();
    flush();
  };
  const hoverSoon = () => {
    if (hoverTimer !== null) return;
    const wait = BROWSER_HOVER_MS - (clock() - hoverAt);
    if (wait <= 0) sendHover();
    else hoverTimer = timers.setTimeout(sendHover, wait);
  };

  return {
    start() {
      closed = false;
      attempt = 0;
      if (!watcher) watch();
      else if (!release) release = watcher.acquire(agentId);
    },
    resume() {
      if (closed) return;
      clearRetry();
      // A shared watcher watches every agent again by itself when the socket is back.
      if (!watcher) watch();
    },
    handleMessage(raw) {
      if (closed) return;
      const m = parseBrowserLiveMessage(raw);
      if (!m || m.agentId !== agentId) return;
      switch (m.type) {
        // The view works (a closed browser opened meanwhile, say): a pending retry would only restart it.
        case "browser.frame":
          attempt = 0;
          clearRetry();
          options.onFrame(m);
          return;
        // A status answers every watch before the stream starts, so only a frame resets the backoff
        // (else a closed browser is watched again every 500 ms). One sent on its own (a handoff changed,
        // a page opened) comes with the server restarting the stream itself: the retry isn't needed.
        case "browser.status":
          clearRetry();
          options.onStatus(m);
          return;
        case "browser.unavailable":
          options.onUnavailable?.(m.reason, m.message);
          // Try again later unless it can't change by waiting (no computer, no access).
          // ponytail: a closed browser is polled (backoff up to 10 s); a runner push when it opens if that costs.
          if (m.reason !== "no_computer" && m.reason !== "forbidden") retryLater();
          return;
        case "browser.ended":
          options.onEnded?.(
            m.reason,
            m.message,
            m.byUserId || m.at
              ? { ...(m.byUserId ? { userId: m.byUserId } : {}), ...(m.at ? { at: m.at } : {}) }
              : undefined,
          );
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
      let urgent = false;
      for (const e of events) {
        if (isHoverMove(e)) {
          hover = e;
          continue;
        }
        // The pointer's last position goes first (a click moves there before pressing).
        if (hover) queue.push(hover);
        dropHover();
        const last = queue.at(-1);
        if (isDragMove(e)) {
          if (last && sameMove(last, e)) queue[queue.length - 1] = e;
          else queue.push(e);
          continue;
        }
        if (isWheel(e)) {
          // A scroll is many wheel ticks: one per frame, the deltas added up.
          if (last && isWheel(last)) queue[queue.length - 1] = addWheel(last, e);
          else queue.push(e);
          continue;
        }
        queue.push(e);
        urgent = true;
      }
      if (urgent) flush();
      else if (queue.length > 0) flushSoon();
      if (hover) hoverSoon();
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      clearRetry();
      dropHover();
      if (flushTimer !== null) timers.clearTimeout(flushTimer);
      flushTimer = null;
      queue = [];
      if (!watcher) options.send({ type: "browser.unwatch", agentId });
      else {
        release?.();
        release = null;
      }
    },
  };
}

/** The pointer moving with no button down. */
const isHoverMove = (e: BrowserInputEvent) =>
  e.kind === "mouse" && e.type === "mouseMoved" && (!e.button || e.button === "none");
/** A move after a press: a drag, or a finger moving. */
const isDragMove = (e: BrowserInputEvent) =>
  (e.kind === "mouse" && e.type === "mouseMoved") || (e.kind === "touch" && e.type === "touchMove");
const isWheel = (e: BrowserInputEvent): e is Extract<BrowserInputEvent, { kind: "mouse" }> =>
  e.kind === "mouse" && e.type === "mouseWheel";
/** Two wheel ticks as one: the later position, both scrolls. */
const addWheel = (a: BrowserInputEvent, b: BrowserInputEvent): BrowserInputEvent =>
  isWheel(a) && isWheel(b)
    ? { ...b, deltaX: (a.deltaX ?? 0) + (b.deltaX ?? 0), deltaY: (a.deltaY ?? 0) + (b.deltaY ?? 0) }
    : b;
/** Two moves of the same kind: the later replaces the earlier (only the latest position matters). */
const sameMove = (a: BrowserInputEvent, b: BrowserInputEvent) => a.kind === b.kind && isDragMove(a) && isDragMove(b);
