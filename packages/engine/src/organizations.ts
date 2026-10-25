import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, gt, inArray, isNull, ne, schema, sql } from "@agenteschat/db";
import { caches } from "./cache";
import { randomToken, sha256 } from "./crypto";
import { ConflictError, ForbiddenError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import { followWorkspaceName } from "./machine-provisioning";
import { addressDomain } from "./mail/text";
import { type OperatorEvent, recordOperatorEvent } from "./operator-events";
import { assertCanWork, isUserBlocked, OrgPausedError, STANDING_COLUMNS, type WorkspaceStanding } from "./standing";

const {
  organizations,
  organizationMembers,
  organizationInvitations,
  organizationInviteLinks,
  channels,
  channelMembers,
  users,
  accounts,
  agents,
} = schema;

export type MemberRole = "owner" | "admin" | "member";

/**
 * What each role may do in an organization (docs/adr/0006-auth-and-tenancy.md).
 * Checked by the backend on every request; the UI only hides what's not
 * allowed. Agents never hold these permissions: what an agent may do is
 * decided by its own scopes (Tool Gateway, later), never by a prompt.
 */
export type Permission =
  | "read" // see the organization, its members, agents and public channels
  | "post" // write messages in channels they belong to
  | "create_channels"
  | "configure" // organization name and context
  | "manage_agents" // create, edit and archive agents; set budgets
  | "manage_credentials" // add and revoke provider API keys
  | "manage_connectors" // connect MCP servers (GitHub, Sentry…) for the organization
  | "view_usage" // tokens and cost of every agent
  | "manage_members" // invite, remove, change roles (except owners)
  | "manage_owners"; // grant/revoke owner

const MEMBER: Permission[] = ["read", "post", "create_channels"];
const ADMIN: Permission[] = [
  ...MEMBER,
  "configure",
  "manage_agents",
  "manage_credentials",
  "manage_connectors",
  "view_usage",
  "manage_members",
];
const PERMISSIONS: Record<MemberRole, ReadonlySet<Permission>> = {
  owner: new Set([...ADMIN, "manage_owners"]),
  admin: new Set(ADMIN),
  member: new Set(MEMBER),
};

export const can = (role: MemberRole, permission: Permission) => PERMISSIONS[role].has(permission);

export interface Membership {
  orgId: string;
  orgName: string;
  role: MemberRole;
  /** The workspace logo URL, when one was uploaded (listMemberships). */
  orgLogo?: string | null;
  /** The workspace's standing (`standing.ts`). */
  standing?: WorkspaceStanding;
}

export async function listMemberships(db: Database, userId: string): Promise<Membership[]> {
  return db
    .select({
      orgId: organizations.id,
      orgName: organizations.name,
      role: organizationMembers.role,
      orgLogo: organizations.logo,
      standing: STANDING_COLUMNS,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.userId, userId), isNull(users.blockedAt)))
    .orderBy(asc(organizations.createdAt));
}

/**
 * A person's membership, or null. A blocked account (`standing.ts`) has none, so every permission check
 * refuses it at once; `includeBlocked` is for acting on them (removing them, changing their role).
 */
