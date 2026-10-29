import type { Role } from "../api/types";
import { isEmail } from "./text";

/**
 * The onboarding's steps, in order.
 * "import" reads another product's export (apps/web/src/lib/import); its
 * agents arrive chosen in "agents", which only picks and creates the team.
 * "computer" comes before "ai": a computer the agents can use helps that step,
 * whose plan sign-in runs on it.
 */
export const ONBOARDING_STEPS = [
  { id: "workspace", optional: false },
  { id: "context", optional: false },
  { id: "import", optional: true },
  { id: "agents", optional: false },
  { id: "computer", optional: true },
  { id: "ai", optional: false },
  { id: "team", optional: true },
  { id: "done", optional: false },
] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]["id"];

/**
 * Who offers the first message when the onboarding ends: the first of these on the team. Lia's research needs a
 * browser, which only a ready computer gives the agents (not one being prepared); Theo's plan needs nothing. Ada, the
 * guide, is always on the team.
 */
export const firstAskOrder = (browser: boolean) =>
  browser ? (["lia", "theo", "ada"] as const) : (["theo", "lia", "ada"] as const);

/** A person to invite, as a chip: invalid addresses stay (marked) so they can be fixed or removed. */
export interface InviteDraft {
  email: string;
  role: Role;
  valid: boolean;
}

/** "a@x.com, b@x.com\nnot-an-email" → every piece, lower case, deduplicated (invalid ones too). */
export function splitEmails(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,;\s]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

/** Typed or pasted text turned into chips after the ones already there (new addresses only). */
export function addInvites(list: InviteDraft[], text: string, role: Role = "member"): InviteDraft[] {
  const known = new Set(list.map((i) => i.email));
  const added = splitEmails(text)
    .filter((email) => !known.has(email))
    .map((email) => ({ email, role, valid: isEmail(email) }));
  return added.length ? [...list, ...added] : list;
}

/** The invites that will be sent. */
export const validInvites = (list: InviteDraft[]) => list.filter((i) => i.valid);
