import { type Database, schema } from "@agenteschat/db";
import { ValidationError } from "./errors";

const { waitlistEntries } = schema;

export const WAITLIST_LOCALES = ["pt-BR", "en"] as const;
export type WaitlistLocale = (typeof WAITLIST_LOCALES)[number];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Lowercase, trimmed; null when it doesn't look like an email. */
export function normalizeWaitlistEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}

/**
 * Puts someone on the waiting list. Joining twice keeps the first entry, and
 * the caller answers the same either way, so the list can't be probed.
 * Returns whether a new entry was created.
 */
export async function joinWaitlist(
  db: Database,
  input: { email: string; locale?: string; source?: string },
): Promise<{ created: boolean }> {
  const email = normalizeWaitlistEmail(input.email);
  if (!email) throw new ValidationError("Use an email like name@company.com", "invalid_email");
  const locale: WaitlistLocale = WAITLIST_LOCALES.includes(input.locale as WaitlistLocale)
    ? (input.locale as WaitlistLocale)
    : "pt-BR";
  const rows = await db
    .insert(waitlistEntries)
    .values({ email, locale, source: input.source ?? "landing" })
    .onConflictDoNothing()
    .returning({ id: waitlistEntries.id });
  return { created: rows.length > 0 };
}