export async function getMembership(
  db: Database,
  userId: string,
  orgId: string,
  options: { includeBlocked?: boolean } = {},
): Promise<Membership | null> {
  const [row] = await db
    .select({
      orgId: organizations.id,
      orgName: organizations.name,
      role: organizationMembers.role,
      standing: STANDING_COLUMNS,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(
      and(
        eq(organizationMembers.userId, userId),
        eq(organizationMembers.orgId, orgId),
        options.includeBlocked ? undefined : isNull(users.blockedAt),
      ),
    );
  return row ?? null;
}

/**
 * Throws ForbiddenError unless the user is a member with `permission`, and `org.suspended` for anyone in a
 * suspended workspace. Returns the membership.
 */
export async function requirePermission(db: Database, userId: string, orgId: string, permission: Permission) {
  const membership = await getMembership(db, userId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
  if (membership.standing?.state === "suspended") throw new OrgPausedError(membership.standing);
  if (!can(membership.role, permission)) throw new ForbiddenError();
  return membership;
}

/** Invitations go out only from an active workspace (`standing.ts`). */
function assertInviting(membership: Membership) {
  if (membership.standing && membership.standing.state !== "active") throw new OrgPausedError(membership.standing);
}

/**
 * Creates an organization owned by `userId`, with a `general` channel. Refused while their account is
 * blocked or they are in a workspace on hold or suspended: they don't carry on in a new one
 * (`org.create_refused`, the same words whatever the cause).
 */
export async function createOrganization(db: Database, userId: string, input: { name: string; context?: string }) {
  const [paused] = await db
    .select({ id: organizations.id })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(and(eq(organizationMembers.userId, userId), ne(organizations.standing, "active")))
    .limit(1);
  if (paused || (await isUserBlocked(db, userId)))
    throw new ForbiddenError("You can't create a workspace right now", "org.create_refused");
  return db.transaction(async (tx) => {
    const [organization] = await tx
      .insert(organizations)
      .values({ name: input.name, context: input.context ?? "" })
      .returning();
    if (!organization) throw new Error("organization insert returned nothing");
    await tx.insert(organizationMembers).values({ orgId: organization.id, userId, role: "owner" });
    await assignHandle(tx, organization.id, userId);
    const [general] = await tx
      .insert(channels)
      .values({ orgId: organization.id, name: "general", createdByUserId: userId })
      .returning();
    if (!general) throw new Error("channel insert returned nothing");
    await tx.insert(channelMembers).values({ orgId: organization.id, channelId: general.id, userId });
    await recordOperatorEvent(tx, {
      type: "organization.created",
      orgId: organization.id,
      userId,
      data: { name: organization.name },
    });
    return { organization, general };
  });
}

export async function updateOrganization(
  db: Database,
  actorId: string,
  orgId: string,
  input: { name?: string; context?: string },
) {
  const before = await requirePermission(db, actorId, orgId, "configure");
  const [row] = await db.update(organizations).set(input).where(eq(organizations.id, orgId)).returning();
  if (row && row.name !== before.orgName) await followWorkspaceName(db, orgId, before.orgName, row.name);
  caches.orgs.delete(`${orgId}:`);
  return row;
}

export async function getOrganization(db: Database, orgId: string) {
  const [row] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  return row ?? null;
}

// ── Sign-up policy (ADR 0006) ────────────────────────────────────────────────

export async function countUsers(db: Database): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  return row?.n ?? 0;
}

/**
 * Self-hosted sign-up policy: the first account may always register (there is
 * no other way in); after that, only with ALLOW_SIGNUP or a pending
 * invitation for that email (or from a valid org invite link). Open sign-up on a reachable server would let
 * anyone create organizations (and spend model credits) on it.
 */
export async function isSignupAllowed(
  db: Database,
  email: string,
  allowSignup: boolean,
  now = new Date(),
  /** The token of an org invite link the person is signing up from. */
  inviteToken?: string | null,
) {
  if (allowSignup) return true;
  if ((await countUsers(db)) === 0) return true;
  if (inviteToken) {
    const link = await findInviteLink(db, inviteToken);
    if (link && !link.link.revokedAt && link.link.expiresAt > now) return true;
  }
  const [invite] = await db
    .select({ id: organizationInvitations.id })
    .from(organizationInvitations)
    .where(
      and(
        eq(organizationInvitations.email, email.toLowerCase()),
        isNull(organizationInvitations.acceptedAt),
        gt(organizationInvitations.expiresAt, now),
      ),
    )
    .limit(1);
  return invite !== undefined;
}

export type SignInProvider = "google" | "github" | "apple";
const SIGN_IN_PROVIDERS = new Set<string>(["google", "github", "apple"]);

/**
 * The sign-in screen asks for the e-mail first, then shows the one next step:
 * the password, the provider the account signs in with, or the sign-up (when
 * allowed for that e-mail). This tells whether the e-mail has an account, so
 * the route that serves it is rate limited.
 */
export async function signInOptions(db: Database, email: string, allowSignup: boolean, inviteToken?: string | null) {
  const rows = await db
    .select({ providerId: accounts.providerId })
    .from(users)
    .leftJoin(accounts, eq(accounts.userId, users.id))
    .where(eq(users.email, email.trim().toLowerCase()));
  if (rows.length === 0) {
    return {
      account: false,
      password: false,
      providers: [] as SignInProvider[],
      canSignUp: await isSignupAllowed(db, email, allowSignup, new Date(), inviteToken),
    };
  }
  const ids = rows.map((r) => r.providerId).filter((id): id is string => id !== null);
  return {
    account: true,
    password: ids.includes("credential"),
    providers: [...new Set(ids.filter((id) => SIGN_IN_PROVIDERS.has(id)))] as SignInProvider[],
    canSignUp: false,
  };
}

/**
 * Runs after a user is created. The very first account of an installation
 * becomes owner of every organization that already exists, so a self-hoster
 * who seeded data first lands in it.
 */
export async function onUserCreated(db: Database, userId: string) {
  if ((await countUsers(db)) !== 1) return;
  const existing = await db.select({ id: organizations.id }).from(organizations);
  if (existing.length === 0) return;
  await db
    .insert(organizationMembers)
    .values(existing.map((o) => ({ orgId: o.id, userId, role: "owner" as const })))
    .onConflictDoNothing();
}

// ── Members ──────────────────────────────────────────────────────────────────

/** Members with their handle and time zone (the org's when they didn't pick one). */
export async function listMembers(db: Database, orgId: string) {
  const query = () =>
    db
      .select({
        userId: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
        role: organizationMembers.role,
        joinedAt: organizationMembers.createdAt,
        lastSeenAt: organizationMembers.lastSeenAt,
        handle: organizationMembers.handle,
        ownTimezone: organizationMembers.timezone,
        orgTimezone: schema.organizationSettings.timezone,
      })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .leftJoin(schema.organizationSettings, eq(schema.organizationSettings.orgId, organizationMembers.orgId))
      .where(eq(organizationMembers.orgId, orgId))
      .orderBy(asc(organizationMembers.createdAt));
  let rows = await query();
  if (rows.some((r) => !r.handle)) {
    for (const r of rows) if (!r.handle) await assignHandle(db, orgId, r.userId);
    rows = await query();
  }
  return rows.map(({ ownTimezone, orgTimezone, handle, ...r }) => ({
    ...r,
    /** The photo uploaded here (`PUT …/me/avatar`); `image` may also be a sign-in provider's. */
    avatarUrl: r.image?.startsWith("/api/app/avatars/") ? r.image : null,
    handle: handle ?? "",
    timezone: ownTimezone ?? orgTimezone ?? "UTC",
  }));
}

export const PERSON_HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;

/** "Ana Souza" → "ana"; "João" → "joao"; falls back to the email's local part. */
export function handleBase(name: string, email: string) {
  const slug = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "");
  const first = slug(name.trim().split(/\s+/)[0] ?? "");
  const local = slug(email.split("@")[0] ?? "");
  const base = (first.length >= 2 ? first : local.length >= 2 ? local : "person").slice(0, 24);
  return base;
}

/** Gives a member a handle unique in the org (`ana`, `ana-2`…), unless they have one. */
export async function assignHandle(db: Executor, orgId: string, userId: string) {
  const [row] = await db
    .select({ handle: organizationMembers.handle, name: users.name, email: users.email })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  if (!row || row.handle) return row?.handle ?? null;
  const base = handleBase(row.name, row.email);
  const taken = new Set(
    (
      await db
        .select({ handle: organizationMembers.handle })
        .from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), sql`${organizationMembers.handle} like ${`${base}%`}`))
    ).map((r) => r.handle),
  );
  let handle = base;
  for (let n = 2; taken.has(handle); n++) handle = `${base}-${n}`;
  await db
    .update(organizationMembers)
    .set({ handle })
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  return handle;
}

