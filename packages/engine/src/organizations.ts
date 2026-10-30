import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  desc,
  type Executor,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  or,
  schema,
  sql,
} from "@agenteschat/db";
import { appLocale } from "@agenteschat/i18n/locale";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { inviteLinkToken, randomToken, sha256 } from "./crypto";
import { earlyAccessLink, hasWorkspaceAllowance, recordFirstWorkspace, signupMode } from "./early-access";
import { ConflictError, ForbiddenError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import { deleteJevKey } from "./jev-key";
import { followWorkspaceName } from "./machine-provisioning";
import { addressDomain } from "./mail/text";
import { type OperatorEvent, recordOperatorEvent } from "./operator-events";
import { enqueue } from "./outbox";
import {
  assertCanWork,
  cloudNotice,
  isUserBlocked,
  OrgPausedError,
  STANDING_COLUMNS,
  type WorkspaceStanding,
} from "./standing";

const {
  organizations,
  organizationMembers,
  organizationInvitations,
  organizationInviteLinks,
  organizationJoinRequests,
  channels,
  channelMembers,
  users,
  accounts,
  agents,
  instanceTelemetry,
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

/** Refuses a suspended workspace without changing membership/status lookups. */
export function assertActiveMembership(membership: Membership): void {
  if (membership.standing?.state === "suspended") throw new OrgPausedError(membership.standing);
}

/** Requires an active organization member before acting on its resources. */
export async function requireActiveMembership(db: Database, userId: string, orgId: string): Promise<Membership> {
  const membership = await getMembership(db, userId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
  assertActiveMembership(membership);
  return membership;
}

/**
 * Throws ForbiddenError unless the user is a member with `permission`, and `org.suspended` for anyone in a
 * suspended workspace. Returns the membership.
 */
export async function requirePermission(db: Database, userId: string, orgId: string, permission: Permission) {
  const membership = await requireActiveMembership(db, userId, orgId);
  if (!can(membership.role, permission)) throw new ForbiddenError();
  return membership;
}

/** Invitations go out only from an active workspace (`standing.ts`). */
export function assertInviting(membership: Membership) {
  if (membership.standing && membership.standing.state !== "active") throw new OrgPausedError(membership.standing);
}

/**
 * Creates an organization owned by `userId`, with a `general` channel. Refused while their account is
 * blocked or they are in a workspace on hold or suspended: they don't carry on in a new one
 * (`org.create_refused`, the same words whatever the cause, and how to contest it on agentes.chat Cloud).
 * With `needsAllowance` (`needsWorkspaceAllowance`) early access must have allowed the account, else
 * `org.create_invite_only` and nothing is made. An allowed account's first workspace is recorded on its invitation.
 */
export async function createOrganization(
  db: Database,
  userId: string,
  input: { name: string; context?: string },
  options: { needsAllowance?: boolean } = {},
) {
  const [paused] = await db
    .select({ id: organizations.id })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .where(and(eq(organizationMembers.userId, userId), ne(organizations.standing, "active")))
    .limit(1);
  if (paused || (await isUserBlocked(db, userId)))
    throw new ForbiddenError("You can't create a workspace right now", "org.create_refused", cloudNotice());
  if (options.needsAllowance && !(await hasWorkspaceAllowance(db, userId)))
    throw new ForbiddenError("New workspaces need an invitation for now", "org.create_invite_only");
  return db.transaction(async (tx) => {
    const [organization] = await tx
      .insert(organizations)
      .values({ name: input.name, context: input.context ?? "" })
      .returning();
    if (!organization) throw new Error("organization insert returned nothing");
    await recordFirstWorkspace(tx, userId, organization.id);
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
  if (row) {
    // The context goes into every agent's prompt: the audit says it changed, not what it says.
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "organization.updated",
      target: { type: "organization", id: orgId },
      details: {
        name: row.name,
        ...(row.name !== before.orgName ? { from: before.orgName } : {}),
        ...(input.context !== undefined ? { contextChanged: true } : {}),
      },
    });
  }
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

/** The installation's first account: the person who set it up. */
export async function installOwner(db: Database): Promise<string | null> {
  const [first] = await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt), asc(users.id)).limit(1);
  return first?.id ?? null;
}

/**
 * Who has the installation's own settings, the usage report's switch and the Jev key (ADR 0073): its first account,
 * pinned the first time anyone asks. Unlike `installOwner`, it never passes to the next oldest account, who may be
 * any member of any workspace: once the owner deletes their account, nobody has these settings here (the server's
 * environment still does), until no account is left and the next first account is pinned.
 */
export async function pinnedOwner(db: Database): Promise<string | null> {
  const [row] = await db
    .select({ owner: instanceTelemetry.ownerUserId })
    .from(instanceTelemetry)
    .where(eq(instanceTelemetry.id, 1));
  if (row?.owner) return row.owner;
  const first = await installOwner(db);
  if (!first) return null;
  const [pinned] = await db
    .insert(instanceTelemetry)
    .values({ ownerUserId: first })
    .onConflictDoUpdate({
      target: instanceTelemetry.id,
      set: { ownerUserId: sql`coalesce(${instanceTelemetry.ownerUserId}, excluded.owner_user_id)` },
    })
    .returning({ owner: instanceTelemetry.ownerUserId });
  return pinned?.owner ?? first;
}

/** Who may create an account (ADR 0006): see `isSignupAllowed`. */
export interface SignupPolicy {
  /** `ALLOW_SIGNUP`: anyone. */
  allowSignup: boolean;
  /** An owner link (`OWNER_CLAIM_SHA256`) or the desktop app's owner key (`OWNER_KEY_SHA256`) makes the first account (ADR 0060 §6). */
  ownerByLink: boolean;
  /** `HOST_COMPUTER_TOKEN`: agents run on this server's own machine, so the live mode never opens sign-up. */
  hostComputer?: boolean;
}

/** Anyone may sign up once the first account exists: `ALLOW_SIGNUP`, or the live mode `open` (ADR 0078). */
export async function signupOpenToAll(db: Database, policy: SignupPolicy) {
  return policy.allowSignup || (!policy.hostComputer && (await signupMode(db)).mode === "open");
}

/** Why a sign-up may go ahead (`signupAdmission`). */
export type SignupAdmission = "open" | "first" | "invitation" | "early_access";

/**
 * Who may create an account (ADR 0006, ADR 0078): the first account may always register (there is no other way
 * in), unless the installation waits for its owner's link or key, which make it on their own path. After that,
 * anyone with `ALLOW_SIGNUP` or while the sign-up mode is `open` (`signupOpenToAll`); else only a pending workspace
 * invitation for that email, or an early-access link (`access`) sent to it. An invitation link never opens it
 * (ADR 0068): whoever holds one asks to join without an account. Open sign-up on a reachable server would let
 * anyone create organizations (and spend model credits) on it. Null: refused.
 */
export async function signupAdmission(
  db: Database,
  email: string,
  policy: SignupPolicy,
  options: { access?: string | null; now?: Date } = {},
): Promise<SignupAdmission | null> {
  const now = options.now ?? new Date();
  const stored = email.trim().toLowerCase();
  if (policy.allowSignup && !policy.ownerByLink) return "open";
  if ((await countUsers(db)) === 0) return policy.ownerByLink ? null : "first";
  if (await signupOpenToAll(db, policy)) return "open";
  const [invite] = await db
    .select({ id: organizationInvitations.id })
    .from(organizationInvitations)
    .where(
      and(
        eq(organizationInvitations.email, stored),
        isNull(organizationInvitations.acceptedAt),
        gt(organizationInvitations.expiresAt, now),
      ),
    )
    .limit(1);
  if (invite) return "invitation";
  const link = await earlyAccessLink(db, options.access);
  return link && link.expiresAt > now && link.email === stored ? "early_access" : null;
}

export async function isSignupAllowed(db: Database, email: string, policy: SignupPolicy, now = new Date()) {
  return (await signupAdmission(db, email, policy, { now })) !== null;
}

/** What decides whether making a workspace needs early access (`needsWorkspaceAllowance`). */
export interface WorkspacePolicy {
  /** agentes.chat Cloud, whose provisioner gives every workspace a computer that costs money (ADR 0056 §10). */
  paidMachines: boolean;
  /** `ALLOW_SIGNUP`. */
  allowSignup: boolean;
}

/**
 * Whether making a workspace needs the account allowed by early access (ADR 0078 §4): on agentes.chat Cloud, where
 * every workspace gets a paid computer, while sign-up is by invitation only, for everyone but the installation's owner.
 */
export async function needsWorkspaceAllowance(db: Database, userId: string, policy: WorkspacePolicy) {
  if (!policy.paidMachines || policy.allowSignup) return false;
  if ((await signupMode(db)).mode === "open") return false;
  return userId !== (await pinnedOwner(db));
}

export async function canCreateWorkspace(db: Database, userId: string, policy: WorkspacePolicy) {
  return !(await needsWorkspaceAllowance(db, userId, policy)) || (await hasWorkspaceAllowance(db, userId));
}

export type SignInProvider = "google" | "github" | "apple";
const SIGN_IN_PROVIDERS = new Set<string>(["google", "github", "apple"]);

/**
 * The sign-in screen asks for the e-mail first, then shows the one next step:
 * the password, the provider the account signs in with, or the sign-up (when
 * allowed for that e-mail, with the early-access link's `access` when the page
 * has one). This tells whether the e-mail has an account, so the route that
 * serves it is rate limited. `accessExpired` speaks only of a link sent to this
 * same address.
 */
export async function signInOptions(
  db: Database,
  email: string,
  policy: SignupPolicy,
  access?: string | null,
  now = new Date(),
) {
  const stored = email.trim().toLowerCase();
  const rows = await db
    .select({ providerId: accounts.providerId })
    .from(users)
    .leftJoin(accounts, eq(accounts.userId, users.id))
    .where(eq(users.email, stored));
  if (rows.length === 0) {
    const canSignUp = (await signupAdmission(db, email, policy, { access, now })) !== null;
    const link = canSignUp ? null : await earlyAccessLink(db, access);
    return {
      account: false,
      password: false,
      providers: [] as SignInProvider[],
      canSignUp,
      ...(link && link.email === stored && link.expiresAt <= now ? { accessExpired: true as const } : {}),
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

/** Whether the account signs in with a password (its credential row has one). */
export async function hasPassword(db: Database, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(eq(accounts.userId, userId), eq(accounts.providerId, "credential"), sql`${accounts.password} is not null`),
    )
    .limit(1);
  return row !== undefined;
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

/**
 * The app language a request's `Accept-Language` asks for: its most preferred English or Portuguese tag
 * ("en-GB,en;q=0.9" → en, "pt-PT" → pt-BR), else null. The web app sends its own language in it.
 */
export function requestLocale(acceptLanguage: string | null | undefined): UserLocale | null {
  const tags = (acceptLanguage ?? "")
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.split(";").map((s) => s.trim().toLowerCase());
      const q = params.find((p) => p.startsWith("q="));
      return { tag, q: q ? Number(q.slice(2)) : 1 };
    })
    .filter((l) => l.q > 0)
    .sort((a, b) => b.q - a.q);
  return appLocale(tags.map((l) => l.tag));
}

/** Whether the person opened the link that confirms their email, read here: a session's cached copy can lag. */
export async function isEmailVerified(db: Database, userId: string) {
  const [row] = await db.select({ verified: users.emailVerified }).from(users).where(eq(users.id, userId));
  return row?.verified === true;
}

async function ownerCount(db: Pick<Database, "select">, orgId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, "owner")));
  return row?.n ?? 0;
}

