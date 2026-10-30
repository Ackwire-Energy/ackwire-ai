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
  lte,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { z } from "zod";
import { randomToken, sha256 } from "./crypto";
import { decodeCursor, encodeCursor } from "./cursor";
import { type EmailLocale, emailLocale, queueEmail } from "./email";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { WAITLIST_IMPORT_SOURCE } from "./waitlist";

/**
 * Early access (ADR 0078): the installation's sign-up mode, changed live, and invitations from the people who run
 * it, one per address, each letting that address create an account and then one workspace of its own. The
 * operator API drives all of it; the waiting list is where most addresses come from.
 */

const { signupSettings, earlyAccessInvitations: invitations, waitlistEntries, users } = schema;

export const SIGNUP_MODES = ["invite", "open"] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

/** A link works this long after its latest send. */
export const EARLY_ACCESS_TTL_DAYS = 14;
/** A send this soon after the previous one sends nothing (`recent`), so retries and double submits mail once. */
export const EARLY_ACCESS_RESEND_AFTER_MS = 2 * 60_000;
/** Addresses one call may invite. */
export const EARLY_ACCESS_INVITE_MAX = 200;
/** Entries one import may carry. */
export const WAITLIST_IMPORT_MAX = 5000;
/** What `randomToken(32)` makes: 256 bits in 43 base64url characters. */
export const EARLY_ACCESS_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** The password sign-up's header with the link's token (mirrored in `@agenteschat/client/lib/guards`). */
export const EARLY_ACCESS_HEADER = "x-early-access";

export const EARLY_ACCESS_STATES = ["sent", "expired", "signed_up", "workspace_created", "revoked"] as const;
export type EarlyAccessState = (typeof EARLY_ACCESS_STATES)[number];
export const EARLY_ACCESS_OUTCOMES = [
  "invited",
  "resent",
  "recent",
  "already_invited",
  "signed_up",
  "has_account",
  "invalid_email",
] as const;
export type EarlyAccessOutcome = (typeof EARLY_ACCESS_OUTCOMES)[number];

const EMAIL = z.email();

/** An address as invitations store and match it: trimmed, lowercase, one sign-up accepts (`z.email()`); else null. */
export function earlyAccessEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return email.length <= 254 && EMAIL.safeParse(email).success ? email : null;
}

// ── Sign-up mode ─────────────────────────────────────────────────────────────

/** The live mode; no row reads as `invite`. */
export async function signupMode(db: Executor): Promise<{ mode: SignupMode; changedAt: Date | null }> {
  const [row] = await db
    .select({ mode: signupSettings.mode, changedAt: signupSettings.changedAt })
    .from(signupSettings);
  return row ?? { mode: "invite", changedAt: null };
}

/** Sets the mode; setting the current one changes nothing, `changedAt` included. */
export async function setSignupMode(db: Database, mode: SignupMode, now = new Date()) {
  if ((await signupMode(db)).mode !== mode) {
    await db
      .insert(signupSettings)
      .values({ mode, changedAt: now })
      .onConflictDoUpdate({ target: signupSettings.id, set: { mode, changedAt: now } });
  }
  return signupMode(db);
}

// ── The link ─────────────────────────────────────────────────────────────────

/**
 * The invitation a link's token belongs to while it can still sign someone up (not used, not revoked; it may have
 * expired). Looked up only by the token's hash, never by address, so an invited address answers like any other.
 */
export async function earlyAccessLink(db: Executor, access: string | null | undefined) {
  if (!access || !EARLY_ACCESS_TOKEN.test(access)) return null;
  const [row] = await db
    .select({ email: invitations.email, expiresAt: invitations.expiresAt })
    .from(invitations)
    .where(and(eq(invitations.tokenHash, sha256(access)), isNull(invitations.usedAt), isNull(invitations.revokedAt)));
  return row ?? null;
}

/**
 * An account made with the link's token, before it expires, uses its invitation: once, and only for the address it
 * was sent to. The token goes, so the link signs nobody else up. An expired link uses nothing, even when the account
 * got in another way (open mode, a workspace's invitation). Returns whether it was used.
 */
