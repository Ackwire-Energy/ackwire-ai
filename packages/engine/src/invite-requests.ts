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
  lt,
  ne,
  or,
  schema,
  sql,
} from "@agenteschat/db";
import { recordAudit } from "./audit";
import { inviteLinkToken, sha256 } from "./crypto";
import { emailLocale, emailsByLocale, queueEmail } from "./email";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { adminIds } from "./gateway";
import { oneLine } from "./mail/text";
import { notify, resolveNotifications } from "./notifications";
import {
  assertInviting,
  can,
  findInviteLink,
  getMembership,
  inviteLinkOpen,
  joinOrganization,
  type MemberRole,
  requirePermission,
  sendInvitation,
} from "./organizations";
import { isUserBlocked } from "./standing";

const {
  organizationInvitations,
  organizationInviteLinks,
  organizationJoinRequests: requests,
  organizationMembers,
  organizations,
  notifications,
  users,
} = schema;

/** Requests nobody answers close after this (ADR 0068). */
export const JOIN_REQUEST_TTL_DAYS = 14;
/** At most this many wait in one workspace; the next ask is refused (`join.full`). */
export const MAX_PENDING_JOIN_REQUESTS = 50;
/** Answered or expired requests are deleted after this; a denial blocks asking again through a link until then. */
export const JOIN_REQUEST_KEEP_DAYS = 90;
/** What a person types: mirrored in packages/client/src/lib/join-requests.ts for the apps' fields. */
export const JOIN_NAME_MAX = 80;
export const JOIN_NOTE_MAX = 200;
export const JOIN_REASON_MAX = 300;

const DAY_MS = 86_400_000;
const group = (orgId: string) => `join_requests:${orgId}`;
const closedLink = () => new NotFoundError("This link no longer works", "join.link_closed");

type Deps = { db: Database; pubsub?: PubSub };
type RequestRow = typeof requests.$inferSelect;

/** Waiting for an answer: pending and not past its 14 days. */
const isWaiting = (r: Pick<RequestRow, "status" | "expiresAt">, now: Date) =>
  r.status === "pending" && r.expiresAt > now;
/** A denial still kept: the address can't ask again through a link until it is deleted. */
const isKeptDenial = (r: Pick<RequestRow, "status" | "decidedAt" | "createdAt">, now: Date) =>
  r.status === "denied" && (r.decidedAt ?? r.createdAt).getTime() > now.getTime() - JOIN_REQUEST_KEEP_DAYS * DAY_MS;

const base = (publicUrl: string) => publicUrl.replace(/\/$/, "");
/** Where an admin answers a request: Members, with it in view (`do` focuses Approve or opens Deny). */
const answerUrl = (publicUrl: string, orgId: string, id: string, action: "approve" | "deny") =>
  `${base(publicUrl)}/org/${orgId}/settings/members?request=${id}&do=${action}`;

async function isMember(db: Executor, orgId: string, userId: string) {
  const [row] = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)));
  return row !== undefined;
}

async function addressIsMember(db: Executor, orgId: string, email: string) {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(organizationMembers, eq(organizationMembers.userId, users.id))
    .where(and(eq(users.email, email), eq(organizationMembers.orgId, orgId)));
  return row !== undefined;
}

async function waitingCount(db: Executor, orgId: string, now: Date) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(requests)
    .where(and(eq(requests.orgId, orgId), eq(requests.status, "pending"), gt(requests.expiresAt, now)));
  return Number(row?.n ?? 0);
}

/** The admins' notices close once nothing is left waiting (answered, turned off or run out). */
async function settle(deps: Deps, orgId: string, now: Date) {
  if ((await waitingCount(deps.db, orgId, now)) > 0) return;
  await resolveNotifications({ ...deps, now: () => now }, orgId, { groupKey: group(orgId) });
}

export interface AskToJoinInput {
  token: string;
  /** The account asking, when signed in: its own name and address. */
  user: { id: string; name: string; email: string } | null;
  /** Typed when signed out. */
  name?: string;
  email?: string;
  note?: string | null;
  /** The page's language, for the answer's email when there is no account (`requestLocale`). */
  locale?: string | null;
}

/**
 * Someone who opened an invitation link asks to join (ADR 0068). Signed out, they typed a name and an address;
 * signed in, their account asks. Admins are told by an in-app notice (merged while unread, which pushes once per
 * burst) and an email at most once an hour per workspace. A typed request answers the same whatever the address:
 * already a member, already waiting or denied, nothing new happens, so a link never tells who works there.
 */