/** A person changes their own handle (unique in the org, not an agent's) or time zone (null = the org's). */
export async function updateMyProfile(
  db: Database,
  userId: string,
  orgId: string,
  input: { handle?: string; timezone?: string | null },
) {
  await requirePermission(db, userId, orgId, "read");
  const set: { handle?: string; timezone?: string | null } = {};
  if (input.handle !== undefined) {
    const handle = input.handle.trim().replace(/^@/, "").toLowerCase();
    if (!PERSON_HANDLE_PATTERN.test(handle)) {
      throw new ValidationError("handle: 2 to 32 lowercase letters, numbers, - or _", "handle.invalid", {
        min: 2,
        max: 32,
      });
    }
    const [agent] = await db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(and(eq(schema.agents.orgId, orgId), eq(schema.agents.handle, handle), isNull(schema.agents.archivedAt)));
    if (agent) throw new ConflictError(`@${handle} belongs to an agent`, "handle.taken_by_agent", { handle });
    const [other] = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.handle, handle)));
    if (other && other.userId !== userId) throw new ConflictError(`@${handle} is taken`, "handle.taken", { handle });
    set.handle = handle;
  }
  if (input.timezone !== undefined) {
    if (input.timezone !== null) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
      } catch {
        throw new ValidationError("timezone must be an IANA time zone");
      }
    }
    set.timezone = input.timezone;
  }
  if (Object.keys(set).length > 0) {
    await db
      .update(organizationMembers)
      .set(set)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
    caches.zones.delete(`${orgId}:${userId}`);
  }
  const me = (await listMembers(db, orgId)).find((m) => m.userId === userId);
  if (!me) throw new ForbiddenError("You are not a member of this organization");
  return me;
}