export async function useEarlyAccess(
  db: Executor,
  input: { access: string; email: string; userId: string },
  now = new Date(),
) {
  if (!EARLY_ACCESS_TOKEN.test(input.access)) return false;
  const used = await db
    .update(invitations)
    .set({ usedAt: now, userId: input.userId, tokenHash: null })
    .where(
      and(
        eq(invitations.tokenHash, sha256(input.access)),
        eq(invitations.email, input.email.trim().toLowerCase()),
        isNull(invitations.usedAt),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, now),
      ),
    )
    .returning({ id: invitations.id });
  return used.length > 0;
}

// ── One workspace per invitation ─────────────────────────────────────────────

/**
 * Records a new workspace on its creator's invitation, in the workspace's own transaction. The row lock makes two
 * creations at once take it once: the second finds the row taken once the first commits. Returns whether there was
 * one to take.
 */
export async function claimWorkspaceAllowance(tx: Executor, userId: string, orgId: string, now = new Date()) {
  const claimed = await tx
    .update(invitations)
    .set({ workspaceCreatedAt: now, workspaceId: orgId })
    .where(
      eq(
        invitations.id,
        sql`(select id from ${invitations} where user_id = ${userId}
          and workspace_created_at is null and revoked_at is null limit 1 for update)`,
      ),
    )
    .returning({ id: invitations.id });
  return claimed.length > 0;
}

/** The account has an invitation that can still make its workspace. */
export async function hasWorkspaceAllowance(db: Executor, userId: string) {
  const [row] = await db
    .select({ id: invitations.id })
    .from(invitations)
    .where(and(eq(invitations.userId, userId), isNull(invitations.workspaceCreatedAt), isNull(invitations.revokedAt)))
    .limit(1);
  return row !== undefined;
}

// ── Invitations ──────────────────────────────────────────────────────────────

const stateOf = (now: Date) => sql<EarlyAccessState>`case
  when ${invitations.revokedAt} is not null then 'revoked'
  when ${invitations.workspaceCreatedAt} is not null then 'workspace_created'
  when ${invitations.usedAt} is not null then 'signed_up'
  when ${invitations.expiresAt} <= ${now.toISOString()}::timestamptz then 'expired'
  else 'sent' end`;

// Cut to milliseconds (what a JS Date and the cursor carry), so paging compares exactly what it returned.
const createdAtMs = sql<Date>`date_trunc('milliseconds', ${invitations.createdAt})`.mapWith(
  (v: string | Date) => new Date(v),
);
const InvitationCursor = z.tuple([z.iso.datetime(), z.uuid()]);

const invitationColumns = (now: Date) => ({
  id: invitations.id,
  email: invitations.email,
  locale: invitations.locale,
  state: stateOf(now),
  createdAt: createdAtMs,
  sentAt: invitations.sentAt,
  sends: invitations.sends,
  expiresAt: invitations.expiresAt,
  revokedAt: invitations.revokedAt,
  usedAt: invitations.usedAt,
  userId: invitations.userId,
  workspaceCreatedAt: invitations.workspaceCreatedAt,
  workspaceId: invitations.workspaceId,
});

export type EarlyAccessInvitation = Awaited<ReturnType<typeof invitationById>>;

async function invitationById(db: Executor, id: string, now: Date) {
  const [row] = await db.select(invitationColumns(now)).from(invitations).where(eq(invitations.id, id));
  if (!row) throw new NotFoundError("No invitation with this id");
  return { ...row, locale: emailLocale(row.locale) };
}

const hasAccount = async (db: Executor, email: string) =>
  (await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)).length > 0;

const sentLately = (sentAt: Date, now: Date) => now.getTime() - sentAt.getTime() < EARLY_ACCESS_RESEND_AFTER_MS;

/**
 * Sends the address its link: a new invitation, or the same one again with a new token (the old link stops working
 * at once), 14 more days and no revocation. Claimed by one conditional upsert, so two calls at once send one email;
 * null when it was not claimed (used, or sent in the last 2 minutes). The waiting list notes the first invitation.
 */
