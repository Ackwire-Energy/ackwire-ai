import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";

/**
 * Devices that receive push notifications (ADR 0035, ADR 0071). Per person, not per organization: one
 * device hears every organization its person belongs to (the payload carries `orgId`). A token belongs
 * to one person at a time: registering it again moves it to whoever is signed in. Tokens the push
 * service reports as gone are deleted.
 *
 * Phones carry their Expo push token. Browsers (`web`) carry their Web Push subscription: the endpoint
 * in `token` and its keys in `webKeys`.
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
    /** Expo push token (`ExponentPushToken[…]`), or a browser's Web Push endpoint. */
    token: text().notNull().unique(),
    /** `ios | android | web`, validated in code. */
    platform: text().$type<"ios" | "android" | "web">().notNull(),
    /** A browser's subscription keys pushes are encrypted to (RFC 8291): `p256dh` and `auth`, base64url. */
    webKeys: jsonb().$type<{ p256dh: string; auth: string }>(),
    /** The device's language (`pt-BR`, `en`…): picks the push text. */
    locale: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Last time the device registered it (each launch, each page load). */
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId)],
);

/**
 * This installation's own push identity (ADR 0071): one row, made on first use. Not a tenant's, so
 * no `org_id`. The Web Push (VAPID, RFC 8292) key pair the server made for itself, the private part
 * sealed with the installation's key (`AGENTES_SECRET`).
 */
export const instancePush = pgTable(
  "instance_push",
  {
    id: integer().primaryKey().default(1),
    /** VAPID public key: an uncompressed P-256 point, base64url (what browsers get as `applicationServerKey`). */
    vapidPublicKey: text(),
    /** VAPID private key (JWK `d`), sealed. */
    vapidPrivateKey: text(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("instance_push_one_row", sql`${t.id} = 1`)],
);