/** The languages of the app (`users.locale`): emails and pushes are written in it. */
export const USER_LOCALES = ["pt-BR", "en"] as const;
export type UserLocale = (typeof USER_LOCALES)[number];

/** Saves the person's app language (picked up from the onboarding). */
export async function setMyLocale(db: Database, userId: string, locale: UserLocale) {
  if (!USER_LOCALES.includes(locale)) throw new ValidationError("locale must be pt-BR or en");
  await db.update(users).set({ locale }).where(eq(users.id, userId));
}

async function ownerCount(db: Pick<Database, "select">, orgId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, "owner")));
  return row?.n ?? 0;
}

/** Changes a member's role. Admins can't touch owners or make owners; nobody can demote the last owner. */
export async function changeMemberRole(
  db: Database,
  actorId: string,
  orgId: string,
  targetUserId: string,
  role: MemberRole,
) {
  const actor = await requirePermission(db, actorId, orgId, "manage_members");
  const target = await getMembership(db, targetUserId, orgId, { includeBlocked: true });
  if (!target) throw new ConflictError("That user is not a member");
  if ((target.role === "owner" || role === "owner") && !can(actor.role, "manage_owners")) {
    throw new ForbiddenError("Only owners can grant or revoke ownership");
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`org-members:${orgId}`}))`);
    if (target.role === "owner" && role !== "owner" && (await ownerCount(tx, orgId)) <= 1) {
      throw new ConflictError("An organization needs at least one owner");
    }
    await tx
      .update(organizationMembers)
      .set({ role })
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, targetUserId)));
  });
}

/** Removes a member (or lets a member leave). The last owner can't leave. */
export async function removeMember(
  db: Database,
  actorId: string,
  orgId: string,
  targetUserId: string,
  options: { pubsub?: PubSub } = {},
) {
  // Admins can remove a blocked member; a blocked person can't act, not even to leave.
  const target = await getMembership(db, targetUserId, orgId, { includeBlocked: actorId !== targetUserId });
  if (!target) return;
  if (actorId !== targetUserId) {
    const actor = await requirePermission(db, actorId, orgId, "manage_members");
    if (target.role === "owner" && !can(actor.role, "manage_owners"))
      throw new ForbiddenError("Only owners can remove owners");
  }
  // Loaded here: the accounts module builds on this one.
  const { announceReleasedAccounts, releaseMemberAccounts } = await import("./machine-accounts");
  const released = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`org-members:${orgId}`}))`);
    if (target.role === "owner" && (await ownerCount(tx, orgId)) <= 1) {
      throw new ConflictError("An organization needs at least one owner. Transfer ownership first.");
    }
    await tx
      .delete(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, targetUserId)));
    // Leaving the organization also leaves its channels.
    await tx
      .delete(channelMembers)
      .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.userId, targetUserId)));
    // Their AI accounts on the organization's computers are signed out and removed (ADR 0059 §1).
    return releaseMemberAccounts(tx, targetUserId, orgId);
  });
  await announceReleasedAccounts(options.pubsub, released);
  // Their open WebSocket connections lose every subscription now, not on reconnect.
  await publishOrgEvent(options.pubsub, { type: "membership.revoked", orgId, userId: targetUserId });
  // Their routines pause at once and their work stops; the agents' owners hear it (ADR 0053 §6.2).
  // Loaded here: the routine engine builds on this module.
  const { pauseRoutinesOfCreator } = await import("./routine-firing");
  await pauseRoutinesOfCreator({ db, pubsub: options.pubsub }, orgId, targetUserId).catch(() => 0);
}