/** Someone joined or left, or a role changed: the members' open apps read the people and the counts again. */
export const announceMembers = (pubsub: PubSub | undefined, orgId: string) =>
  publishOrgEvent(pubsub, { type: "org.broadcast", orgId, event: { type: "org.members" } });

/**
 * A change to who is in the workspace, in the audit log: the person's name and address as they were then
 * (the row outlives the account).
 */
async function auditMember(
  tx: Executor,
  orgId: string,
  actorId: string,
  action: string,
  userId: string,
  details: Record<string, unknown>,
) {
  const [person] = await tx.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, userId));
  await recordAudit(tx, {
    orgId,
    actor: { type: "person", id: actorId },
    action,
    target: { type: "person", id: userId },
    details: { ...(person ? { name: person.name, email: person.email } : {}), ...details },
  });
}

/** Changes a member's role. Admins can't touch owners or make owners; nobody can demote the last owner. */
export async function changeMemberRole(
  db: Database,
  actorId: string,
  orgId: string,
  targetUserId: string,
  role: MemberRole,
  options: { pubsub?: PubSub } = {},
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
    if (target.role !== role) {
      await auditMember(tx, orgId, actorId, "member.role_changed", targetUserId, { from: target.role, to: role });
    }
  });
  await announceMembers(options.pubsub, orgId);
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
    const action = actorId === targetUserId ? "member.left" : "member.removed";
    await auditMember(tx, orgId, actorId, action, targetUserId, { role: target.role });
    // Their AI accounts on the organization's computers are signed out and removed (ADR 0059 §1).
    return releaseMemberAccounts(tx, targetUserId, orgId);
  });
  await announceReleasedAccounts(options.pubsub, released);
  // Their open WebSocket connections lose every subscription now, not on reconnect.
  await publishOrgEvent(options.pubsub, { type: "membership.revoked", orgId, userId: targetUserId });
  await announceMembers(options.pubsub, orgId);
  // Their routines pause at once and their work stops; the agents' owners hear it (ADR 0053 §6.2).
  // Loaded here: the routine engine builds on this module.
  const { pauseRoutinesOfCreator } = await import("./routine-firing");
  await pauseRoutinesOfCreator({ db, pubsub: options.pubsub }, orgId, targetUserId).catch(() => 0);
}

