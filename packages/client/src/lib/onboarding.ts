import type { Role } from "../api/types";
import { isEmail } from "./text";

/**
 * The onboarding's steps, in order (docs/design/telas/OnboardingV2.html).
 * "import" reads another product's export (apps/web/src/lib/import); its
 * agents arrive chosen in "agents". "computer" comes before "agents": with a
 * computer connected, the model step can also pick its Claude Code.
 */
export const ONBOARDING_STEPS = [
  { id: "workspace", optional: false },
  { id: "context", optional: false },
  { id: "import", optional: true },
  { id: "computer", optional: true },
  { id: "agents", optional: false },
  { id: "team", optional: true },
  { id: "done", optional: false },
] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]["id"];

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
