import { BROWSER_LIMITS, BROWSER_VIEW, type BrowserInputEvent, parseBrowserInputEvent } from "@agenteschat/adapters";

/**
 * The agent browser's live view on `/api/ws` (ADR 0040 §7). Client frames:
 *
 * - `{"type":"browser.watch","agentId","acks"?:true,"frames"?:true}`: start
 *   getting that agent's browser (checked like the HTTP routes:
 *   `requireBrowserAccess`). `acks`: this client answers each `browser.frame`
 *   it drew with `{"type":"browser.ack","agentId","seq"}`, and gets frames in
 *   a window (`createViewerPacer`, ADR 0040 §7.1). Without it (older apps),
 *   frames are only skipped while its socket is backed up. `frames` (with
 *   `acks`): the server answers `{"type":"browser.frames","agentId","ticket"}`
 *   and the client opens `GET /api/browser/frames?ticket=` (once, within
 *   `FRAME_TICKET_MS`): from then on that view's pictures come there as bytes
 *   (`encodeBrowserFrame`: version, header length, JSON header, JPEG), and
 *   the client answers each one it drew there with `{"type":"ack"}`. While it
 *   isn't open (or after it closed) they come here as before.
 * - `{"type":"browser.unwatch","agentId"}`.
 * - `{"type":"browser.input","agentId","events":[…]}`: only from the person
 *   in control of the open handoff; events as `BrowserInputEvent` (mouse,
 *   key, touch, and `text` for the app's own text field).
 *
 * Server frames (not wrapped, unlike channel events): `browser.frame`
 * (`{agentId, seq, data: base64 JPEG, metadata: {deviceWidth, deviceHeight,
 * pageScaleFactor?, url?, title?}}`; a watch on a running stream gets its
 * newest frame at once), `browser.status` (`{agentId, mode,
 * controllerUserId, handoff, hidden}`; `hidden`: someone else is in control,
 * so no frames reach this viewer until they hand it back, then the newest
 * comes at once),
 * `browser.unavailable` (`{agentId, reason: reconnecting | offline |
 * no_computer | closed | unavailable | forbidden, message?}`: send
 * `browser.watch` again with backoff on `reconnecting`, and on `closed` (the
 * agent's browser isn't open; it shows once something opens it); a repeated
 * watch restarts the view, so it also recovers after `offline`, an ended
 * stream or `forbidden`),
 * `browser.ended` (`{agentId, reason, message?}`), and `error` with
 * `code` and `agentId` (`forbidden`, `not_found`, `too_many_browsers`,
 * `not_in_control`, `rate_limited`).
 */
export type BrowserClientFrame =
  | { type: "browser.watch"; agentId: string; acks?: true; frames?: true }
  | { type: "browser.unwatch"; agentId: string }
  | { type: "browser.ack"; agentId: string }
  | { type: "browser.input"; agentId: string; events: BrowserInputEvent[] };

/** A watched browser's frame socket (ADR 0040 §7.1), opened with a ticket from `browser.frames`. */
export const BROWSER_FRAMES_PATH = "/api/browser/frames";
/** How long a frame socket's ticket opens it. */
export const FRAME_TICKET_MS = 30_000;

/** What a person sends on a frame socket: only `{"type":"ack"}`, one per picture drawn. Null for anything else. */
export function parseFrameSocketMessage(raw: string | Buffer): { type: "ack" } | null {
  if (typeof raw !== "string" || raw.length > 64) return null;
  try {
    return (JSON.parse(raw) as { type?: unknown } | null)?.type === "ack" ? { type: "ack" } : null;
  } catch {
    return null;
  }
}

/** Largest browser client frame: a batch of input events with a pasted text. */
export const MAX_BROWSER_CLIENT_FRAME = BROWSER_LIMITS.inputText * 2 + 64 * 1024;
/** Agents' browsers one socket may watch at once. */
export const MAX_WATCHED_BROWSERS = 4;
/** Input frames per second from one socket (a drag sends many moves). */
export const BROWSER_INPUT_PER_SECOND = 60;