/** A deleted workspace's files leave platform storage (`purgeOrgFiles`). */
export const ORG_FILES_PURGE_JOB = "org.files.purge";
/** The backoff tops out at 3 h: a purge keeps trying through a storage outage for about 30 days. */
export const ORG_FILES_PURGE_ATTEMPTS = 240;

/**
 * Deletes a person's account (App Store 5.1.1(v), ADR 0035). Refused while
 * they are the only owner of an organization that has other members
 * (`sole_owner`, with the organizations' names: make someone else an owner
 * first). Organizations where they are the only member go with them, with
 * everything in them (their files on platform storage through the job
 * `org.files.purge`, ADR 0019). Their AI accounts on computers are signed
 * out and removed, never inherited (ADR 0059 §1). The rest follows the foreign keys:
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
  // Before any account goes: the first one stays the owner even once it is gone.
  const owner = await pinnedOwner(db);
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
    // No org_id on the job: the outbox row would be deleted with the workspace (cascade). A second pass a day
    // later takes files that work under way stored after the first (an agent's upload stores its file, then its
    // row is refused).
    for (const orgId of alone) {
      const purge = {
        orgId: null,
        kind: ORG_FILES_PURGE_JOB,
        payload: { orgId },
        maxAttempts: ORG_FILES_PURGE_ATTEMPTS,
      };
      await enqueue(tx, purge);
      const late = { runAt: new Date(Date.now() + 86_400_000), dedupeKey: `${ORG_FILES_PURGE_JOB}:${orgId}:late` };
      await enqueue(tx, { ...purge, ...late });
    }
    await tx.delete(users).where(eq(users.id, userId));
    // The owner's own TypeSafe account would go on getting, and paying for, every workspace's Jev calls.
    if (userId === owner) await deleteJevKey(tx, { type: "system", id: null });
    // With nobody left, the next first account owns the server again.
    await tx.update(instanceTelemetry).set({ ownerUserId: null }).where(sql`not exists (select 1 from ${users})`);
    const gone = alone.map((orgId): OperatorEvent => ({ type: "organization.deleted", orgId, userId }));
    await recordOperatorEvent(tx, ...gone, { type: "user.deleted", userId });
    return { left: leaving, deleted: alone, released };
  });
  await announceReleasedAccounts(options.pubsub, {
    machines: released.machines.filter((m) => left.includes(m.orgId)),
    agents: released.agents.filter((a) => left.includes(a.orgId)),
  });
  // Their open WebSocket connections lose every subscription now.
  for (const orgId of left) {
    await publishOrgEvent(options.pubsub, { type: "membership.revoked", orgId, userId });
    await announceMembers(options.pubsub, orgId);
  }
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
/** How long an invitation link works (ADR 0068): nobody gets in through it without an admin's approval. */
export const INVITE_LINK_TTL_DAYS = 30;

