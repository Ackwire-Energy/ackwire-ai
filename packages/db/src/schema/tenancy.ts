import { sql } from "drizzle-orm";
import { index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
  /** The workspace logo (`/api/app/org-logos/{orgId}/{hash}.{ext}`), uploaded by an admin; null = the agent mark. */
  logo: text(),
  /**
   * Set by the people who run this server through the operator API (ADR 0056): `hold` stops its agents,
   * `suspended` the whole workspace. With the notice `silent` the workspace is told only that it is paused,
   * never why (`standing.ts`).
   */
  standing: text().$type<"active" | "hold" | "suspended">().notNull().default("active"),
  standingReason: text(),
  /** The operator's own note: never shown to the workspace. */
  standingNote: text(),
  standingNotice: text().$type<"shown" | "silent">().notNull().default("shown"),
  /** When `standing` last changed; null: never. */
  standingChangedAt: timestamp({ withTimezone: true }),
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
    /** `@ana` in this organization: unique per org, from the name without accents, editable. */
    handle: text(),
    /** The person's IANA time zone ("hora local"); null = the organization's. */
    timezone: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.userId] }),
    index().on(t.userId),
    uniqueIndex("organization_members_org_handle").on(t.orgId, t.handle),
  ],
);

/**
 * Pending invitations. The link carries a random token; only its SHA-256 is
 * stored. Accepting requires signing in with the invited email address. A
 * pending invitation is the only thing that lets an email sign up when sign-up
 * is closed (ADR 0068): an invitation link never does.
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
 * An organization-wide invite link (ADR 0068): whoever opens it can only ask to join
 * (`organization_join_requests`), until it expires (30 days) or is turned off. Its token is an HMAC of
 * its id (`inviteLinkToken`), so it can be shown again; only the token's hash is stored. Links made
 * before that carry a random token and can't be shown again. `uses` counts the people approved
 * through it; `role` is unused (the role is picked at approval).
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

/**
 * Someone who opened an invitation link and asks to join (ADR 0068, 0072). An admin approves (with a role) or
 * denies (with an optional reason the person is told). Approval lets in at once only a confirmed account with
 * `email` that proved it (`verified_at`, or it asked itself); anyone else gets an email invitation to it.
 * "Expired" isn't stored: a `pending` row whose `expires_at` passed. Rows answered or expired more than 90 days
 * ago are deleted.
 */
export const organizationJoinRequests = pgTable(
  "organization_join_requests",
  {
    id: uuid().primaryKey().defaultRandom(),
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    linkId: uuid().references(() => organizationInviteLinks.id, { onDelete: "set null" }),
    /** The account that asked, when signed in. */
    userId: text().references(() => users.id, { onDelete: "cascade" }),
    /** Lower-cased. */
    email: text().notNull(),
    /** When the person proved the address: a code from its mailbox, or a confirmed account asking. */
    verifiedAt: timestamp({ withTimezone: true }),
    name: text().notNull(),
    /** Shown in the app only, never in an email or a push: it is an outsider's text. */
    note: text(),
    /** The page's language when the person asked, for the answer's email when they have no account. */
    locale: text(),
    status: text().$type<"pending" | "approved" | "denied" | "closed">().notNull().default("pending"),
    role: memberRoleEnum(),
    /** Why it was denied, told to the person. */
    reason: text(),
    decidedByUserId: text().references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp({ withTimezone: true }),
    /** The invitation an approval sent, when the address wasn't proven. */
    invitationId: uuid().references(() => organizationInvitations.id, { onDelete: "set null" }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("organization_join_requests_pending").on(t.orgId, t.email).where(sql`${t.status} = 'pending'`),
    index().on(t.orgId, t.email),
  ],
);

/**
 * The code emailed to an address typed on an invitation link's page (ADR 0072), one row per workspace and address.
 * `codeHash`, `tries`, `sentAt` and `expiresAt` hold the code waiting to be typed, and a new code writes only those.
 * Typed right, its hash moves to `verifiedHash`, good to ask with until `verifiedUntil`, which no newer code
 * replaces. Hashes are sha256 of `{orgId}:{email}:{code}`. The row goes when the request is sent, and a day after
 * both times pass.
 */
export const organizationJoinCodes = pgTable(
  "organization_join_codes",
  {
    orgId: uuid()
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Lower-cased. */
    email: text().notNull(),
    codeHash: text(),
    tries: integer().notNull().default(0),
    sentAt: timestamp({ withTimezone: true }).notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    verifiedHash: text(),
    verifiedUntil: timestamp({ withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.email] })],
);

/**
 * Each join code sent and each wrong one typed (ADR 0072). Every limit on codes is a count here, so a restart
 * resets none. `mailbox` is the sha256 of the address's mailbox (`mailboxOf`). Rows go after a day.
 */
export const organizationJoinCodeEvents = pgTable(
  "organization_join_code_events",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** No foreign key: the counts outlive a deleted workspace, so deleting one resets no mailbox's or server's cap. */
    orgId: uuid().notNull(),
    mailbox: text().notNull(),
    kind: text().$type<"sent" | "wrong">().notNull(),
    at: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index().on(t.mailbox, t.at), index().on(t.at)],
);
