import type { PubSub, RateLimiter } from "@agenteschat/adapters";
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
  like,
  lt,
  ne,
  or,
  schema,
  sql,
} from "@agenteschat/db";
import { recordAudit } from "./audit";
import { inviteLinkToken, sha256 } from "./crypto";
import { emailLocale, emailsByLocale, queueEmail } from "./email";
import {
  CODE_EMAILS,
  CODE_LIMITS,
  CODE_RESEND_SECONDS,
  CODE_TRIES,
  CODE_TTL_MS,
  codeLimit,
  codeRefusal,
  codeVerdict,
  codeWait,
  codeWaitMs,
  newCode,
} from "./email-codes";
import { ConflictError, ForbiddenError, NotFoundError, TooManyError, ValidationError } from "./errors";
import { adminIds } from "./gateway";
import { assertMemberRoom } from "./limits";
import { mailboxOf, oneLine } from "./mail/text";
import { notify, resolveNotifications } from "./notifications";
import {
  announceMembers,
  assertInviting,
  can,
  findInviteLink,
  getMembership,
  inviteLinkOpen,
  joinOrganization,
  requirePermission,
  sendInvitation,
} from "./organizations";
import { enqueue } from "./outbox";
import { givableRoleIds } from "./roles";
import { closedOrg } from "./standing";