const ROLE_RANK: Record<MemberRole, number> = { member: 0, admin: 1, owner: 2 };

/**
 * Sends an invitation to an address with a role: the one named (`invitationId`), else the newest one for that
 * address not accepted yet, gets a new token and 7 more days (its old link stops working); with none, a new one
 * is made. One still working keeps the higher of its role and this one, so sending it again never demotes
 * whoever it was meant for, and an owner's invitation goes out again only from an owner (`ownersOk`). Records
 * `invitation.created`. The caller checks who may invite.
 */
export async function sendInvitation(
  db: Executor,
  input: {
    orgId: string;
    email: string;
    role: MemberRole;
    invitedBy: string;
    /** The sender may invite owners (`manage_owners`). */
    ownersOk: boolean;
    now?: Date;
    invitationId?: string;
    /** Resent from the pending list. */
    resent?: boolean;
    /** An admin approved a request to join (`invite-requests.ts`). */
    fromRequest?: boolean;
  },
) {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();
  const [existing] = await db
    .select({
      id: organizationInvitations.id,
      role: organizationInvitations.role,
      expiresAt: organizationInvitations.expiresAt,
    })
    .from(organizationInvitations)
    .where(
      and(
        eq(organizationInvitations.orgId, input.orgId),
        input.invitationId
          ? eq(organizationInvitations.id, input.invitationId)
          : eq(organizationInvitations.email, email),
        isNull(organizationInvitations.acceptedAt),
      ),
    )
    .orderBy(desc(organizationInvitations.createdAt))
    .limit(1);
  const role =
    existing && existing.expiresAt > now && ROLE_RANK[existing.role] > ROLE_RANK[input.role]
      ? existing.role
      : input.role;
  if (role === "owner" && !input.ownersOk) throw new ForbiddenError("Only owners can invite owners");
  const token = randomToken(32);
  const fresh = {
    role,
    tokenHash: sha256(token),
    invitedByUserId: input.invitedBy,
    expiresAt: new Date(now.getTime() + INVITATION_TTL_DAYS * 86_400_000),
  };
  const [invitation] = existing
    ? await db.update(organizationInvitations).set(fresh).where(eq(organizationInvitations.id, existing.id)).returning()
    : await db
        .insert(organizationInvitations)
        .values({ orgId: input.orgId, email, ...fresh })
        .returning();
  if (!invitation) throw new ConflictError("This invitation can't be sent");
  await recordAudit(db, {
    orgId: input.orgId,
    actor: { type: "person", id: input.invitedBy },
    action: input.resent ? "invitation.resent" : "invitation.sent",
    target: { type: "invitation", id: invitation.id },
    details: { email: invitation.email, role: invitation.role, ...(input.fromRequest ? { fromRequest: true } : {}) },
  });
  await recordOperatorEvent(db, {
    type: "invitation.created",
    orgId: input.orgId,
    userId: input.invitedBy,
    data: {
      emailDomain: addressDomain(invitation.email),
      role: invitation.role,
      ...(input.resent ? { resent: true } : {}),
      ...(input.fromRequest ? { fromRequest: true } : {}),
    },
  });
  /** `token` goes in the link and is never stored. */
  return { invitation, token };
}