/** An agent's id, or a browser profile's live-view key (`profile:<id>`, ADR 0110). */
const UUID = /^(profile:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A browser frame of the live view, checked; null when the frame isn't one (or is malformed). */
export function parseBrowserClientFrame(raw: string | Buffer): BrowserClientFrame | null {
  if (raw.length > MAX_BROWSER_CLIENT_FRAME) return null;
  const text = String(raw);
  // Cheap test before parsing: every other client frame is small and never says "browser.".
  if (!text.includes('"browser.')) return null;
  try {
    const frame = JSON.parse(text) as {
      type?: unknown;
      agentId?: unknown;
      events?: unknown;
      acks?: unknown;
      frames?: unknown;
    };
    if (typeof frame.agentId !== "string" || !UUID.test(frame.agentId)) return null;
    if (frame.type === "browser.watch") {
      const acks = frame.acks === true;
      return {
        type: frame.type,
        agentId: frame.agentId,
        ...(acks ? { acks: true as const } : {}),
        // Frames on their own socket come in a window: only for a client that answers them.
        ...(acks && frame.frames === true ? { frames: true as const } : {}),
      };
    }
    if (frame.type === "browser.unwatch" || frame.type === "browser.ack") {
      return { type: frame.type, agentId: frame.agentId };
    }
    if (frame.type === "browser.input" && Array.isArray(frame.events)) {
      if (frame.events.length === 0 || frame.events.length > BROWSER_LIMITS.inputEvents) return null;
      const events: BrowserInputEvent[] = [];
      for (const e of frame.events) {
        const parsed = parseBrowserInputEvent(e);
        if (!parsed) return null;
        events.push(parsed);
      }
      return { type: "browser.input", agentId: frame.agentId, events };
    }
  } catch {}
  return null;
}

/** A full window with no ack for this long sends the newest frame anyway (a hidden tab draws nothing). */
export const VIEWER_ACK_STALL_MS = BROWSER_VIEW.stallMs;

export interface ViewerPacer<M extends { type: string } = { type: string }> {
  /** A live-view message to the viewer: frames in the window, everything else at once. */
  send(message: M): void;
  /** The viewer drew a frame (`browser.ack`). */
  ack(): void;
  /** The view ended: nothing held goes out any more. */
  close(): void;
}

/**
 * Live-view frames to one viewer in a window (ADR 0040 §7.1): at most `window` frames it hasn't drawn yet are on
 * their way; a frame that finds the window full waits in place of the one waiting before it, so a slow link (a
 * phone on mobile data) shows the page as it is now rather than the seconds it fell behind. Other messages go at
 * once; one that ends or hides the view drops the frame waiting, which would show a page it no longer may.
 */
export function createViewerPacer<M extends { type: string }>(
  deliver: (message: M) => void,
  opts: {
    window?: number;
    stallMs?: number;
    timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void };
  } = {},
): ViewerPacer<M> {
  const window = opts.window ?? BROWSER_VIEW.window;
  const timers = opts.timers ?? {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  let inflight = 0;
  let held: M | null = null;
  let stall: unknown = null;
  let closed = false;
  const unstall = () => {
    if (stall !== null) timers.clearTimeout(stall);
    stall = null;
  };
  const release = () => {
    const next = held;
    held = null;
    if (next) pacer.send(next);
  };
  const pacer: ViewerPacer<M> = {
    send(message) {
      if (closed) return;
      if (message.type !== "browser.frame") {
        const hides =
          message.type === "browser.ended" ||
          message.type === "browser.unavailable" ||
          (message.type === "browser.status" && (message as { hidden?: unknown }).hidden === true);
        if (hides) held = null;
        deliver(message);
        return;
      }
      if (inflight >= window) {
        held = message;
        stall ??= timers.setTimeout(() => {
          stall = null;
          // Nothing drawn in all this time: start the window again, from the newest frame.
          inflight = 0;
          release();
        }, opts.stallMs ?? VIEWER_ACK_STALL_MS);
        return;
      }
      inflight++;
      deliver(message);
    },
    ack() {
      if (closed) return;
      inflight = Math.max(0, inflight - 1);
      unstall();
      release();
    },
    close() {
      closed = true;
      held = null;
      unstall();
    },
  };
  return pacer;
}
