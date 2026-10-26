import type { InvitationPreview } from "../api/types";

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
 * comes by email; signed in, the preview's `you` tells the answer and wins over what this page knows.
 */
export function askView(preview: Pick<InvitationPreview, "closed" | "you">, sent: boolean): AskView {
  if (preview.closed) return { state: "closed" };
  const you = preview.you;
  const status = you?.request?.status;
  if (you?.member) return { state: "in", orgId: you.orgId ?? null, already: status !== "approved" };
  if (status === "denied") return { state: "denied", reason: you?.request?.reason ?? null };
  if (status === "approved") return { state: "approvedEmail" };
  if (sent || status === "pending") return { state: "sent" };
  return { state: "form" };
}