export async function askToJoin(deps: Deps, publicUrl: string, input: AskToJoinInput, now = new Date()) {
  const { db } = deps;
  const found = await findInviteLink(db, input.token);
  if (!found || !inviteLinkOpen(found, now)) throw closedLink();
  const { link, orgName } = found;
  const orgId = link.orgId;
  const user = input.user;
  if (user) {
    if (await isUserBlocked(db, user.id)) throw new ForbiddenError();
    if (await isMember(db, orgId, user.id)) throw new ConflictError("You're already in this workspace", "join.member");
  }
  const email = (user?.email ?? input.email ?? "").trim().toLowerCase();
  const name =
    oneLine(user?.name ?? input.name ?? "", JOIN_NAME_MAX) || oneLine(email.split("@")[0] ?? "", JOIN_NAME_MAX);
  if (!email.includes("@") || !name) throw new ValidationError("A name and an email are needed");
  const note = oneLine(input.note ?? "", JOIN_NOTE_MAX) || null;
  const admins = await adminIds(db, orgId);

  const created = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`join-requests:${orgId}`}))`);
    const [latest] = await tx
      .select()
      .from(requests)
      .where(and(eq(requests.orgId, orgId), eq(requests.email, email)))
      .orderBy(desc(requests.createdAt))
      .limit(1);
    const waiting = latest && isWaiting(latest, now) ? latest : null;
    const full = async () => (await waitingCount(tx, orgId, now)) >= MAX_PENDING_JOIN_REQUESTS;
    const fullError = () => new ConflictError("This workspace has many requests waiting", "join.full");
    if (!user) {
      // A full workspace answers the same for every address too, before anything about the address is read.
      if (await full()) throw fullError();
      if (waiting || (latest && isKeptDenial(latest, now)) || (await addressIsMember(tx, orgId, email))) return null;
    } else {
      if (latest && isKeptDenial(latest, now)) throw new ConflictError("Your request wasn't approved", "join.denied");
      if (waiting) {
        await tx.update(requests).set({ userId: user.id, name, note }).where(eq(requests.id, waiting.id));
        return null;
      }
      if (await full()) throw fullError();
    }
    const values = {
      linkId: link.id,
      userId: user?.id ?? null,
      email,
      name,
      note,
      locale: input.locale ?? null,
      status: "pending" as const,
      role: null,
      reason: null,
      decidedByUserId: null,
      decidedAt: null,
      invitationId: null,
      expiresAt: new Date(now.getTime() + JOIN_REQUEST_TTL_DAYS * DAY_MS),
      createdAt: now,
    };
    // A request that ran out still holds the address's one waiting slot: it starts over.
    const [row] =
      latest?.status === "pending"
        ? await tx.update(requests).set(values).where(eq(requests.id, latest.id)).returning()
        : await tx
            .insert(requests)
            .values({ orgId, ...values })
            .returning();
    if (!row) throw new Error("join request insert returned nothing");
    const people = admins.length
      ? await tx
          .select({ email: users.email, locale: users.locale })
          .from(users)
          .where(and(inArray(users.id, admins), isNull(users.blockedAt)))
      : [];
    const hour = now.toISOString().slice(0, 13);
    for (const g of emailsByLocale(
      people.map((p) => ({ email: p.email, locale: emailLocale(p.locale) })),
      `join-request:${orgId}:${hour}`,
    )) {
      await queueEmail(tx, {
        orgId,
        key: g.key,
        to: g.to,
        template: {
          kind: "join_request",
          locale: g.locale,
          orgName,
          name,
          email,
          url: answerUrl(publicUrl, orgId, row.id, "approve"),
          denyUrl: answerUrl(publicUrl, orgId, row.id, "deny"),
        },
      });
    }
    return row;
  });

  if (created) {
    await notify(
      { ...deps, now: () => now },
      {
        orgId,
        userIds: admins,
        kind: "join_request",
        groupKey: group(orgId),
        waiting: true,
        source: { label: orgName },
        latest: { title: name },
      },
    ).catch(() => []);
  }
  return { status: "pending" as const, email, created: created !== null };
}

/**
 * What the link's page tells a signed-in person (ADR 0068): whether they are in the workspace (its id only then),
 * and their latest request with its answer. Null for a token that isn't a link.
 */
export async function joinStatus(db: Database, user: { id: string; email: string }, token: string, now = new Date()) {
  const found = await findInviteLink(db, token);
  if (!found) return null;
  const orgId = found.link.orgId;
  const member = (await getMembership(db, user.id, orgId)) !== null;
  const email = user.email.toLowerCase();
  const [latest] = await db
    .select()
    .from(requests)
    .where(and(eq(requests.orgId, orgId), or(eq(requests.userId, user.id), eq(requests.email, email))))
    .orderBy(desc(requests.createdAt))
    .limit(1);
  const request = !latest
    ? null
    : isWaiting(latest, now)
      ? { status: "pending" as const, reason: null }
      : latest.status === "approved"
        ? { status: "approved" as const, reason: null }
        : isKeptDenial(latest, now)
          ? { status: "denied" as const, reason: latest.reason }
          : null;
  return { member, ...(member ? { orgId } : {}), email, request };
}

/**
 * Requests waiting in a workspace, oldest first (`manage_members`). `confirmed`: asked by a signed-in account whose
 * address is this one, confirmed and not blocked, so approving lets it in at once.
 */
export async function listWaitingJoinRequests(db: Database, actorId: string, orgId: string, now = new Date()) {
  await requirePermission(db, actorId, orgId, "manage_members");
  const rows = await db
    .select({
      id: requests.id,
      name: requests.name,
      email: requests.email,
      note: requests.note,
      confirmed: sql<boolean>`coalesce(${users.emailVerified} and ${users.blockedAt} is null and ${users.email} = ${requests.email}, false)`,
      createdAt: requests.createdAt,
      expiresAt: requests.expiresAt,
    })
    .from(requests)
    .leftJoin(users, eq(users.id, requests.userId))
    .where(and(eq(requests.orgId, orgId), eq(requests.status, "pending"), gt(requests.expiresAt, now)))
    .orderBy(asc(requests.createdAt));
  return rows.map((r) => ({ ...r, confirmed: Boolean(r.confirmed) }));
}

/** The request, locked, while it still waits; else why not. */
async function waitingRequest(tx: Executor, orgId: string, id: string, now: Date) {
  const [row] = await tx
    .select()
    .from(requests)
    .where(and(eq(requests.orgId, orgId), eq(requests.id, id)))
    .for("update");
  if (!row) throw new NotFoundError("This request doesn't exist");
  if (row.status !== "pending") throw new ConflictError("Someone already answered this request", "join.answered");
  if (row.expiresAt <= now) throw new ConflictError("This request expired", "join.expired");
  return row;
}

/** The answer email's words, and whether the account that asked proved the address. */
async function answerContext(tx: Executor, orgId: string, actorId: string, row: RequestRow) {
  const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
  const [approver] = await tx.select({ name: users.name }).from(users).where(eq(users.id, actorId));
  const [account] = row.userId
    ? await tx
        .select({ email: users.email, verified: users.emailVerified, blockedAt: users.blockedAt, locale: users.locale })
        .from(users)
        .where(eq(users.id, row.userId))
    : [];
  return {
    orgName: org?.name ?? "",
    approverName: approver?.name ?? "",
    locale: emailLocale(account?.locale ?? row.locale),
    confirmed: account !== undefined && account.email === row.email && account.verified && !account.blockedAt,
  };
}

export type JoinApproval = { outcome: "joined" } | { outcome: "invited"; url: string };

/**
 * Approves a request with a role (member or admin, ADR 0068). Only whoever controls the address gets in: a
 * signed-in account with it confirmed joins at once; any other request gets an email invitation to it (7 days),
 * which opens sign-up for that address. The person is told by email either way.
 */
export async function approveJoinRequest(
  deps: Deps,
  publicUrl: string,
  actorId: string,
  orgId: string,
  id: string,
  role: MemberRole,
  now = new Date(),
): Promise<JoinApproval> {
  assertInviting(await requirePermission(deps.db, actorId, orgId, "manage_members"));
  if (role !== "member" && role !== "admin") throw new ValidationError("role must be member or admin");
  const result = await deps.db.transaction(async (tx): Promise<JoinApproval> => {
    const row = await waitingRequest(tx, orgId, id, now);
    const context = await answerContext(tx, orgId, actorId, row);
    // Someone with this address got in meanwhile: nothing to send.
    const already = await addressIsMember(tx, orgId, row.email);
    let approval: JoinApproval = { outcome: "joined" };
    let invitationId: string | null = null;
    if (!already && context.confirmed && row.userId) {
      await joinOrganization(tx, orgId, row.userId, role);
    } else if (!already) {
      const sent = await sendInvitation(tx, {
        orgId,
        email: row.email,
        role,
        invitedBy: actorId,
        now,
        fromRequest: true,
      });
      invitationId = sent.invitation.id;
      approval = { outcome: "invited", url: `${base(publicUrl)}/invite/${sent.token}` };
    }
    await tx
      .update(requests)
      .set({ status: "approved", role, decidedByUserId: actorId, decidedAt: now, invitationId })
      .where(eq(requests.id, row.id));
    if (row.linkId) {
      await tx
        .update(organizationInviteLinks)
        .set({ uses: sql`${organizationInviteLinks.uses} + 1` })
        .where(eq(organizationInviteLinks.id, row.linkId));
    }
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "join_request.approved",
      target: { type: "join_request", id: row.id },
      details: { role, joined: approval.outcome === "joined" },
    });
    if (!already) {
      await queueEmail(tx, {
        orgId,
        key: `join-answer:${row.id}`,
        to: [row.email],
        template: {
          kind: "join_answer",
          locale: context.locale,
          outcome: approval.outcome,
          orgName: context.orgName,
          approverName: context.approverName,
          role,
          url: approval.outcome === "invited" ? approval.url : `${base(publicUrl)}/org/${orgId}`,
        },
      });
    }
    return approval;
  });
  await settle(deps, orgId, now);
  return result;
}

/**
 * Denies a request (`manage_members`), with an optional reason the person reads in the email (ADR 0068). Allowed
 * while the workspace is on hold too: it lets nobody in.
 */
export async function denyJoinRequest(
  deps: Deps,
  actorId: string,
  orgId: string,
  id: string,
  reason: string | null | undefined,
  now = new Date(),
) {
  await requirePermission(deps.db, actorId, orgId, "manage_members");
  const why = oneLine(reason ?? "", JOIN_REASON_MAX) || null;
  await deps.db.transaction(async (tx) => {
    const row = await waitingRequest(tx, orgId, id, now);
    const context = await answerContext(tx, orgId, actorId, row);
    await tx
      .update(requests)
      .set({ status: "denied", reason: why, decidedByUserId: actorId, decidedAt: now })
      .where(eq(requests.id, row.id));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "join_request.denied",
      target: { type: "join_request", id: row.id },
      details: { withReason: why !== null },
    });
    await queueEmail(tx, {
      orgId,
      key: `join-answer:${row.id}`,
      to: [row.email],
      template: {
        kind: "join_answer",
        locale: context.locale,
        outcome: "denied",
        orgName: context.orgName,
        approverName: context.approverName,
        reason: why,
      },
    });
  });
  await settle(deps, orgId, now);
}

/**
 * The workspace's active invitation links (`manage_members`), newest first: `token` when it can be shown again
 * (`inviteLinkToken`), null for a link made before that; who made it, and how many requests through it wait.
 */
export async function listInviteLinks(db: Database, secret: string, actorId: string, orgId: string, now = new Date()) {
  await requirePermission(db, actorId, orgId, "manage_members");
  const links = await db
    .select({ link: organizationInviteLinks, createdBy: users.name })
    .from(organizationInviteLinks)
    .leftJoin(users, eq(users.id, organizationInviteLinks.createdByUserId))
    .where(
      and(
        eq(organizationInviteLinks.orgId, orgId),
        isNull(organizationInviteLinks.revokedAt),
        gt(organizationInviteLinks.expiresAt, now),
      ),
    )
    .orderBy(desc(organizationInviteLinks.createdAt));
  const counts = links.length
    ? await db
        .select({ linkId: requests.linkId, n: sql<number>`count(*)::int` })
        .from(requests)
        .where(
          and(
            inArray(
              requests.linkId,
              links.map((l) => l.link.id),
            ),
            eq(requests.status, "pending"),
            gt(requests.expiresAt, now),
          ),
        )
        .groupBy(requests.linkId)
    : [];
  const waiting = new Map(counts.map((c) => [c.linkId, Number(c.n)]));
  return links.map(({ link, createdBy }) => {
    const token = inviteLinkToken(secret, link.id);
    return {
      id: link.id,
      token: sha256(token) === link.tokenHash ? token : null,
      expiresAt: link.expiresAt,
      createdAt: link.createdAt,
      createdBy: createdBy ?? null,
      waiting: waiting.get(link.id) ?? 0,
    };
  });
}

/**
 * Turns an invitation link off (`manage_members`): nobody new can ask with it, and the requests made through it
 * close without emailing anyone, which is how an admin cleans up after a link leaked.
 */
export async function turnOffInviteLink(deps: Deps, actorId: string, orgId: string, linkId: string, now = new Date()) {
  await requirePermission(deps.db, actorId, orgId, "manage_members");
  const closed = await deps.db.transaction(async (tx) => {
    const [link] = await tx
      .select({ id: organizationInviteLinks.id, revokedAt: organizationInviteLinks.revokedAt })
      .from(organizationInviteLinks)
      .where(and(eq(organizationInviteLinks.orgId, orgId), eq(organizationInviteLinks.id, linkId)))
      .for("update");
    if (!link) throw new NotFoundError("Invitation link not found");
    if (link.revokedAt) return 0;
    await tx.update(organizationInviteLinks).set({ revokedAt: now }).where(eq(organizationInviteLinks.id, linkId));
    const rows = await tx
      .update(requests)
      .set({ status: "closed", decidedByUserId: actorId, decidedAt: now })
      .where(and(eq(requests.orgId, orgId), eq(requests.linkId, linkId), eq(requests.status, "pending")))
      .returning({ id: requests.id });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "invite_link.turned_off",
      target: { type: "invite_link", id: linkId },
      details: { closed: rows.length },
    });
    return rows.length;
  });
  await settle(deps, orgId, now);
  return { closed };
}

/**
 * Daily: deletes requests answered, closed or run out more than 90 days ago, and closes the admins' notices of
 * workspaces where nothing waits anymore (requests that ran out). Returns how many were deleted.
 */
export async function pruneJoinRequests(deps: Deps, now = new Date()) {
  const cutoff = new Date(now.getTime() - JOIN_REQUEST_KEEP_DAYS * DAY_MS);
  const gone = await deps.db
    .delete(requests)
    .where(
      or(
        and(ne(requests.status, "pending"), lt(requests.decidedAt, cutoff)),
        and(eq(requests.status, "pending"), lt(requests.expiresAt, cutoff)),
      ),
    )
    .returning({ id: requests.id });
  const open = await deps.db
    .selectDistinct({ orgId: notifications.orgId })
    .from(notifications)
    .where(and(eq(notifications.kind, "join_request"), isNull(notifications.doneAt)));
  for (const { orgId } of open) await settle(deps, orgId, now);
  return gone.length;
}

/**
 * Someone opened an expired email invitation and asks for a new one (public: the token is the proof). The person
 * who invited them is told by email; if they can no longer invite, the org's admins are. Once per invitation. An
 * invitation link has no such request: whoever holds one asks to join instead (ADR 0068).
 */
export async function requestNewInvitation(db: Database, publicUrl: string, token: string, now = new Date()) {
  const [invitation] = await db
    .select()
    .from(organizationInvitations)
    .where(eq(organizationInvitations.tokenHash, sha256(token)));
  if (!invitation) throw new NotFoundError("Invitation not found");
  if (invitation.acceptedAt) throw new ConflictError("This invitation was already accepted");
  if (invitation.expiresAt > now) throw new ConflictError("This invitation is still valid");
  const inviterId = invitation.invitedByUserId;
  const inviter = inviterId ? await getMembership(db, inviterId, invitation.orgId) : null;
  const recipientIds =
    inviter && inviterId && can(inviter.role, "manage_members") ? [inviterId] : await adminIds(db, invitation.orgId);
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, invitation.orgId));
  if (!org || recipientIds.length === 0) return;
  const people = await db
    .select({ email: users.email, locale: users.locale })
    .from(users)
    .where(inArray(users.id, recipientIds));
  const groups = emailsByLocale(
    people.map((p) => ({ email: p.email, locale: emailLocale(p.locale) })),
    `invite-request:${invitation.id}`,
  );
  for (const { locale, to, key } of groups) {
    await queueEmail(db, {
      orgId: invitation.orgId,
      key,
      to,
      template: {
        kind: "invite_request",
        locale,
        orgName: org.name,
        email: invitation.email,
        url: `${base(publicUrl)}/org/${invitation.orgId}/settings/members`,
      },
    });
  }
}