async function claimSend(tx: Executor, email: string, locale: EmailLocale, publicUrl: string, now: Date) {
  const token = randomToken(32);
  const fresh = {
    tokenHash: sha256(token),
    sentAt: now,
    expiresAt: new Date(now.getTime() + EARLY_ACCESS_TTL_DAYS * 86_400_000),
  };
  const [claimed] = await tx
    .insert(invitations)
    .values({ email, locale, createdAt: now, ...fresh })
    .onConflictDoUpdate({
      target: invitations.email,
      set: { ...fresh, sends: sql`${invitations.sends} + 1`, revokedAt: null },
      setWhere: and(
        isNull(invitations.usedAt),
        lte(invitations.sentAt, new Date(now.getTime() - EARLY_ACCESS_RESEND_AFTER_MS)),
      ),
    })
    .returning({ id: invitations.id, sends: invitations.sends, locale: invitations.locale });
  if (!claimed) return null;
  await tx
    .update(waitlistEntries)
    .set({ invitedAt: sql`coalesce(${waitlistEntries.invitedAt}, ${now.toISOString()}::timestamptz)` })
    .where(eq(waitlistEntries.email, email));
  await queueEmail(tx, {
    orgId: null,
    key: `early-access:${claimed.id}:${claimed.sends}`,
    to: [email],
    template: {
      kind: "early_access",
      locale: emailLocale(claimed.locale),
      email,
      url: `${publicUrl.replace(/\/$/, "")}/signup?email=${encodeURIComponent(email)}&access=${token}`,
      days: EARLY_ACCESS_TTL_DAYS,
    },
  });
  return claimed;
}

export type EarlyAccessResult = { email: string; outcome: EarlyAccessOutcome; invitationId?: string };

/**
 * Invites each address, each in its own transaction, answering in the request's order (an address repeated in
 * another form answers once, where it first came). An address whose invitation was used, or that has an account,
 * gets nothing; one invited already gets its link again unless `resend` is false. The email is in the language of
 * the invitation, else of the waiting list's entry, else `locale`, else pt-BR.
 */
