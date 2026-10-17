import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";

/**
 * Phones that receive push notifications (ADR 0035). Per person, not per
 * organization: one device hears every organization its person belongs to
 * (the payload carries `orgId`). An Expo push token belongs to one person at
 * a time: registering it again moves it to whoever is signed in. Tokens Expo
 * reports as unregistered are deleted.
 */
export const pushDevices = pgTable(
  "push_devices",
  {
    id: uuid()
      .primaryKey()
      .$defaultFn(() => Bun.randomUUIDv7()),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Expo push token (`ExponentPushToken[…]`). */
    token: text().notNull().unique(),
    /** `ios | android`, validated in code. */
    platform: text().$type<"ios" | "android">().notNull(),
    /** The device's language (`pt-BR`, `en`…): picks the push text. */
    locale: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Last time the app registered it (each launch). */
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId)],
);
