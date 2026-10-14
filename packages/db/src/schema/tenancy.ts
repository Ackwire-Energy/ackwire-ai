import { index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth";

/**
 * Top-level tenant. agentes.chat Cloud has many; a self-hosted install usually
 * has one. Every tenant-owned table carries `org_id` (docs/adr/0002-editions-and-modules.md).
 */
export const organizations = pgTable("organizations", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  /**
   * Free-form description of the company (what it does, how it works, house
   * rules). Goes into the system prompt of every agent of the organization.
   */
  context: text().notNull().default(""),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const memberRoleEnum = pgEnum("member_role", ["owner", "admin", "member"]);

/**
 * People in an organization, and their role:
 * - `owner`: everything, including ownership changes and deleting the organization.
 * - `admin`: everything except ownership changes (agents, credentials, members).
 * - `member`: chat, create channels, read usage of their own agents.
 * An organization always keeps at least one owner.
 */
export const organizationMembers = pgTable(
  "organization_members",
  {
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRoleEnum().notNull(),
    /** Last time a WebSocket connection of this person to this organization closed (or opened). */
    lastSeenAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] }), index().on(t.userId)],
);

/**
 * Pending invitations. The link carries a random token; only its SHA-256 is
 * stored. Accepting requires signing in with the invited email address. A
 * pending invitation also lets that email sign up when sign-up is closed.
 */
export const organizationInvitations = pgTable(
  "organization_invitations",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Lower-cased. */
    email: text().notNull(),
    role: memberRoleEnum().notNull(),
    tokenHash: text().notNull().unique(),
    invitedByUserId: text().references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    acceptedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId), index().on(t.email)],
);

/**
 * An organization-wide invite link: anyone signed in who opens it joins as
 * `role` (member) until it expires (7 days) or is revoked. Only the token's
 * hash is stored.
 */
export const organizationInviteLinks = pgTable(
  "organization_invite_links",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    role: memberRoleEnum().notNull().default("member"),
    tokenHash: text().notNull().unique(),
    createdByUserId: text().references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    revokedAt: timestamp({ withTimezone: true }),
    uses: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orgId)],
);
