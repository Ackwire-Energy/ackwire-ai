import { BROWSER_LIMITS, type BrowserInputEvent, parseBrowserInputEvent } from "@agenteschat/adapters";

/**
 * The agent browser's live view on `/api/ws` (ADR 0040 §7). Client frames:
 *
 * - `{"type":"browser.watch","agentId"}`: start getting that agent's browser
 *   (checked like the HTTP routes: `requireBrowserAccess`).
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
  | { type: "browser.watch" | "browser.unwatch"; agentId: string }
  | { type: "browser.input"; agentId: string; events: BrowserInputEvent[] };

/** Largest browser client frame: a batch of input events with a pasted text. */
export const MAX_BROWSER_CLIENT_FRAME = BROWSER_LIMITS.inputText * 2 + 64 * 1024;
/** Agents' browsers one socket may watch at once. */
export const MAX_WATCHED_BROWSERS = 4;
/** Input frames per second from one socket (a drag sends many moves). */
export const BROWSER_INPUT_PER_SECOND = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A browser frame of the live view, checked; null when the frame isn't one (or is malformed). */
export function parseBrowserClientFrame(raw: string | Buffer): BrowserClientFrame | null {
  if (raw.length > MAX_BROWSER_CLIENT_FRAME) return null;
  const text = String(raw);
  // Cheap test before parsing: every other client frame is small and never says "browser.".
  if (!text.includes('"browser.')) return null;
  try {
    const frame = JSON.parse(text) as { type?: unknown; agentId?: unknown; events?: unknown };
    if (typeof frame.agentId !== "string" || !UUID.test(frame.agentId)) return null;
    if (frame.type === "browser.watch" || frame.type === "browser.unwatch") {
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