export async function inviteEarlyAccess(
  db: Database,
  input: { emails: string[]; locale?: EmailLocale; resend: boolean; publicUrl: string },
  now = new Date(),
): Promise<EarlyAccessResult[]> {
  if (input.emails.length > EARLY_ACCESS_INVITE_MAX)
    throw new ValidationError(`At most ${EARLY_ACCESS_INVITE_MAX} addresses at a time`);
  const seen = new Set<string>();
  const results: EarlyAccessResult[] = [];
  for (const raw of input.emails) {
    const email = earlyAccessEmail(raw);
    if (!email) {
      results.push({ email: raw.trim(), outcome: "invalid_email" });
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    const answer = await db.transaction(async (tx): Promise<Omit<EarlyAccessResult, "email">> => {
      const [row] = await tx
        .select({ id: invitations.id, usedAt: invitations.usedAt, sentAt: invitations.sentAt })
        .from(invitations)
        .where(eq(invitations.email, email));
      const id = row ? { invitationId: row.id } : {};
      if (row?.usedAt) return { outcome: "signed_up", ...id };
      if (await hasAccount(tx, email)) return { outcome: "has_account", ...id };
      if (row && !input.resend) return { outcome: "already_invited", ...id };
      if (row && sentLately(row.sentAt, now)) return { outcome: "recent", ...id };
      const [entry] = row
        ? []
        : await tx
            .select({ locale: waitlistEntries.locale })
            .from(waitlistEntries)
            .where(eq(waitlistEntries.email, email));
      const claimed = await claimSend(tx, email, emailLocale(entry?.locale ?? input.locale), input.publicUrl, now);
      if (!claimed) return { outcome: "recent", ...id };
      return { outcome: row ? "resent" : "invited", invitationId: claimed.id };
    });
    results.push({ email, ...answer });
  }
  return results;
}

/** Sends one invitation again, unless it went out in the last 2 minutes (`sent: false`). */
export async function resendEarlyAccess(db: Database, id: string, publicUrl: string, now = new Date()) {
  return db.transaction(async (tx) => {
    const row = await invitationById(tx, id, now);
    if (row.usedAt) throw new ConflictError("This invitation was used: its account exists", "early_access.used");
    if (await hasAccount(tx, row.email))
      throw new ConflictError("This address already has an account", "early_access.has_account");
    const sent = !sentLately(row.sentAt, now) && (await claimSend(tx, row.email, row.locale, publicUrl, now)) !== null;
    return { invitation: sent ? await invitationById(tx, id, now) : row, sent };
  });
}

/**
 * Revokes an invitation: its link stops working, and an account made with it loses its workspace allowance.
 * Revoking again answers the same. Refused once its workspace exists.
 */
export async function revokeEarlyAccess(db: Database, id: string, now = new Date()) {
  const [revoked] = await db
    .update(invitations)
    .set({ revokedAt: sql`coalesce(${invitations.revokedAt}, ${now.toISOString()}::timestamptz)`, tokenHash: null })
    .where(and(eq(invitations.id, id), isNull(invitations.workspaceCreatedAt)))
    .returning({ id: invitations.id });
  if (!revoked) {
    await invitationById(db, id, now);
    throw new ConflictError("Its workspace exists: it can't be revoked", "early_access.workspace_created");
  }
  return invitationById(db, id, now);
}

export interface EarlyAccessQuery {
  state?: EarlyAccessState;
  /** Any part of the address, in any case, matched literally. */
  q?: string;
  limit: number;
  /** `next` of the previous page. */
  cursor?: string;
}

/** Invitations, newest first, in keyset pages, with how many are in each state (whatever the filters). */
export async function listEarlyAccess(db: Database, query: EarlyAccessQuery, now = new Date()) {
  const after = query.cursor ? decodeCursor(query.cursor, InvitationCursor) : null;
  const q = query.q?.trim();
  const rows = await db
    .select(invitationColumns(now))
    .from(invitations)
    .where(
      and(
        query.state ? sql`${stateOf(now)} = ${query.state}` : undefined,
        q ? sql`strpos(${invitations.email}, lower(${q}::text)) > 0` : undefined,
        after ? sql`(${createdAtMs}, ${invitations.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(createdAtMs), desc(invitations.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit).map((r) => ({ ...r, locale: emailLocale(r.locale) }));
  const last = page.at(-1);
  const next = rows.length > query.limit && last ? encodeCursor([last.createdAt.toISOString(), last.id]) : null;
  const count = (state: EarlyAccessState) =>
    sql<number>`count(*) filter (where ${stateOf(now)} = ${state})`.mapWith(Number);
  const [counts] = await db
    .select({
      sent: count("sent"),
      expired: count("expired"),
      signedUp: count("signed_up"),
      workspaceCreated: count("workspace_created"),
      revoked: count("revoked"),
    })
    .from(invitations);
  return {
    invitations: page,
    counts: counts ?? { sent: 0, expired: 0, signedUp: 0, workspaceCreated: 0, revoked: 0 },
    next,
  };
}

// ── The waiting list ─────────────────────────────────────────────────────────

/**
 * The waiting list against invitations: `waiting` are confirmed entries with no invitation (in any state) and no
 * account; `invited`, `signedUp` and `workspaceCreated` count confirmed entries whose invitation exists, was used,
 * or made its workspace.
 */
export async function waitlistCounts(db: Database) {
  const n = (filter: SQL) => sql<number>`count(*) filter (where ${filter})`.mapWith(Number);
  const confirmed = sql`${waitlistEntries.confirmedAt} is not null`;
  const [row] = await db
    .select({
      unconfirmed: n(sql`${waitlistEntries.confirmedAt} is null`),
      confirmed: n(confirmed),
      waiting: n(sql`${confirmed} and ${invitations.id} is null and ${users.id} is null`),
      invited: n(sql`${confirmed} and ${invitations.id} is not null`),
      signedUp: n(sql`${confirmed} and ${invitations.usedAt} is not null`),
      workspaceCreated: n(sql`${confirmed} and ${invitations.workspaceCreatedAt} is not null`),
    })
    .from(waitlistEntries)
    .leftJoin(invitations, eq(invitations.email, waitlistEntries.email))
    .leftJoin(users, eq(users.email, waitlistEntries.email));
  return row ?? { unconfirmed: 0, confirmed: 0, waiting: 0, invited: 0, signedUp: 0, workspaceCreated: 0 };
}

const joinedAtMs = sql<Date>`date_trunc('milliseconds', ${waitlistEntries.createdAt})`.mapWith(
  (v: string | Date) => new Date(v),
);

/**
 * The next confirmed entries still waiting (no invitation, no account), oldest first, skipping addresses sign-up
 * wouldn't take (they still count as waiting). A read: the caller invites exactly these, so a retry never invites
 * more than it showed.
 */
export async function waitlistNext(db: Database, limit: number) {
  const out: { email: string; locale: EmailLocale; joinedAt: Date }[] = [];
  let after: { joinedAt: Date; id: string } | null = null;
  while (out.length < limit) {
    const rows: { id: string; email: string; locale: string; joinedAt: Date }[] = await db
      .select({
        id: waitlistEntries.id,
        email: waitlistEntries.email,
        locale: waitlistEntries.locale,
        joinedAt: joinedAtMs,
      })
      .from(waitlistEntries)
      .leftJoin(invitations, eq(invitations.email, waitlistEntries.email))
      .leftJoin(users, eq(users.email, waitlistEntries.email))
      .where(
        and(
          sql`${waitlistEntries.confirmedAt} is not null and ${invitations.id} is null and ${users.id} is null`,
          after
            ? sql`(${joinedAtMs}, ${waitlistEntries.id}) > (${after.joinedAt.toISOString()}::timestamptz, ${after.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(asc(joinedAtMs), asc(waitlistEntries.id))
      .limit(limit);
    for (const r of rows) {
      if (out.length < limit && earlyAccessEmail(r.email) === r.email)
        out.push({ email: r.email, locale: emailLocale(r.locale), joinedAt: r.joinedAt });
    }
    const last = rows.at(-1);
    if (!last || rows.length < limit) break;
    after = { joinedAt: last.joinedAt, id: last.id };
  }
  return out;
}

/**
 * Adds addresses to the waiting list as confirmed (they confirmed elsewhere), in one transaction, deduplicated on
 * the stored form. New ones join at `joinedAt` (never later than now), else in the list's own order; an
 * unconfirmed entry is confirmed and keeps the rest; anything else is unchanged. `invalid` holds the indexes of the
 * entries that aren't addresses. Imported entries never sync to the email provider's contacts: they came from
 * there.
 */
export async function importWaitlist(
  db: Database,
  entries: { email: string; locale?: EmailLocale; joinedAt?: Date }[],
  now = new Date(),
) {
  if (entries.length > WAITLIST_IMPORT_MAX)
    throw new ValidationError(`At most ${WAITLIST_IMPORT_MAX} entries at a time`, "too_many", {
      max: WAITLIST_IMPORT_MAX,
    });
  const invalid: number[] = [];
  const fresh = new Map<string, { email: string; locale: EmailLocale; createdAt: Date }>();
  let valid = 0;
  for (const [i, entry] of entries.entries()) {
    const email = earlyAccessEmail(entry.email);
    if (!email) {
      invalid.push(i);
      continue;
    }
    valid++;
    if (fresh.has(email)) continue;
    const joined = entry.joinedAt ? new Date(Math.min(entry.joinedAt.getTime(), now.getTime())) : null;
    fresh.set(email, { email, locale: emailLocale(entry.locale), createdAt: joined ?? new Date(now.getTime() + i) });
  }
  const rows = [...fresh.values()];
  if (rows.length === 0) return { added: 0, confirmed: 0, unchanged: valid, invalid };
  return db.transaction(async (tx) => {
    const added = await tx
      .insert(waitlistEntries)
      .values(rows.map((r) => ({ ...r, source: WAITLIST_IMPORT_SOURCE, confirmedAt: now })))
      .onConflictDoNothing()
      .returning({ id: waitlistEntries.id });
    const confirmed = await tx
      .update(waitlistEntries)
      .set({ confirmedAt: now })
      .where(
        and(
          inArray(
            waitlistEntries.email,
            rows.map((r) => r.email),
          ),
          isNull(waitlistEntries.confirmedAt),
        ),
      )
      .returning({ id: waitlistEntries.id });
    return {
      added: added.length,
      confirmed: confirmed.length,
      unchanged: valid - added.length - confirmed.length,
      invalid,
    };
  });
}