export async function createInvitation(
  db: Database,
  actorId: string,
  orgId: string,
  input: { email: string; role: MemberRole },
  now = new Date(),
) {
  const actor = await requirePermission(db, actorId, orgId, "manage_members");
  assertInviting(actor);
  const email = input.email.trim().toLowerCase();

  const [alreadyMember] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
    .where(and(eq(users.email, email), eq(organizationMembers.orgId, orgId)));
  if (alreadyMember) throw new ConflictError(`${email} is already a member`);
  const ownersOk = can(actor.role, "manage_owners");
  return sendInvitation(db, { orgId, email, role: input.role, invitedBy: actorId, ownersOk, now });
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
  const [gone] = await db
    .delete(organizationInvitations)
    .where(and(eq(organizationInvitations.id, invitationId), eq(organizationInvitations.orgId, orgId)))
    .returning({ email: organizationInvitations.email, role: organizationInvitations.role });
  if (gone) {
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "invitation.revoked",
      target: { type: "invitation", id: invitationId },
      details: { email: gone.email, role: gone.role },
    });
  }
}

/**
 * The workspace's invitation link (admins, ADR 0068): whoever opens it can only ask to join. One link per
 * workspace, shown again whenever needed: the newest active link whose token is still derived from
 * `secret` (`inviteLinkToken`), else a new one for 30 days (`made`). Uses the same `/invite/{token}` page as
 * email invitations.
 */