const {
  organizationInvitations,
  organizationInviteLinks,
  organizationJoinRequests: requests,
  organizationJoinCodes: codes,
  organizationJoinCodeEvents: codeEvents,
  organizationMembers,
  organizations,
  notifications,
  outbox,
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

/** The outbox job that files a request whose address isn't proven (`fileJoinRequest`). */
export const FILE_JOIN_REQUEST_JOB = "join_request.file";

/** A code typed right proves the address this long, to ask with it (the code's own rules: `email-codes.ts`). */
const JOIN_CODE_VERIFIED_MS = 30 * 60_000;
/**
 * Per workspace and mailbox, `CODE_LIMITS`: after them no new code goes out and none is checked. Per mailbox across
 * workspaces: codes a day. The whole server: codes an hour.
 */
const JOIN_CODE_LIMITS = { ...CODE_LIMITS, mailboxDay: 20, serverHour: 500 };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** New requests through one link an hour (ADR 0068): enough for a team arriving, not for a flood. */
const REQUESTS_PER_LINK = { limit: 20, windowMs: HOUR_MS };
const group = (orgId: string) => `join_requests:${orgId}`;
const closedLink = () => new NotFoundError("This link no longer works", "join.link_closed");
const fullError = () => new ConflictError("This workspace has many requests waiting", "join.full");
/** A link's hour used up, by asks or by codes: everyone asking through it shares it, unlike `join.rate_limited`. */
export const linkBusy = () =>
  new TooManyError("Many people asked through this link in the last hour. Try again later.", "join.link_busy");

/** `rateLimiter` counts a link's new requests (`spendLinkRequest`): `askToJoin` requires it, the job never spends. */
type Deps = { db: Database; pubsub?: PubSub; rateLimiter?: RateLimiter };
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

/** The admins' notices close once nothing is left waiting (answered, turned off, run out, or joined). */
export async function settleJoinRequests(deps: Deps, orgId: string, now = new Date()) {
  if ((await waitingCount(deps.db, orgId, now)) > 0) return;
  await resolveNotifications({ ...deps, now: () => now }, orgId, { groupKey: group(orgId) });
}

/** Requests are filed, answered and closed one at a time per workspace, and so is turning its link off. */
const lockRequests = (tx: Executor, orgId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`join-requests:${orgId}`}))`);

/** The account's own address and whether it opened the link that confirms it, read here: a session's copy lags. */
async function accountOf(db: Executor, userId: string) {
  const [row] = await db
    .select({
      name: users.name,
      email: users.email,
      verified: users.emailVerified,
      blockedAt: users.blockedAt,
      locale: users.locale,
    })
    .from(users)
    .where(eq(users.id, userId));
  return row ?? null;
}

/** An open link, by its token; else `join.link_closed`. */
async function openLink(db: Executor, token: string, now: Date) {
  const found = await findInviteLink(db, token);
  if (!found || !inviteLinkOpen(found, now)) throw closedLink();
  return found;
}

/** One of the link's new requests for the hour (`REQUESTS_PER_LINK`), in memory like every rate limit here. */
async function spendLinkRequest(deps: Deps, linkId: string) {
  const spent = await deps.rateLimiter?.consume(`join-request:link:${linkId}`, REQUESTS_PER_LINK);
  if (spent && !spent.allowed) throw linkBusy();
}

const codeHash = (orgId: string, email: string, code: string) => sha256(`${orgId}:${email}:${code}`);
const codeRow = (orgId: string, email: string) => and(eq(codes.orgId, orgId), eq(codes.email, email));

// ponytail: one lock for every code sent or checked on the server, so each count holds; per-mailbox locks if
// codes ever queue behind it.
const lockCodes = (tx: Executor) => tx.execute(sql`select pg_advisory_xact_lock(hashtext('join-codes'))`);

/** The counts every code limit reads, from the events of the last day. */
async function codeCounts(tx: Executor, orgId: string, mailbox: string, now: Date) {
  const hourAgo = new Date(now.getTime() - HOUR_MS);
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const here = eq(codeEvents.orgId, orgId);
  const sent = eq(codeEvents.kind, "sent");
  const [mine] = await tx
    .select({
      hour: sql<number>`count(*) filter (where ${and(here, sent, gt(codeEvents.at, hourAgo))})::int`,
      day: sql<number>`count(*) filter (where ${and(here, sent)})::int`,
      wrong: sql<number>`count(*) filter (where ${and(here, eq(codeEvents.kind, "wrong"))})::int`,
      mailboxDay: sql<number>`count(*) filter (where ${sent})::int`,
    })
    .from(codeEvents)
    .where(and(eq(codeEvents.mailbox, mailbox), gt(codeEvents.at, dayAgo)));
  const [all] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(codeEvents)
    .where(and(sent, gt(codeEvents.at, hourAgo)));
  return { hour: 0, day: 0, wrong: 0, mailboxDay: 0, ...mine, serverHour: all?.n ?? 0 };
}

export interface JoinCodeInput {
  token: string;
  /** Signed in: the code goes to the account's own address (a confirmed one needs none). */
  user: { id: string } | null;
  /** Typed when signed out. */
  email?: string;
  /** The page's language (`requestLocale`), for the email. */
  locale?: string | null;
}

/** The address a code is for, and the email's language. */
async function codeAddress(db: Executor, input: JoinCodeInput) {
  if (!input.user) {
    const email = (input.email ?? "").trim().toLowerCase();
    if (!email.includes("@")) throw new ValidationError("An email is needed");
    return { email, locale: emailLocale(input.locale) };
  }
  const account = await accountOf(db, input.user.id);
  if (!account || account.blockedAt) throw new ForbiddenError();
  if (account.verified) throw new ConflictError("This account's email is already confirmed.", "join.verified");
  return { email: account.email.trim().toLowerCase(), locale: emailLocale(account.locale ?? input.locale) };
}

/**
 * Emails a code that proves the address asking through a link (ADR 0072). Every address gets one alike, a member's,
 * a waiting or a denied one too, since only its mailbox reads it. A new code replaces one still waiting to be
 * typed, never one already typed right. Every limit is counted in the database (`JOIN_CODE_LIMITS`, and 60 s
 * between two codes for one workspace and address), so a restart resets none.
 */
export async function sendJoinCode(deps: Deps, publicUrl: string, input: JoinCodeInput, now = new Date()) {
  const found = await openLink(deps.db, input.token, now);
  const orgId = found.link.orgId;
  const { email, locale } = await codeAddress(deps.db, input);
  const mailbox = sha256(mailboxOf(email));
  return deps.db.transaction(async (tx) => {
    await lockCodes(tx);
    const [row] = await tx.select({ sentAt: codes.sentAt }).from(codes).where(codeRow(orgId, email));
    const wait = codeWaitMs(row?.sentAt, now);
    if (wait > 0) throw codeWait("join", wait);
    const n = await codeCounts(tx, orgId, mailbox, now);
    const limits = JOIN_CODE_LIMITS;
    if (n.hour >= limits.hour || n.day >= limits.day || n.wrong >= limits.wrongDay || n.mailboxDay >= limits.mailboxDay)
      throw codeLimit("join");
    if (n.serverHour >= limits.serverHour) throw new TooManyError("Too many requests. Try again later.");
    const code = newCode();
    const waiting = {
      codeHash: codeHash(orgId, email, code),
      tries: 0,
      sentAt: now,
      expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    };
    await tx
      .insert(codes)
      .values({ orgId, email, ...waiting })
      .onConflictDoUpdate({ target: [codes.orgId, codes.email], set: waiting });
    await tx.insert(codeEvents).values({ orgId, mailbox, kind: "sent", at: now });
    // Three tries within the code's first minute; the job deletes the row once it can't send again.
    await queueEmail(tx, {
      orgId,
      key: `join-code:${orgId}:${sha256(email)}:${now.getTime()}`,
      to: [email],
      template: { kind: "join_code", locale, orgName: found.orgName, code, url: base(publicUrl) },
      maxAttempts: 3,
      runAt: now,
    });
    return { email, resendIn: CODE_RESEND_SECONDS };
  });
}

/**
 * A code typed for an address, under the codes' lock: `verified` (typed right before, still good), `right` (the
 * code waiting), or why not. A wrong one counts against the code waiting and the day's wrong tries. With only a
 * code typed right left, it still counts against the day, or that code could be guessed for its 30 minutes. With
 * no code sent it is wrong, so nobody learns whether one went out.
 */
async function tryCode(
  tx: Executor,
  orgId: string,
  email: string,
  code: string,
  now: Date,
): Promise<"verified" | "right" | "wrong" | "expired" | "tries"> {
  const hash = codeHash(orgId, email, code);
  const [row] = await tx.select().from(codes).where(codeRow(orgId, email));
  if (row?.verifiedHash === hash) return row.verifiedUntil && row.verifiedUntil > now ? "verified" : "expired";
  const mailbox = sha256(mailboxOf(email));
  if ((await codeCounts(tx, orgId, mailbox, now)).wrong >= JOIN_CODE_LIMITS.wrongDay) return "tries";
  const wrong = () => tx.insert(codeEvents).values({ orgId, mailbox, kind: "wrong", at: now });
  const verdict = codeVerdict(row && { hash: row.codeHash, tries: row.tries, expiresAt: row.expiresAt }, hash, now);
  if (verdict === "none") {
    if (row) await wrong();
    return "wrong";
  }
  if (verdict !== "miss") return verdict;
  const tries = (row?.tries ?? 0) + 1;
  await tx.update(codes).set({ tries }).where(codeRow(orgId, email));
  await wrong();
  return tries >= CODE_TRIES ? "tries" : "wrong";
}

/**
 * Checks a code typed on a link's page (ADR 0072). Right, the address is proven for 30 minutes to ask with the
 * same code, and a newer code doesn't undo it. It never confirms an account: the code proves the request only.
 */
export async function checkJoinCode(deps: Deps, input: JoinCodeInput & { code: string }, now = new Date()) {
  const found = await openLink(deps.db, input.token, now);
  const orgId = found.link.orgId;
  const { email } = await codeAddress(deps.db, input);
  const result = await deps.db.transaction(async (tx) => {
    await lockCodes(tx);
    const tried = await tryCode(tx, orgId, email, input.code, now);
    if (tried === "right") {
      await tx
        .update(codes)
        .set({
          codeHash: null,
          tries: 0,
          verifiedHash: codeHash(orgId, email, input.code),
          verifiedUntil: new Date(now.getTime() + JOIN_CODE_VERIFIED_MS),
        })
        .where(codeRow(orgId, email));
    }
    return tried;
  });
  if (result !== "right" && result !== "verified") throw codeRefusal("join", result);
  return { verified: true as const };
}

export interface AskToJoinInput {
  token: string;
  /** The account asking, when signed in: it asks with its own name and address. */
  user: { id: string } | null;
  /** Typed when signed out. */
  name?: string;
  email?: string;
  note?: string | null;
  /** The page's language, for the answer's email when there is no account (`requestLocale`). */
  locale?: string | null;
  /** This server sends email: the address is proven with a code before it can ask (ADR 0072). */
  proofNeeded?: boolean;
  /** The code from the address's mailbox (`sendJoinCode`), checked or not. */
  code?: string;
}

/** A request as filed: the workspace and link it came through, and who asks. */
interface Ask {
  orgId: string;
  linkId: string;
  email: string;
  name: string;
  note: string | null;
  locale: string | null;
  /** The account that asked, when signed in. */
  userId: string | null;
}

/**
 * Someone who opened an invitation link asks to join (ADR 0068, 0072). Signed out, they typed a name and an
 * address; signed in, their account asks. A confirmed account asks for its own address. Anyone else, on a server
 * that sends email, first proves the address with a code from its mailbox (`code`, ADR 0072). A proven ask hears
 * where it stands and is filed at once. On a server without email, a typed address, or an account's that isn't
 * confirmed (anyone can sign up with an address that isn't theirs), gets the same answer after the same work
 * whatever it is: nothing here depends on the address, so a link never tells who works there, who waits or who was
 * turned down, not even by how long the answer takes. A job files it (`fileJoinRequest`). A link takes 20 new
 * requests an hour (`join.link_busy`): a proven ask counts only when it files one, an unproven ask whenever it
 * asks, so asks without a right code can't use up the hour for the people it was shared with. `created` is false
 * only when a request for the address already waited.
 */
export async function askToJoin(
  deps: Deps & { rateLimiter: RateLimiter },
  publicUrl: string,
  input: AskToJoinInput,
  now = new Date(),
) {
  const { db } = deps;
  const found = await openLink(db, input.token, now);
  const orgId = found.link.orgId;
  const account = input.user ? await accountOf(db, input.user.id) : null;
  if (input.user) {
    if (!account || account.blockedAt) throw new ForbiddenError();
    if (await isMember(db, orgId, input.user.id))
      throw new ConflictError("You're already in this workspace", "join.member");
  }
  const email = (account?.email ?? input.email ?? "").trim().toLowerCase();
  const name =
    oneLine(account?.name ?? input.name ?? "", JOIN_NAME_MAX) || oneLine(email.split("@")[0] ?? "", JOIN_NAME_MAX);
  if (!email.includes("@") || !name) throw new ValidationError("A name and an email are needed");
  const ask: Ask = {
    orgId,
    linkId: found.link.id,
    email,
    name,
    note: oneLine(input.note ?? "", JOIN_NOTE_MAX) || null,
    locale: input.locale ?? null,
    userId: input.user?.id ?? null,
  };
  if (account?.verified) {
    const created = await file(deps, publicUrl, ask, true, now);
    return { status: "pending" as const, email, created };
  }
  if (input.proofNeeded) {
    if (!input.code) throw new ValidationError("Verify the email with a code first.", "join.code_needed");
    const code = input.code;
    const tried = await db.transaction(async (tx) => {
      await lockCodes(tx);
      return tryCode(tx, orgId, email, code, now);
    });
    if (tried !== "right" && tried !== "verified") throw codeRefusal("join", tried);
    const created = await file(deps, publicUrl, ask, true, now, codeHash(orgId, email, code));
    return { status: "pending" as const, email, created };
  }
  if ((await waitingCount(db, orgId, now)) >= MAX_PENDING_JOIN_REQUESTS) throw fullError();
  await spendLinkRequest(deps, found.link.id);
  await enqueue(db, { orgId, kind: FILE_JOIN_REQUEST_JOB, payload: { ...ask, publicUrl } });
  return { status: "pending" as const, email, created: true };
}

/** Job `join_request.file`: files a request `askToJoin` queued (an unproven address); never tells anyone why not. */
export async function fileJoinRequest(deps: Deps, payload: Record<string, unknown>, now = new Date()) {
  const text = (key: string) => (typeof payload[key] === "string" ? (payload[key] as string) : null);
  const [orgId, linkId, email, name] = [text("orgId"), text("linkId"), text("email"), text("name")];
  if (!orgId || !linkId || !email || !name) return;
  const ask = { orgId, linkId, email, name, note: text("note"), locale: text("locale"), userId: text("userId") };
  await file(deps, text("publicUrl") ?? "", ask, false, now);
}

/**
 * Files a request under the workspace's lock, the link read again under it. `proven`: a confirmed account asking
 * for its own address, or an address proven with a code (`usedCode`, the code's hash, used up here). A proven ask
 * hears where it stands (`join.link_closed`, `join.member`, `join.denied`, `join.full`, which leave the code
 * good) and takes over a request still waiting for that address. An unproven ask changes nothing that exists: a
 * member's, a waiting or a denied address files nothing. Admins are told of a new request by an email at most once
 * an hour per workspace and a notice merged while unread (one push per burst). Returns whether a new request waits.
 */
async function file(deps: Deps, publicUrl: string, ask: Ask, proven: boolean, now: Date, usedCode?: string) {
  const { db } = deps;
  const { orgId } = ask;
  const admins = await adminIds(db, orgId, "invite_people");
  const filed = await db.transaction(async (tx) => {
    await lockRequests(tx, orgId);
    const link = await findInviteLink(tx, { id: ask.linkId });
    if (!link || !inviteLinkOpen(link, now)) {
      if (proven) throw closedLink();
      return null;
    }
    if (usedCode) {
      const used = await tx
        .delete(codes)
        .where(and(codeRow(orgId, ask.email), or(eq(codes.verifiedHash, usedCode), eq(codes.codeHash, usedCode))))
        .returning({ email: codes.email });
      // Another ask used it a moment ago.
      if (used.length === 0) throw codeRefusal("join", "expired");
    }
    const [latest] = await tx
      .select()
      .from(requests)
      .where(and(eq(requests.orgId, orgId), eq(requests.email, ask.email)))
      .orderBy(desc(requests.createdAt))
      .limit(1);
    const waiting = latest && isWaiting(latest, now) ? latest : null;
    const denied = latest !== undefined && isKeptDenial(latest, now);
    if (proven) {
      if (await addressIsMember(tx, orgId, ask.email))
        throw new ConflictError("You're already in this workspace", "join.member");
      if (denied) throw new ConflictError("Your request wasn't approved", "join.denied");
      if (waiting) {
        await tx
          .update(requests)
          .set({ userId: ask.userId ?? waiting.userId, name: ask.name, note: ask.note, verifiedAt: now })
          .where(eq(requests.id, waiting.id));
        return null;
      }
    } else if (waiting || denied || (await addressIsMember(tx, orgId, ask.email))) {
      return null;
    }
    if ((await waitingCount(tx, orgId, now)) >= MAX_PENDING_JOIN_REQUESTS) {
      if (proven) throw fullError();
      return null;
    }
    // An unproven ask counted when it asked: its answer can't wait for the job, nor depend on the address.
    if (proven) await spendLinkRequest(deps, ask.linkId);
    const values = {
      linkId: ask.linkId,
      userId: ask.userId,
      email: ask.email,
      name: ask.name,
      note: ask.note,
      locale: ask.locale,
      status: "pending" as const,
      role: null,
      reason: null,
      decidedByUserId: null,
      decidedAt: null,
      invitationId: null,
      verifiedAt: proven ? now : null,
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
          orgName: link.orgName,
          name: ask.name,
          email: ask.email,
          url: answerUrl(publicUrl, orgId, row.id, "approve"),
          denyUrl: answerUrl(publicUrl, orgId, row.id, "deny"),
        },
      });
    }
    return { orgName: link.orgName };
  });
  if (!filed) return false;
  await notify(
    { ...deps, now: () => now },
    {
      orgId,
      userIds: admins,
      kind: "join_request",
      groupKey: group(orgId),
      waiting: true,
      source: { label: filed.orgName },
      latest: { title: ask.name, names: [ask.name] },
    },
  ).catch(() => []);
  return true;
}

/**
 * What the link's page tells a signed-in person (ADR 0068): whether they are in the workspace (its id only then),
 * and, once they confirmed their address, the latest request for it with its answer. An unconfirmed account hears
 * nothing about requests, as a typed ask: anyone can sign up with an address that isn't theirs, and even whether
 * its own ask was filed would tell that the address already waited or was turned down. A waiting request counts
 * once it is the account's own: one typed for the address becomes theirs when they ask (`file`), and until then
 * approving it would send an invitation instead of letting them in. An approval counts while it still means
 * something: they are in, or the invitation it sent still waits for them. Null for a token that isn't a link.
 */
export async function joinStatus(db: Database, user: { id: string }, token: string, now = new Date()) {
  const found = await findInviteLink(db, token);
  const account = found ? await accountOf(db, user.id) : null;
  if (!found || !account) return null;
  const orgId = found.link.orgId;
  const member = (await getMembership(db, user.id, orgId)) !== null;
  const email = account.email.toLowerCase();
  const [latest] = account.verified
    ? await db
        .select({ request: requests, invitation: organizationInvitations })
        .from(requests)
        .leftJoin(organizationInvitations, eq(organizationInvitations.id, requests.invitationId))
        .where(and(eq(requests.orgId, orgId), or(eq(requests.userId, user.id), eq(requests.email, email))))
        .orderBy(desc(requests.createdAt))
        .limit(1)
    : [];
  const row = latest?.request;
  const invitation = latest?.invitation;
  const invited = !!invitation && !invitation.acceptedAt && invitation.expiresAt > now;
  const request = !row
    ? null
    : isWaiting(row, now)
      ? row.userId === user.id
        ? { status: "pending" as const, reason: null }
        : null
      : row.status === "approved" && (member || invited)
        ? { status: "approved" as const, reason: null }
        : isKeptDenial(row, now)
          ? { status: "denied" as const, reason: row.reason }
          : null;
  return { member, ...(member ? { orgId } : {}), email, request };
}

/**
 * Requests waiting in a workspace, oldest first (`manage_members`). `verified`: a code proved the address, or a
 * confirmed account with it asked; false only on a server without email, or for a request typed before codes.
 * `confirmed` (read by phone builds from before `verified`): approving lets an account in at once, as
 * `approveJoinRequest` decides.
 */
export async function listWaitingJoinRequests(db: Database, actorId: string, orgId: string, now = new Date()) {
  await requirePermission(db, actorId, orgId, "invite_people");
  const rows = await db
    .select({
      id: requests.id,
      name: requests.name,
      email: requests.email,
      note: requests.note,
      verified: sql<boolean>`${requests.verifiedAt} is not null or coalesce(${users.id} = ${requests.userId} and ${users.emailVerified}, false)`,
      confirmed: sql<boolean>`coalesce(${users.emailVerified} and ${users.blockedAt} is null and (${requests.verifiedAt} is not null or ${users.id} = ${requests.userId}), false)`,
      createdAt: requests.createdAt,
      expiresAt: requests.expiresAt,
    })
    .from(requests)
    .leftJoin(users, eq(users.email, requests.email))
    .where(and(eq(requests.orgId, orgId), eq(requests.status, "pending"), gt(requests.expiresAt, now)))
    .orderBy(asc(requests.createdAt));
  return rows.map((r) => ({ ...r, verified: Boolean(r.verified), confirmed: Boolean(r.confirmed) }));
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

/**
 * The answer email's words, and the account an approval lets in at once: the confirmed one with the address, when
 * the address was proven (a code, or that account asking). Anyone can sign up with an address that isn't theirs, and
 * on a server without email anyone can type one.
 */
async function answerContext(tx: Executor, orgId: string, actorId: string, row: RequestRow) {
  const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
  const [approver] = await tx.select({ name: users.name }).from(users).where(eq(users.id, actorId));
  const [account] = await tx
    .select({ id: users.id, verified: users.emailVerified, blockedAt: users.blockedAt, locale: users.locale })
    .from(users)
    .where(eq(users.email, row.email));
  const proven = row.verifiedAt !== null || row.userId === account?.id;
  return {
    orgName: org?.name ?? "",
    approverName: approver?.name ?? "",
    locale: emailLocale(account?.locale ?? row.locale),
    joiner: account?.verified && !account.blockedAt && proven ? account.id : null,
  };
}

export type JoinApproval = { outcome: "joined" } | { outcome: "invited"; url: string };

/**
 * Approves a request with a role (member or admin, ADR 0068, 0072). Only whoever controls the address gets in: a
 * confirmed account with it joins at once when the address was proven; any other request gets an email invitation
 * to it (7 days), which opens sign-up for that address. The person is told by email either way.
 */
export async function approveJoinRequest(
  deps: Deps,
  publicUrl: string,
  actorId: string,
  orgId: string,
  id: string,
  /** Roles (`org_roles`) the person gets, below the approver's own (ADR 0085). */
  roleIds: string[] = [],
  now = new Date(),
): Promise<JoinApproval> {
  const actor = await requirePermission(deps.db, actorId, orgId, "invite_people");
  assertInviting(actor);
  const role = "member" as const;
  const given = await givableRoleIds(deps.db, actor, orgId, roleIds);
  const result = await deps.db.transaction(async (tx): Promise<JoinApproval> => {
    const row = await waitingRequest(tx, orgId, id, now);
    const context = await answerContext(tx, orgId, actorId, row);
    // Someone with this address got in meanwhile: nothing to send.
    const already = await addressIsMember(tx, orgId, row.email);
    // Full: nobody joins, and no invitation goes out that couldn't be accepted.
    if (!already) await assertMemberRoom(tx, orgId);
    let approval: JoinApproval = { outcome: "joined" };
    let invitationId: string | null = null;
    if (!already && context.joiner) {
      await joinOrganization(tx, orgId, context.joiner, role, given);
    } else if (!already) {
      const sent = await sendInvitation(tx, {
        orgId,
        email: row.email,
        role,
        roleIds: given,
        invitedBy: actorId,
        ownersOk: can(actor, "manage_owners"),
        now,
        fromRequest: true,
      });
      invitationId = sent.invitation.id;
      approval = { outcome: "invited", url: `${base(publicUrl)}/invite/${sent.token}` };
    }
    await tx
      .update(requests)
      .set({ status: "approved", role, roleIds: given, decidedByUserId: actorId, decidedAt: now, invitationId })
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
      details: { roleIds: given, joined: approval.outcome === "joined" },
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
  if (result.outcome === "joined") await announceMembers(deps.pubsub, orgId);
  await settleJoinRequests(deps, orgId, now);
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
  await requirePermission(deps.db, actorId, orgId, "invite_people");
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
  await settleJoinRequests(deps, orgId, now);
}

/**
 * The workspace's active invitation links (`manage_members`), newest first: `token` when it can be shown again
 * (`inviteLinkToken`), null for a link made before that; who made it, and how many requests through it wait.
 */
export async function listInviteLinks(db: Database, secret: string, actorId: string, orgId: string, now = new Date()) {
  await requirePermission(db, actorId, orgId, "invite_people");
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
  await requirePermission(deps.db, actorId, orgId, "invite_people");
  const closed = await deps.db.transaction(async (tx) => {
    // The lock a request is filed under: one filed meanwhile either sees the link off or is closed here.
    await lockRequests(tx, orgId);
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
  await settleJoinRequests(deps, orgId, now);
  return { closed };
}

/**
 * Daily: deletes requests answered, closed or run out more than 90 days ago, and closes the admins' notices of
 * workspaces where nothing waits anymore (requests that ran out). Codes go a day after both their times pass, their
 * counts after a day, and so does a code's email the job couldn't delete (a worker that died sending it). Returns
 * how many requests were deleted.
 */
export async function pruneJoinRequests(deps: Deps, now = new Date()) {
  const dayAgo = new Date(now.getTime() - DAY_MS);
  await deps.db
    .delete(codes)
    .where(and(lt(codes.expiresAt, dayAgo), or(isNull(codes.verifiedUntil), lt(codes.verifiedUntil, dayAgo))));
  await deps.db.delete(codeEvents).where(lt(codeEvents.at, dayAgo));
  // ponytail: a scan of the outbox once a day; an index on the key's prefix if the outbox grows past millions.
  await deps.db
    .delete(outbox)
    .where(
      and(
        eq(outbox.kind, "email.send"),
        or(...Object.values(CODE_EMAILS).map((key) => like(outbox.dedupeKey, `email:${key}:%`))),
        lt(outbox.createdAt, dayAgo),
      ),
    );
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
  for (const { orgId } of open) await settleJoinRequests(deps, orgId, now);
  return gone.length;
}

/**
 * Someone opened an expired email invitation and asks for a new one (public: the token is the proof). The person
 * who invited them is told by email; if they can no longer invite, the org's admins are. Once per invitation, and
 * never from a workspace closed to its people (suspended or being deleted). An invitation link has no such request:
 * whoever holds one asks to join instead (ADR 0068).
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
    inviter && inviterId && can(inviter, "invite_people")
      ? [inviterId]
      : await adminIds(db, invitation.orgId, "invite_people");
  const [org] = await db
    .select({ name: organizations.name, closed: closedOrg })
    .from(organizations)
    .where(eq(organizations.id, invitation.orgId));
  if (!org || org.closed || recipientIds.length === 0) return;
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
