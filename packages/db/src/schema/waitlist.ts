import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * People waiting for access (the landing page has no sign-up, only this
 * list). Not tenant-owned: it exists before any organization. Only what the
 * invitation needs is kept: the email (lowercase) and the language to write in.
 */
export const waitlistEntries = pgTable(
  "waitlist_entries",
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull(),
    /** "pt-BR" or "en": the language of the invitation email. */
    locale: text().notNull().default("pt-BR"),
    /** Where they joined from ("landing"). */
    source: text().notNull().default("landing"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Set when the invitation for their wave goes out. */
    invitedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex("waitlist_entries_email").on(t.email)],
);
