import type { Message } from "@agenteschat/client";

/**
 * The agent's browser on the phone (ADR 0040, NavegadorAgente.html): the
 * help request in the conversation (`meta.browserHandoff`), the live view's
 * tap mapping and the keys it sends. Pure, so it is unit-tested.
 */

export type HandoffStatus = "pending" | "active" | "done" | "failed" | "expired" | "cancelled";

/** A handoff as the server writes it into its chat card (`BrowserHandoffView`). */
export interface HandoffCard {
  id: string;
  agentId: string;
  kind: "ask" | "takeover";
  instructions: string;
  status: HandoffStatus;
  requestedForUserId: string | null;
  controllerUserId: string | null;
  note: string | null;
  /** Pending only: when nobody opening it ends the request. */
  expiresAt: string | null;
  createdAt: string;
}

const STATUSES: readonly HandoffStatus[] = ["pending", "active", "done", "failed", "expired", "cancelled"];

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strOrNull = (v: unknown) => (typeof v === "string" && v ? v : null);

/** The card's handoff, checked (anything malformed → null). */
export function handoffOf(meta: Message["meta"]): HandoffCard | null {
  const h = meta?.browserHandoff;
  if (!h || typeof h !== "object") return null;
  const o = h as Record<string, unknown>;
  const status = STATUSES.find((s) => s === o.status);
  if (!str(o.id) || !str(o.agentId) || !status) return null;
  return {
    id: str(o.id),
    agentId: str(o.agentId),
    kind: o.kind === "takeover" ? "takeover" : "ask",
    instructions: str(o.instructions),
    status,
    requestedForUserId: strOrNull(o.requestedForUserId),
    controllerUserId: strOrNull(o.controllerUserId),
    note: strOrNull(o.note),
    expiresAt: strOrNull(o.expiresAt),
    createdAt: str(o.createdAt),
  };
}

/** What the card shows: waiting for someone, me in control, someone else helping, or how it ended. */
export type CardState = "waiting" | "mine" | "helping" | "done" | "failed" | "expired" | "cancelled";

export function cardStateOf(h: Pick<HandoffCard, "status" | "controllerUserId">, meId: string | null): CardState {
  if (h.status === "pending") return "waiting";
  if (h.status === "active") return h.controllerUserId && h.controllerUserId === meId ? "mine" : "helping";
  return h.status;
}

/** Open (the person can still do something with it). */
export const isOpen = (s: HandoffStatus) => s === "pending" || s === "active";

/** "dashboard.stripe.com" from a frame's URL (or nothing). */
export function hostOf(url: string | undefined | null): string {
  if (!url) return "";
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(url.trim());
  return m?.[1]?.toLowerCase() ?? "";
}

// ── The live view ────────────────────────────────────────────────────────────

/** Input sent to the agent's browser (`BrowserInputEvent`, in the page's CSS pixels). */
export type LiveInput =
  | {
      kind: "mouse";
      type: "mousePressed" | "mouseReleased" | "mouseMoved";
      x: number;
      y: number;
      button?: "left" | "none";
      clickCount?: number;
    }
  | { kind: "key"; type: "keyDown" | "keyUp"; key: string }
  | { kind: "text"; text: string };

export interface Box {
  width: number;
  height: number;
}

/**
 * Where a tap on the frame lands on the page: the frame is drawn "contain" inside `view`; a tap on the
 * letterbox (outside the picture) is null.
 */
export function pagePoint(tap: { x: number; y: number }, view: Box, page: Box): { x: number; y: number } | null {
  if (view.width <= 0 || view.height <= 0 || page.width <= 0 || page.height <= 0) return null;
  const scale = Math.min(view.width / page.width, view.height / page.height);
  const ox = (view.width - page.width * scale) / 2;
  const oy = (view.height - page.height * scale) / 2;
  const x = (tap.x - ox) / scale;
  const y = (tap.y - oy) / scale;
  if (x < 0 || y < 0 || x > page.width || y > page.height) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

/** A click at a page point: press and release (a tap on a phone is a click on a desktop page). */
export function clickAt(p: { x: number; y: number }): LiveInput[] {
  return [
    { kind: "mouse", type: "mouseMoved", x: p.x, y: p.y, button: "none" },
    { kind: "mouse", type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 },
    { kind: "mouse", type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 },
  ];
}

/** The live view's key row: Tab, Enter, Apagar, Esc. */
export const LIVE_KEYS = ["Tab", "Enter", "Backspace", "Escape"] as const;
export type LiveKey = (typeof LIVE_KEYS)[number];

export const keyPress = (key: LiveKey): LiveInput[] => [
  { kind: "key", type: "keyDown", key },
  { kind: "key", type: "keyUp", key },
];

/** The whole text of the app's field, sent at once (accents, paste and AutoFill work). */
export const textInput = (text: string): LiveInput[] => (text ? [{ kind: "text", text }] : []);

/** Quick reasons on "Não consegui" (the person may also write their own). */
export const FAILED_REASONS = ["code", "password", "blocked"] as const;
export type FailedReason = (typeof FAILED_REASONS)[number];

/** Retry delays for the live view's socket (ms), the last one repeats. */
export const LIVE_BACKOFF = [500, 1000, 2000, 4000, 8000] as const;
export const liveBackoff = (attempt: number) =>
  LIVE_BACKOFF[Math.min(Math.max(attempt, 0), LIVE_BACKOFF.length - 1)] ?? 8000;
