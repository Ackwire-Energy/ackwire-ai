import type { TFunction } from "i18next";
import type { InvitationPreview, JoinApproval } from "../api/types";
import { daysBetween, formatShortDate, relativeTime } from "./format";

/** The server's limits on what a person types (mirrors packages/engine/src/invite-requests.ts). */
export const JOIN_NAME_MAX = 80;
export const JOIN_NOTE_MAX = 200;
export const JOIN_REASON_MAX = 300;
/** Digits in the code that proves an address on a link's page (ADR 0072). */
export const JOIN_CODE_LENGTH = 6;

/** A code as typed or pasted: its digits only, at most six ("123 456" and "123-456" both work). */
export const joinCode = (typed: string) => typed.replace(/\D/g, "").slice(0, JOIN_CODE_LENGTH);
/** A signed-in person's open link page asks for the answer this often (ADR 0068). */
export const ANSWER_POLL_MS = 15_000;

/** The roles an approval can give; owner never goes to someone who asked through a link. */
export const APPROVE_ROLES = ["member", "admin"] as const;
export type ApproveRole = (typeof APPROVE_ROLES)[number];

/**
 * What approving a request tells the admin (ADR 0068): they're in, or the invitation went to their address; on a
 * server that sends no email, the invitation's link to hand them, which the server returns only this once.
 */
export function approvalNews(result: JoinApproval): { said: "joined" | "invited" } | { send: string } {
  if (result.outcome === "joined") return { said: "joined" };
  return result.emailed ? { said: "invited" } : { send: result.url };
}

/** When a request came in: "Asked just now", "Asked 2 h ago", "Asked yesterday", "Asked on Oct 22". */
export function askedLabel(t: TFunction, locale: string, iso: string, now = new Date()) {
  if (now.getTime() - new Date(iso).getTime() < 60_000) return t("members.requests.askedNow");
  if (daysBetween(iso, now) > 1) return t("members.requests.askedOn", { date: formatShortDate(locale, iso) });
  return t("members.requests.asked", { ago: relativeTime(t, locale, iso, now) });
}

/** What an invitation link's page shows (ADR 0068), on the web and the phone alike. */
export type AskView =
  | { state: "form" }
  | { state: "sent" }
  /** In the workspace: `already` when they were in before their request was approved. */
  | { state: "in"; orgId: string | null; already: boolean }
  /** Approved, not in yet: the invitation to their address finishes it. */
  | { state: "approvedEmail" }
  | { state: "denied"; reason: string | null }
  | { state: "closed" };

/**
 * The state of a link's page: `sent` once the person asked here. Signed out that is the end, since the answer
 * comes by email; signed in, the preview's `you` tells the answer and wins over what this page knows. A link that
 * no longer works says only that, except to a member, who is told they're in.
 */
export function askView(preview: Pick<InvitationPreview, "closed" | "you">, sent: boolean): AskView {
  const you = preview.you;
  const status = you?.request?.status;
  if (you?.member) return { state: "in", orgId: you.orgId ?? null, already: status !== "approved" };
  if (preview.closed) return { state: "closed" };
  if (status === "denied") return { state: "denied", reason: you?.request?.reason ?? null };
  if (status === "approved") return { state: "approvedEmail" };
  if (sent || status === "pending") return { state: "sent" };
  return { state: "form" };
}
