import type { BrowserHandoff } from "@agenteschat/client";

/**
 * The agent's browser on the phone (ADR 0040, NavegadorAgente.html): what only the app decides. The
 * request, the live connection and the input events are shared with the web (`@agenteschat/client`,
 * `browser/*`). Pure, so it is unit-tested.
 */

/** What the card shows: waiting for someone, me in control, someone else helping, or how it ended. */
export type CardState = "waiting" | "mine" | "helping" | "done" | "failed" | "expired" | "cancelled";

export function cardStateOf(h: Pick<BrowserHandoff, "status" | "controllerUserId">, meId: string | null): CardState {
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

/** The live view's key row: Tab, Enter, Apagar, Esc. */
export const LIVE_KEYS = ["Tab", "Enter", "Backspace", "Escape"] as const;
export type LiveKey = (typeof LIVE_KEYS)[number];

/** Quick reasons on "Não consegui" (the person may also write their own). */
export const FAILED_REASONS = ["code", "password", "blocked"] as const;
export type FailedReason = (typeof FAILED_REASONS)[number];
