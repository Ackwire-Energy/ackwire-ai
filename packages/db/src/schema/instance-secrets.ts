import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./auth";

/**
 * Secrets of the whole installation, sealed like provider keys (ADR 0007): the TypeSafe key for Jev that its
 * owner adds in Settings (ADR 0073). Not a tenant's, so no `org_id`. It travels with backups and opens only with
 * the same `AGENTES_SECRET`.
 */
export const instanceSecrets = pgTable(
  "instance_secrets",
  {
    name: text().primaryKey(),
    ciphertext: text().notNull(),
    wrappedDataKey: text().notNull(),
    kekId: text().notNull(),
    /** Its last 4 characters: the only part ever shown. */
    keyHint: text().notNull(),
    updatedBy: text().references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("instance_secrets_name", sql`${t.name} in ('typesafe')`)],
);
