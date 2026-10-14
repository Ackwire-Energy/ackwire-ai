import { and, asc, type Database, eq, gt, isNull, schema, sql } from "@agenteschat/db";
import { randomToken, sha256 } from "./crypto";
import { ConflictError, ForbiddenError } from "./errors";

const { organizations, organizationMembers, organizationInvitations, channels, channelMembers, users } = schema;

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
  | "view_usage" // tokens and cost of every agent
  | "manage_members" // invite, remove, change roles (except owners)
  | "manage_owners"; // grant/revoke owner

const MEMBER: Permission[] = ["read", "post", "create_channels"];
const ADMIN: Permission[] = [
  ...MEMBER,
  "configure",
  "manage_agents",
  "manage_credentials",
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
}

export async function listMemberships(db: Database, userId: string): Promise<Membership[]> {
  return db
    .select({ orgId: organizations.id, orgName: organizations.name, role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(eq(organizationMembers.userId, userId))
    .orderBy(asc(organizations.createdAt));
}

export async function getMembership(db: Database, userId: string, orgId: string): Promise<Membership | null> {
  const [row] = await db
    .select({ orgId: organizations.id, orgName: organizations.name, role: organizationMembers.role })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.orgId, orgId)));
  return row ?? null;
}

/** Throws ForbiddenError unless the user is a member with `permission`. Returns the membership. */
export async function requirePermission(db: Database, userId: string, orgId: string, permission: Permission) {
  const membership = await getMembership(db, userId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
  if (!can(membership.role, permission)) throw new ForbiddenError();
  return membership;
}

/** Creates an organization owned by `userId`, with a `general` channel. */
export async function createOrganization(db: Database, userId: string, input: { name: string; context?: string }) {
  return db.transaction(async (tx) => {
    const [organization] = await tx
      .insert(organizations)
      .values({ name: input.name, context: input.context ?? "" })
      .returning();
    if (!organization) throw new Error("organization insert returned nothing");
    await tx.insert(organizationMembers).values({ orgId: organization.id, userId, role: "owner" });
    const [general] = await tx
      .insert(channels)
      .values({ orgId: organization.id, name: "general", createdByUserId: userId })
      .returning();
    if (!general) throw new Error("channel insert returned nothing");
    await tx.insert(channelMembers).values({ orgId: organization.id, channelId: general.id, userId });
    return { organization, general };
  });
}

export async function updateOrganization(
  db: Database,
  actorId: string,
  orgId: string,
  input: { name?: string; context?: string },
) {
  await requirePermission(db, actorId, orgId, "configure");
  const [row] = await db.update(organizations).set(input).where(eq(organizations.id, orgId)).returning();
  return row;
}

export async function getOrganization(db: Database, orgId: string) {
  const [row] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  return row ?? null;
}

// ── Sign-up policy (same model as Tierbird, ADR 0011 there) ──────────────────

export async function countUsers(db: Database): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  return row?.n ?? 0;
}

/**
 * Self-hosted sign-up policy: the first account may always register (there is
 * no other way in); after that, only with ALLOW_SIGNUP or a pending
 * invitation for that email. Open sign-up on a reachable server would let
 * anyone create organizations (and spend model credits) on it.
 */
export async function isSignupAllowed(db: Database, email: string, allowSignup: boolean, now = new Date()) {
  if (allowSignup) return true;
  if ((await countUsers(db)) === 0) return true;
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

export async function listMembers(db: Database, orgId: string) {
  return db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
      role: organizationMembers.role,
      joinedAt: organizationMembers.createdAt,
    })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(organizationMembers.orgId, orgId))
    .orderBy(asc(organizationMembers.createdAt));
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
  const target = await getMembership(db, targetUserId, orgId);
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
export async function removeMember(db: Database, actorId: string, orgId: string, targetUserId: string) {
  const target = await getMembership(db, targetUserId, orgId);
  if (!target) return;
  if (actorId !== targetUserId) {
    const actor = await requirePermission(db, actorId, orgId, "manage_members");
    if (target.role === "owner" && !can(actor.role, "manage_owners"))
      throw new ForbiddenError("Only owners can remove owners");
  }
  await db.transaction(async (tx) => {
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
  });
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

/** What the invite page shows before signing in. */
export async function previewInvitation(db: Database, token: string, now = new Date()) {
  const [row] = await db
    .select({
      orgName: organizations.name,
      email: organizationInvitations.email,
      role: organizationInvitations.role,
      expiresAt: organizationInvitations.expiresAt,
      acceptedAt: organizationInvitations.acceptedAt,
    })
    .from(organizationInvitations)
    .innerJoin(organizations, eq(organizations.id, organizationInvitations.orgId))
    .where(eq(organizationInvitations.tokenHash, sha256(token)));
  if (!row || row.acceptedAt || row.expiresAt <= now) return null;
  return { orgName: row.orgName, email: row.email, role: row.role };
}

/** Accepts an invitation. The signed-in user's email must match the invited one. Joins `general`. */
export async function acceptInvitation(
  db: Database,
  user: { id: string; email: string },
  token: string,
  now = new Date(),
) {
  return db.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.tokenHash, sha256(token)))
      .for("update");
    if (!invitation || invitation.acceptedAt || invitation.expiresAt <= now) {
      throw new ConflictError("This invitation is invalid or has expired");
    }
    if (invitation.email !== user.email.toLowerCase()) {
      throw new ForbiddenError(
        `This invitation was sent to ${invitation.email}. Sign in with that address to accept it.`,
      );
    }
    await tx
      .insert(organizationMembers)
      .values({ orgId: invitation.orgId, userId: user.id, role: invitation.role })
      .onConflictDoNothing();
    const [general] = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.orgId, invitation.orgId), eq(channels.name, "general")));
    if (general) {
      await tx
        .insert(channelMembers)
        .values({ orgId: invitation.orgId, channelId: general.id, userId: user.id })
        .onConflictDoNothing();
    }
    await tx
      .update(organizationInvitations)
      .set({ acceptedAt: now })
      .where(eq(organizationInvitations.id, invitation.id));
    return { orgId: invitation.orgId };
  });
}