/**
 * Deletes a person's account (App Store 5.1.1(v), ADR 0035). Refused while
 * they are the only owner of an organization that has other members
 * (`sole_owner`, with the organizations' names: make someone else an owner
 * first). Organizations where they are the only member go with them, with
 * everything in them. Their AI accounts on computers are signed out and
 * removed, never inherited (ADR 0059 §1). The rest follows the foreign keys:
 * sessions, sign-in methods, memberships, channel memberships, notifications
 * and phones are deleted; messages and records they authored stay without an
 * author (the same as any deleted user). Not for a blocked account: it can't
 * act, and its workspaces would go with it.
 */
export async function deleteAccount(
  db: Database,
  userId: string,
  options: { pubsub?: PubSub } = {},
): Promise<{ deletedOrgIds: string[] }> {
  if (await isUserBlocked(db, userId)) throw new ForbiddenError();
  const { announceReleasedAccounts, releaseMemberAccounts } = await import("./machine-accounts");
  const { left, deleted, released } = await db.transaction(async (tx) => {
    const mine = await tx
      .select({ orgId: organizations.id, orgName: organizations.name, role: organizationMembers.role })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
      .where(eq(organizationMembers.userId, userId))
      .orderBy(asc(organizations.id));
    // Same lock as role changes and removals, in a fixed order.
    for (const m of mine) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`org-members:${m.orgId}`}))`);
    const alone: string[] = [];
    const leaving: string[] = [];
    const blocking: string[] = [];
    for (const m of mine) {
      const [row] = await tx
        .select({
          members: sql<number>`count(*)::int`,
          owners: sql<number>`(count(*) filter (where ${organizationMembers.role} = 'owner'))::int`,
        })
        .from(organizationMembers)
        .where(eq(organizationMembers.orgId, m.orgId));
      if (Number(row?.members ?? 0) <= 1) alone.push(m.orgId);
      else {
        if (m.role === "owner" && Number(row?.owners ?? 0) <= 1) blocking.push(m.orgName);
        leaving.push(m.orgId);
      }
    }
    if (blocking.length > 0) {
      throw new ConflictError(
        "You are the only owner of an organization that has other members. Make someone else an owner first.",
        "sole_owner",
        { organizations: blocking },
      );
    }
    // Before the user row: `created_by` would turn null, and a null owner is nobody's.
    const released = await releaseMemberAccounts(tx, userId, null);
    if (alone.length > 0) await tx.delete(organizations).where(inArray(organizations.id, alone));
    await tx.delete(users).where(eq(users.id, userId));
    const gone = alone.map((orgId): OperatorEvent => ({ type: "organization.deleted", orgId, userId }));
    await recordOperatorEvent(tx, ...gone, { type: "user.deleted", userId });
    return { left: leaving, deleted: alone, released };
  });
  await announceReleasedAccounts(options.pubsub, {
    machines: released.machines.filter((m) => left.includes(m.orgId)),
    agents: released.agents.filter((a) => left.includes(a.orgId)),
  });
  // Their open WebSocket connections lose every subscription now.
  for (const orgId of left) await publishOrgEvent(options.pubsub, { type: "membership.revoked", orgId, userId });
  return { deletedOrgIds: deleted };
}

/**
 * The Apple tokens of a person's "Sign in with Apple" accounts, to revoke
 * when the account is deleted (read before `deleteAccount`, which deletes
 * them). The refresh token when Better Auth kept one, else the access token.
 */
export async function appleSignInTokens(
  db: Database,
  userId: string,
): Promise<{ value: string; hint: "refresh_token" | "access_token" }[]> {
  const rows = await db
    .select({ refreshToken: schema.accounts.refreshToken, accessToken: schema.accounts.accessToken })
    .from(schema.accounts)
    .where(and(eq(schema.accounts.userId, userId), eq(schema.accounts.providerId, "apple")));
  return rows.flatMap((r): { value: string; hint: "refresh_token" | "access_token" }[] =>
    r.refreshToken
      ? [{ value: r.refreshToken, hint: "refresh_token" as const }]
      : r.accessToken
        ? [{ value: r.accessToken, hint: "access_token" as const }]
        : [],
  );
}

// ── Invitations ──────────────────────────────────────────────────────────────

export const INVITATION_TTL_DAYS = 7;

export async function createInvitation(
  db: Database,
  actorId: string,
  orgId: string,
  input: { email: string; role: MemberRole },
  now = new Date(),
) {
  const actor = await requirePermission(db, actorId, orgId, "manage_members");
  assertInviting(actor);
  if (input.role === "owner" && !can(actor.role, "manage_owners"))
    throw new ForbiddenError("Only owners can invite owners");
  const email = input.email.trim().toLowerCase();

  const [alreadyMember] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
    .where(and(eq(users.email, email), eq(organizationMembers.orgId, orgId)));
  if (alreadyMember) throw new ConflictError(`${email} is already a member`);

  const token = randomToken(32);
  const [invitation] = await db
    .insert(organizationInvitations)
    .values({
      orgId,
      email,
      role: input.role,
      tokenHash: sha256(token),
      invitedByUserId: actorId,
      expiresAt: new Date(now.getTime() + INVITATION_TTL_DAYS * 86_400_000),
    })
    .returning();
  if (!invitation) throw new Error("invitation insert returned nothing");
  await recordOperatorEvent(db, {
    type: "invitation.created",
    orgId,
    userId: actorId,
    data: { emailDomain: addressDomain(email), role: input.role },
  });
  /** `token` goes in the link and is never stored. */
  return { invitation, token };
}

export async function listInvitations(db: Database, orgId: string, now = new Date()) {
  return db
    .select({
      id: organizationInvitations.id,
      email: organizationInvitations.email,
      role: organizationInvitations.role,
      expiresAt: organizationInvitations.expiresAt,
      createdAt: organizationInvitations.createdAt,
    })
    .from(organizationInvitations)
    .where(
      and(
        eq(organizationInvitations.orgId, orgId),
        isNull(organizationInvitations.acceptedAt),
        gt(organizationInvitations.expiresAt, now),
      ),
    )
    .orderBy(asc(organizationInvitations.createdAt));
}

export async function revokeInvitation(db: Database, actorId: string, orgId: string, invitationId: string) {
  await requirePermission(db, actorId, orgId, "manage_members");
  await db
    .delete(organizationInvitations)
    .where(and(eq(organizationInvitations.id, invitationId), eq(organizationInvitations.orgId, orgId)));
}

/**
 * An organization-wide invite link (admins): whoever opens it signed in joins
 * as a member, for 7 days. Uses the same `/invite/{token}` page and accept
 * endpoint as email invitations.
 */
export async function createInviteLink(db: Database, actorId: string, orgId: string, now = new Date()) {
  assertInviting(await requirePermission(db, actorId, orgId, "manage_members"));
  const token = randomToken(32);
  const [link] = await db
    .insert(organizationInviteLinks)
    .values({
      orgId,
      role: "member",
      tokenHash: sha256(token),
      createdByUserId: actorId,
      expiresAt: new Date(now.getTime() + INVITATION_TTL_DAYS * 86_400_000),
    })
    .returning();
  if (!link) throw new Error("invite link insert returned nothing");
  await recordOperatorEvent(db, { type: "invitation.created", orgId, userId: actorId, data: { link: true } });
  return { link, token };
}

async function findInviteLink(db: Database, token: string) {
  const [row] = await db
    .select({ link: organizationInviteLinks, orgName: organizations.name })
    .from(organizationInviteLinks)
    .innerJoin(organizations, eq(organizations.id, organizationInviteLinks.orgId))
    .where(eq(organizationInviteLinks.tokenHash, sha256(token)));
  return row ?? null;
}

/** How many of the organization's agents an invitation shows ("Ada, Theo e Lia já trabalham lá"). */
const INVITE_AGENTS = 3;

/** The organization's first agents (not archived), for an invitation page: name and look only. */
async function inviteAgents(db: Database, orgId: string) {
  return db
    .select({ id: agents.id, name: agents.name, appearance: agents.appearance })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .orderBy(asc(agents.createdAt))
    .limit(INVITE_AGENTS);
}

/**
 * What the invite page shows before signing in (`email` is empty for an org link): the organization, who
 * invited (their name), the role and a few of its agents. Only for a valid token, which reached the person.
 */
export async function previewInvitation(db: Database, token: string, now = new Date()) {
  const [row] = await db
    .select({
      orgId: organizationInvitations.orgId,
      orgName: organizations.name,
      email: organizationInvitations.email,
      role: organizationInvitations.role,
      expiresAt: organizationInvitations.expiresAt,
      acceptedAt: organizationInvitations.acceptedAt,
      invitedBy: users.name,
    })
    .from(organizationInvitations)
    .innerJoin(organizations, eq(organizations.id, organizationInvitations.orgId))
    .leftJoin(users, eq(users.id, organizationInvitations.invitedByUserId))
    .where(eq(organizationInvitations.tokenHash, sha256(token)));
  if (!row) {
    const link = await findInviteLink(db, token);
    if (!link || link.link.revokedAt || link.link.expiresAt <= now) return null;
    const [creator] = link.link.createdByUserId
      ? await db.select({ name: users.name }).from(users).where(eq(users.id, link.link.createdByUserId))
      : [];
    return {
      orgName: link.orgName,
      email: "",
      role: link.link.role,
      kind: "link" as const,
      invitedBy: creator?.name ?? null,
      agents: await inviteAgents(db, link.link.orgId),
    };
  }
  if (row.acceptedAt || row.expiresAt <= now) return null;
  return {
    orgName: row.orgName,
    email: row.email,
    role: row.role,
    kind: "email" as const,
    invitedBy: row.invitedBy ?? null,
    agents: await inviteAgents(db, row.orgId),
  };
}

/**
 * Accepts an invitation. The signed-in user's email must match the invited one. Joins `general`. Not for
 * a blocked account, nor into a workspace on hold or suspended.
 */
export async function acceptInvitation(
  db: Database,
  user: { id: string; email: string },
  token: string,
  now = new Date(),
) {
  if (await isUserBlocked(db, user.id)) throw new ForbiddenError();
  return db.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.tokenHash, sha256(token)))
      .for("update");
    if (!invitation) {
      // An org-wide link: any signed-in person joins as its role.
      const [link] = await tx
        .select()
        .from(organizationInviteLinks)
        .where(eq(organizationInviteLinks.tokenHash, sha256(token)))
        .for("update");
      if (!link || link.revokedAt || link.expiresAt <= now) {
        throw new ConflictError("This invitation is invalid or has expired");
      }
      // Nobody joins a workspace on hold or suspended.
      await assertCanWork(tx, link.orgId);
      await joinOrganization(tx, link.orgId, user.id, link.role);
      await tx
        .update(organizationInviteLinks)
        .set({ uses: sql`${organizationInviteLinks.uses} + 1` })
        .where(eq(organizationInviteLinks.id, link.id));
      return { orgId: link.orgId };
    }
    if (invitation.acceptedAt || invitation.expiresAt <= now) {
      throw new ConflictError("This invitation is invalid or has expired");
    }
    if (invitation.email !== user.email.toLowerCase()) {
      throw new ForbiddenError(
        `This invitation was sent to ${invitation.email}. Sign in with that address to accept it.`,
      );
    }
    await assertCanWork(tx, invitation.orgId);
    await joinOrganization(tx, invitation.orgId, user.id, invitation.role);
    await tx
      .update(organizationInvitations)
      .set({ acceptedAt: now })
      .where(eq(organizationInvitations.id, invitation.id));
    return { orgId: invitation.orgId };
  });
}

/** Adds a person to an organization (keeping an existing role) and to `general`. */
async function joinOrganization(tx: Executor, orgId: string, userId: string, role: MemberRole) {
  await tx.insert(organizationMembers).values({ orgId, userId, role }).onConflictDoNothing();
  await assignHandle(tx, orgId, userId);
  const [general] = await tx
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.orgId, orgId), eq(channels.name, "general")));
  if (general) {
    await tx.insert(channelMembers).values({ orgId, channelId: general.id, userId }).onConflictDoNothing();
  }
}

/** Marks a person as seen now in an organization (WebSocket connect/disconnect). */
export async function touchLastSeen(db: Database, orgId: string, userId: string, at = new Date()) {
  await db
    .update(organizationMembers)
    .set({ lastSeenAt: at })
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
}

export type InviteOutcome =
  | { email: string; status: "invited"; invitationId: string; token: string }
  | { email: string; status: "already_member" | "invalid_email" | "already_invited"; invitationId?: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Invites several people at once (the Members screen takes a comma-separated
 * list). Each email gets its own outcome; pending invitations are not
 * duplicated (resend them instead).
 */
export async function inviteMany(
  db: Database,
  actorId: string,
  orgId: string,
  input: { emails: string[]; role: MemberRole },
  now = new Date(),
): Promise<InviteOutcome[]> {
  await requirePermission(db, actorId, orgId, "manage_members");
  const emails = [...new Set(input.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))].slice(0, 100);
  const out: InviteOutcome[] = [];
  for (const email of emails) {
    if (!EMAIL.test(email)) {
      out.push({ email, status: "invalid_email" });
      continue;
    }
    const [pending] = await db
      .select({ id: organizationInvitations.id })
      .from(organizationInvitations)
      .where(
        and(
          eq(organizationInvitations.orgId, orgId),
          eq(organizationInvitations.email, email),
          isNull(organizationInvitations.acceptedAt),
          gt(organizationInvitations.expiresAt, now),
        ),
      );
    if (pending) {
      out.push({ email, status: "already_invited", invitationId: pending.id });
      continue;
    }
    try {
      const { invitation, token } = await createInvitation(db, actorId, orgId, { email, role: input.role }, now);
      out.push({ email, status: "invited", invitationId: invitation.id, token });
    } catch (error) {
      if (error instanceof ConflictError) out.push({ email, status: "already_member" });
      else throw error;
    }
  }
  return out;
}

/** Sends an invitation again: a new token (the old link stops working) and a fresh 7-day expiry. */
export async function resendInvitation(
  db: Database,
  actorId: string,
  orgId: string,
  invitationId: string,
  now = new Date(),
) {
  const actor = await requirePermission(db, actorId, orgId, "manage_members");
  assertInviting(actor);
  const [existing] = await db
    .select()
    .from(organizationInvitations)
    .where(and(eq(organizationInvitations.id, invitationId), eq(organizationInvitations.orgId, orgId)));
  if (!existing || existing.acceptedAt) throw new ConflictError("This invitation can't be resent");
  if (existing.role === "owner" && !can(actor.role, "manage_owners"))
    throw new ForbiddenError("Only owners can invite owners");
  const token = randomToken(32);
  const [invitation] = await db
    .update(organizationInvitations)
    .set({
      tokenHash: sha256(token),
      expiresAt: new Date(now.getTime() + INVITATION_TTL_DAYS * 86_400_000),
      invitedByUserId: actorId,
    })
    .where(eq(organizationInvitations.id, invitationId))
    .returning();
  if (!invitation) throw new ConflictError("This invitation can't be resent");
  await recordOperatorEvent(db, {
    type: "invitation.created",
    orgId,
    userId: actorId,
    data: { emailDomain: addressDomain(invitation.email), role: invitation.role, resent: true },
  });
  return { invitation, token };
}

/** Invitations not yet accepted, expired ones included, with their status. */
export async function listInvitationsWithStatus(db: Database, actorId: string, orgId: string, now = new Date()) {
  await requirePermission(db, actorId, orgId, "manage_members");
  const rows = await db
    .select()
    .from(organizationInvitations)
    .where(and(eq(organizationInvitations.orgId, orgId), isNull(organizationInvitations.acceptedAt)))
    .orderBy(asc(organizationInvitations.createdAt));
  return rows.map((i) => ({
    id: i.id,
    email: i.email,
    role: i.role,
    status: i.expiresAt > now ? ("pending" as const) : ("expired" as const),
    expiresAt: i.expiresAt,
    createdAt: i.createdAt,
    invitedByUserId: i.invitedByUserId,
  }));
}