export async function inviteLink(db: Database, secret: string, actorId: string, orgId: string, now = new Date()) {
  assertInviting(await requirePermission(db, actorId, orgId, "manage_members"));
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`invite-links:${orgId}`}))`);
    const active = await tx
      .select()
      .from(organizationInviteLinks)
      .where(
        and(
          eq(organizationInviteLinks.orgId, orgId),
          isNull(organizationInviteLinks.revokedAt),
          gt(organizationInviteLinks.expiresAt, now),
        ),
      )
      .orderBy(desc(organizationInviteLinks.createdAt));
    for (const link of active) {
      const token = inviteLinkToken(secret, link.id);
      if (link.tokenHash === sha256(token)) return { link, token, made: false };
    }
    const id = crypto.randomUUID();
    const token = inviteLinkToken(secret, id);
    const [link] = await tx
      .insert(organizationInviteLinks)
      .values({
        id,
        orgId,
        role: "member",
        tokenHash: sha256(token),
        createdByUserId: actorId,
        expiresAt: new Date(now.getTime() + INVITE_LINK_TTL_DAYS * 86_400_000),
      })
      .returning();
    if (!link) throw new Error("invite link insert returned nothing");
    await recordOperatorEvent(tx, { type: "invitation.created", orgId, userId: actorId, data: { link: true } });
    return { link, token, made: true };
  });
}

/** An invitation link by its token (or its id), with its workspace's name and standing; null when there is none. */
export async function findInviteLink(db: Executor, by: string | { id: string }) {
  const [row] = await db
    .select({ link: organizationInviteLinks, orgName: organizations.name, standing: STANDING_COLUMNS })
    .from(organizationInviteLinks)
    .innerJoin(organizations, eq(organizations.id, organizationInviteLinks.orgId))
    .where(
      typeof by === "string"
        ? eq(organizationInviteLinks.tokenHash, sha256(by))
        : eq(organizationInviteLinks.id, by.id),
    );
  return row ?? null;
}

/** A link people can still ask with: not turned off, not expired, and its workspace active. */
export const inviteLinkOpen = (
  found: { link: { revokedAt: Date | null; expiresAt: Date }; standing: WorkspaceStanding },
  now = new Date(),
) => !found.link.revokedAt && found.link.expiresAt > now && found.standing.state === "active";

/** How many of the organization's agents an invitation names ("Theo, Ada, Lia e Atlas já trabalham lá"). */
const INVITE_AGENTS = 4;

/**
 * The organization's first agents (not archived), for an invitation page: name and look only, and how many more
 * work there (`moreAgents`, when some do), so the page never reads as if those were all of them.
 */
async function inviteAgents(db: Database, orgId: string) {
  const rows = await db
    .select({ id: agents.id, name: agents.name, appearance: agents.appearance, total: sql<number>`count(*) over ()` })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .orderBy(asc(agents.createdAt))
    .limit(INVITE_AGENTS);
  const more = Number(rows[0]?.total ?? 0) - rows.length;
  return { agents: rows.map(({ total: _, ...agent }) => agent), ...(more > 0 ? { moreAgents: more } : {}) };
}

/**
 * What the invite page shows before signing in (`email` is empty for an org link): the organization, who
 * invited (their name), the role and its first agents. Only for a valid token, which reached the person.
 * A link that was turned off, expired, or whose workspace is paused says only that (`closed`), never why.
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
    if (!link) return null;
    if (!inviteLinkOpen(link, now)) {
      return {
        orgName: link.orgName,
        email: "",
        role: "member" as const,
        kind: "link" as const,
        invitedBy: null,
        agents: [],
        closed: true as const,
      };
    }
    const [creator] = link.link.createdByUserId
      ? await db.select({ name: users.name }).from(users).where(eq(users.id, link.link.createdByUserId))
      : [];
    return {
      orgName: link.orgName,
      email: "",
      role: link.link.role,
      kind: "link" as const,
      invitedBy: creator?.name ?? null,
      ...(await inviteAgents(db, link.link.orgId)),
    };
  }
  if (row.acceptedAt || row.expiresAt <= now) return null;
  return {
    orgName: row.orgName,
    email: row.email,
    role: row.role,
    kind: "email" as const,
    invitedBy: row.invitedBy ?? null,
    ...(await inviteAgents(db, row.orgId)),
  };
}

/**
 * Accepts an invitation. The signed-in user's email must match the invited one. Joins `general`. Not for
 * a blocked account, nor into a workspace on hold or suspended. An invitation link only lets people ask
 * (`invitation.ask_to_join`, ADR 0068).
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
      if (await findInviteLink(tx, token))
        throw new ConflictError("This link asks an admin first", "invitation.ask_to_join");
      throw new ConflictError("This invitation is invalid or has expired");
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
    await auditMember(tx, invitation.orgId, user.id, "member.joined", user.id, {
      role: invitation.role,
      invitedBy: invitation.invitedByUserId,
    });
    await tx
      .update(organizationInvitations)
      .set({ acceptedAt: now })
      .where(eq(organizationInvitations.id, invitation.id));
    return { orgId: invitation.orgId };
  });
}

/**
 * Adds a person to an organization (keeping an existing role) and to `general`. A request to join that they or
 * their address had waiting closes: whoever answers it next finds it answered.
 */
export async function joinOrganization(tx: Executor, orgId: string, userId: string, role: MemberRole) {
  await tx.insert(organizationMembers).values({ orgId, userId, role }).onConflictDoNothing();
  await tx
    .update(organizationJoinRequests)
    .set({ status: "closed", decidedAt: new Date() })
    .where(
      and(
        eq(organizationJoinRequests.orgId, orgId),
        eq(organizationJoinRequests.status, "pending"),
        or(
          eq(organizationJoinRequests.userId, userId),
          eq(organizationJoinRequests.email, sql`(select ${users.email} from ${users} where ${users.id} = ${userId})`),
        ),
      ),
    );
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
  return sendInvitation(db, {
    orgId,
    email: existing.email,
    role: existing.role,
    invitedBy: actorId,
    ownersOk: can(actor.role, "manage_owners"),
    now,
    invitationId,
    resent: true,
  });
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
