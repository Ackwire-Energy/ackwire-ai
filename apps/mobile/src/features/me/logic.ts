import type { TFunction } from "i18next";
import { joinNames } from "../shared/logic";

/**
 * Você's pure logic: the Conta form (what changed, what is wrong with it, the server's error as our
 * text), the photo's upload type and the app's version line.
 */

/** A person's @ (the server's rule, `PERSON_HANDLE_PATTERN`): 2 to 32 lowercase letters, numbers, - or _. */
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;

/** "  @Ana " → "ana" (what the server stores). */
export const normalizeHandle = (value: string) => value.trim().replace(/^@/, "").toLowerCase();

export interface AccountDraft {
  name: string;
  handle: string;
  /** IANA zone; null = the workspace's. */
  zone: string | null;
}

export type AccountProblem = "nameEmpty" | "handleInvalid";

/** What is wrong with the form (shown under it; OK stays off). */
export function accountProblem(draft: AccountDraft): AccountProblem | null {
  if (!draft.name.trim()) return "nameEmpty";
  if (!HANDLE_PATTERN.test(normalizeHandle(draft.handle))) return "handleInvalid";
  return null;
}

/** The calls Conta's OK makes: the name (the account) and the @ and zone (this workspace), only if changed. */
export function accountChanges(
  initial: AccountDraft,
  draft: AccountDraft,
): { name?: string; profile?: { handle?: string; timezone?: string | null } } {
  const out: { name?: string; profile?: { handle?: string; timezone?: string | null } } = {};
  const name = draft.name.trim();
  if (name !== initial.name.trim()) out.name = name;
  const handle = normalizeHandle(draft.handle);
  const profile: { handle?: string; timezone?: string | null } = {};
  if (handle !== normalizeHandle(initial.handle)) profile.handle = handle;
  if (draft.zone !== initial.zone) profile.timezone = draft.zone;
  if (Object.keys(profile).length > 0) out.profile = profile;
  return out;
}

/** The server's error code for a handle as our text's key (`mobile.me.account.*`); null = the generic one. */
export function handleErrorKey(code: string | undefined): "handleInvalid" | "handleTaken" | "handleAgent" | null {
  if (code === "handle.invalid") return "handleInvalid";
  if (code === "handle.taken") return "handleTaken";
  if (code === "handle.taken_by_agent") return "handleAgent";
  return null;
}

/** The type the photo upload accepts (JPEG, PNG or WebP); anything else was re-encoded to JPEG by the picker. */
export function photoContentType(
  mimeType: string | null | undefined,
  fileName?: string | null,
): "image/jpeg" | "image/png" | "image/webp" {
  const mime = mimeType?.toLowerCase() ?? "";
  const ext = fileName?.toLowerCase().split(".").pop() ?? "";
  if (mime === "image/png" || (!mime && ext === "png")) return "image/png";
  if (mime === "image/webp" || (!mime && ext === "webp")) return "image/webp";
  return "image/jpeg";
}

/** The upload's limit (`imageBase64` max 3,000,000 characters on the server). */
export const PHOTO_MAX_BASE64 = 3_000_000;

/** "N com você" in Do workspace: open issues (not done or canceled) assigned to me. */
export function openIssuesWithMe(
  issues: readonly { status: string; assignee: { type: string; id: string } | null }[] | undefined,
  meId: string | null,
): number {
  if (!issues || !meId) return 0;
  return issues.filter(
    (i) => i.assignee?.type === "person" && i.assignee.id === meId && i.status !== "done" && i.status !== "canceled",
  ).length;
}

/**
 * Apagar conta refused while this person is the only owner of organizations with other people: one line, which ones
 * (when the server says) and what to do.
 */
export function deleteBlockedText(t: TFunction, organizations: string[]): string {
  return organizations.length > 0
    ? t("mobile.delete.blocked", { names: joinNames(organizations, t("newAgent.and")) })
    : t("mobile.account.deleteSoleOwner");
}
