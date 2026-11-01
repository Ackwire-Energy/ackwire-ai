import type { PubSub, ScreenKind } from "@agenteschat/adapters";
import {
  and,
  type Database,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  like,
  lte,
  or,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { NotFoundError, ValidationError } from "./errors";
import { publishUserEvent } from "./events";
import { cutText } from "./format";
import { noticeOn, noticePrefsOf } from "./notice-prefs";
import { requirePermission } from "./organizations";
import { enqueuePush } from "./push";
import type { ApprovalOrigin } from "./tools/run-policy";

const { notifications, organizationMembers } = schema;

/**
 * In-app notifications: one inbox per person per organization.
 *
 * - People only: agents are never recipients, and nobody is notified of
 *   their own action.
 * - Grouping: while an unread, not-done row of the same `(user, groupKey)`
 *   exists, a new event of a merging kind (thread replies, issue comments,
 *   reactions) merges into it. Other kinds are one row per event, and the
 *   same `groupKey` twice is a no-op (jobs may run more than once).
 * - Realtime goes to the recipient only (`userTopic`, cross-replica):
 *   `notification.upserted`, `notification.removed`, `notification.counts`.
 * - Auto-resolve: the source closed (question answered, approval decided,
 *   forum turn over, issue unassigned) sets `done_at` and emits `removed`.
 * - Push (ADR 0035): the first event of a group of a pushing kind enqueues
 *   `push.send` for the person's phones (`push.ts`).
 */

export const NOTIFICATION_KINDS = [
  "mention",
  "thread_reply",
  "dm",
  /**
   * An agent answered the person behind its run (ADR 0071): merged per conversation (`agentReplyGroup`), resolved
   * when they read it there. So someone can close the tab while an agent works and still hear when it's done.
   */
  "agent_reply",
  "agent_question",
  "issue_assigned",
  "issue_comment",
  "issue_status",
  "forum_turn",
  "forum_synthesis",
  "approval",
  "mission_finished",
  "mission_stopped",
  "routine_finished",
  "routine_failed",
  /**
   * A conversation run failed for good (ADR 0097): the person accountable for it, else the agent's owner, once per
   * agent and conversation, its coded reason in `latest.reason`. Resolved by the agent's next good run there.
   */
  "run_failed",
  /** A routine paused itself (its reason in `latest.reason`), ADR 0053. */
  "routine_paused",
  /** A routine waits for its computer (once per outage), ADR 0053. */
  "routine_stalled",
  /**
   * A routine set to act named an agent its creator can't talk to (`reach.ts`): the agent's owner, once per routine
   * and agent, `source.agentId` the agent, opening the message.
   */
  "agent_unreached",
  /** A routine's run waits for its agent's plan to reset (once per outage, like `routine_stalled`). */
  "routine_waiting_plan",
  /**
   * An agent's work waited a day on its plan's limit and the plan never said when it resets (the agent's owner,
   * once per wait): `latest.title` the plan's name, `source.label` the agent's.
   */
  "plan_reset_unknown",
  "reaction",
  "machine_connected",
  /** An agent needs a person in its browser (ADR 0040 §6). */
  "browser_handoff",
  /** An agent waits for a secret only that person can give (ADR 0027): `latest.title` its name, `text` its purpose. */
  "secret_request",
  /**
   * The workspace was held, suspended or restored, with the notice shown (owners and admins, ADR 0056 §8), or on
   * agentes.chat Cloud one of its agents was held (`statusTo: "agent_hold"`, also its responsible person, §9).
   */
  "org_standing",
  /** The workspace's own computer is ready (owners, ADR 0056 §10). */
  "computer_ready",
  /**
   * Someone asks to join through the invitation link (owners and admins, ADR 0068): waiting, one row per workspace
   * merging the burst, `latest.title` the newest name and `latest.names` the first ones, `source.label` the
   * workspace's. No actor: the person isn't a member. Never their note.
   */
  "join_request",
  /**
   * Someone accepted the email invitation this person sent (ADR 0090): one row per person who joined, the person as
   * actor, `latest.title` their name, `source.label` the workspace's. Inbox only (no category, so never a push).
   */
  "invitation_accepted",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_FILTERS = ["all", "mentions", "waiting", "unread", "reactions"] as const;
export type NotificationFilter = (typeof NOTIFICATION_FILTERS)[number];

export interface NotificationActor {
  type: "user" | "agent";
  id: string;
}

export interface NotificationSource {
  channelId?: string;
  threadId?: string;
  messageId?: string;
  dmId?: string;
  issueId?: string;
  issueNumber?: number;
  topicId?: string;
  approvalId?: string;
  questionId?: string;
  missionId?: string;
  routineId?: string;
  /** A computer connected to the organization (ADR 0036). */
  machineId?: string;
  /** An agent's browser handoff (ADR 0040). */
  handoffId?: string;
  /** Which of the agent's screens it is on, when not its browser (ADR 0058). */
  screen?: ScreenKind;
  /** `agent_unreached`: the routine's creator, whom the agent's owner may let talk to `agentId`. */
  userId?: string;
  /** The agent held on agentes.chat Cloud (`org_standing` to `agent_hold`, its name in `label`). */
  agentId?: string;
  /** Channel name, thread title, issue title, topic title, mission or routine name. */
  label?: string;
}

export interface NotificationLatest {
  /** Snippet of the latest message, comment, question or summary (plain text, ≤ 280 chars); an approval's why. */
  text?: string;
  /** A message with only a GIF or a sticker (ADR 0091): which one, so the apps say it in the person's language. */
  media?: "gif" | "sticker";
  title?: string;
  emojis?: string[];
  quote?: string;
  statusFrom?: string;
  statusTo?: string;
  /** `org_standing`: the billing hold put on (`payment`, `unpaid`, `ended`; ADR 0079), in place of `text`. */
  billingHold?: string;
  steps?: { done: number; total: number; failedAt?: number };
  suggestions?: string[];
  expiresAt?: string;
  round?: number;
  rounds?: number;
  /**
   * `routine_paused`: why it paused itself; `routine_failed`: its failed run's code (coded reasons the app
   * translates).
   */
  reason?: string;
  /** `approval`: asked while nobody watched, by a routine (its name) or an unattended run (ADR 0053 §8). */
  origin?: ApprovalOrigin;
  /** `org_standing` to `agent_hold`: the hold's kind, `network` or `operator`, never its reason. */
  holdKind?: string;
  /** `org_standing` on agentes.chat Cloud: the apps read `text` as the restriction does, with how to contest it. */
  cloud?: boolean;
  /**
   * `join_request`: who asked, by name (they aren't members, so no actors), the first `MAX_NAMES` in the order they
   * asked: a merged row names whoever its time is from, and `count` says how many asked in all.
   */
  names?: string[];
  /** `join_request` from a member's suggestion (ADR 0090): who suggested, so a row of one says so. */
  suggestedBy?: string;
}

export interface NotificationView {
  id: string;
  kind: NotificationKind;
  waiting: boolean;
  actors: NotificationActor[];
  count: number;
  source: NotificationSource;
  latest: NotificationLatest;
  readAt: string | null;
  doneAt: string | null;
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationCounts {
  all: number;
  mentions: number;
  waiting: number;
  unread: number;
  reactions: number;
}

export interface NotificationDeps {
  db: Database;
  pubsub?: PubSub;
  now?: () => Date;
}

type Row = typeof notifications.$inferSelect;

/** Kinds whose events merge into one open row of their group. */
const MERGING: ReadonlySet<NotificationKind> = new Set([
  "thread_reply",
  "agent_reply",
  "issue_comment",
  "reaction",
  "join_request",
  // One per approval card: requests joining it update it, read or not (`notifyApproval`).
  "approval",
]);
/** "Menções" in the inbox: what was said to me. */
const MENTION_KINDS: NotificationKind[] = ["mention", "dm", "agent_reply", "agent_question"];
/** A read reaction row still takes new reactions for this long (the "9 min" span on the card). */
export const REACTION_MERGE_MS = 30 * 60_000;
export const MAX_ACTORS = 10;
export const SNIPPET_LENGTH = 280;
export const MAX_PAGE = 100;
/** How far ahead a notification can be snoozed. */
export const MAX_SNOOZE_MS = 365 * 24 * 3600_000;

const nowOf = (deps: { now?: () => Date }) => deps.now?.() ?? new Date();

/** How many people a merged row names (`latest.names`); the rest are counted. */
const MAX_NAMES = 2;

/**
 * Plain text for a card: code fences, markdown marks and links reduced to
 * their words, whitespace collapsed, at most `max` chars. `@mentions` stay.
 */
export function notificationSnippet(text: string | null | undefined, max = SNIPPET_LENGTH): string {
  if (!text) return "";
  const plain = text
    .replace(/```[\w+-]*/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, "$1")
    .replace(/(^|\s)#{1,6}\s+/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|\s)[>*-]\s+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${cutText(plain, max - 1).trimEnd()}…` : plain;
}

export function notificationView(r: Row): NotificationView {
  return {
    id: r.id,
    kind: r.kind as NotificationKind,
    waiting: r.waiting,
    actors: r.actors,
    count: r.count,
    source: r.source as NotificationSource,
    latest: r.latest as NotificationLatest,
    readAt: r.readAt?.toISOString() ?? null,
    doneAt: r.doneAt?.toISOString() ?? null,
    snoozedUntil: r.snoozedUntil?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const sameActor = (a: NotificationActor, b: NotificationActor) => a.type === b.type && a.id === b.id;

/** The newest actor first, no duplicates, at most `MAX_ACTORS`. */
export function mergeActors(newest: NotificationActor | null | undefined, before: NotificationActor[]) {
  const list = newest ? [newest, ...before.filter((a) => !sameActor(a, newest))] : before;
  return list.slice(0, MAX_ACTORS);
}

/** A merge's `latest`: the newest event's, the names the row had kept first (each once, `MAX_NAMES`). */
function mergeLatest(next: Record<string, unknown>, before: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(next.names) || !Array.isArray(before.names)) return next;
  return { ...next, names: [...new Set([...before.names, ...next.names])].slice(0, MAX_NAMES) };
}

/** Drops empty values so the stored JSON holds only what is set. */
function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as T;
}

// ── Writing ───────────────────────────────────────────────────────────────────

export interface NotifyInput {
  orgId: string;
  /** Recipients (people). Empty values, the actor and non-members are dropped. */
  userIds: Iterable<string | null | undefined>;
  kind: NotificationKind;
  groupKey: string;
  waiting?: boolean;
  /** Who did it (newest actor); a person is never notified of their own action. */
  actor?: NotificationActor | null;
  source: NotificationSource;
  latest?: NotificationLatest;
}

/**
 * Creates or merges a notification for each recipient and tells them. Best
 * effort for callers: wrap in `.catch` where a failure must not undo the
 * action that caused it.
 */
export async function notify(deps: NotificationDeps, input: NotifyInput): Promise<NotificationView[]> {
  const actorUser = input.actor?.type === "user" ? input.actor.id : null;
  const wanted = [...new Set([...input.userIds].filter((u): u is string => !!u && u !== actorUser))];
  if (wanted.length === 0) return [];
  // People of this organization only (an agent's id never matches a member).
  const members = await deps.db
    .select({ userId: organizationMembers.userId, prefs: organizationMembers.noticePrefs })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, input.orgId), inArray(organizationMembers.userId, wanted)));
  const out: NotificationView[] = [];
  for (const member of members) {
    const { userId } = member;
    const row = await upsertOne(deps, input, userId);
    if (!row) continue;
    const view = notificationView(row);
    out.push(view);
    // Whether it reaches their devices as a notification (ADR 0071 §8): the desktop app's banner reads `alert`.
    const prefs = noticePrefsOf(member.prefs);
    const snoozed = row.snoozedUntil && row.snoozedUntil.getTime() > nowOf(deps).getTime();
    if (!snoozed)
      await publishUserEvent(deps.pubsub, input.orgId, userId, {
        type: "notification.upserted",
        notification: view,
        alert: noticeOn(prefs, row.kind, row.waiting),
      });
    await publishCounts(deps, input.orgId, userId);
    // Their phone and browsers too (ADR 0035, 0071), through the outbox; never undoes the notification.
    await enqueuePush(deps.db, row, nowOf(deps), prefs).catch(() => false);
  }
  return out;
}

async function upsertOne(deps: NotificationDeps, input: NotifyInput, userId: string): Promise<Row | null> {
  const { db } = deps;
  const now = nowOf(deps);
  const source = compact(input.source) as Record<string, unknown>;
  const latest = compact(input.latest ?? {}) as Record<string, unknown>;
  const fresh = () =>
    db
      .insert(notifications)
      .values({
        orgId: input.orgId,
        userId,
        kind: input.kind,
        waiting: input.waiting ?? false,
        groupKey: input.groupKey,
        actors: mergeActors(input.actor, []),
        count: 1,
        source,
        latest,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
  const sameGroup = and(
    eq(notifications.orgId, input.orgId),
    eq(notifications.groupKey, input.groupKey),
    eq(notifications.userId, userId),
  );

  if (!MERGING.has(input.kind)) {
    // One row per event: the same key again (a retried job) changes nothing.
    const [seen] = await db.select({ id: notifications.id }).from(notifications).where(sameGroup).limit(1);
    if (seen) return null;
    const [row] = await fresh();
    return row ?? null;
  }

  const reaction = input.kind === "reaction";
  for (let attempt = 0; attempt < 4; attempt++) {
    const [open] = await db
      .select()
      .from(notifications)
      .where(
        and(
          sameGroup,
          isNull(notifications.doneAt),
          input.kind === "approval"
            ? undefined
            : reaction
              ? or(
                  isNull(notifications.readAt),
                  gt(notifications.updatedAt, new Date(now.getTime() - REACTION_MERGE_MS)),
                )
              : isNull(notifications.readAt),
        ),
      )
      .orderBy(sql`${notifications.readAt} is not null`, desc(notifications.updatedAt))
      .limit(1);
    if (open) {
      try {
        // Optimistic: only if nobody merged into it meanwhile (else read it again).
        const [row] = await db
          .update(notifications)
          .set({
            actors: mergeActors(input.actor, open.actors),
            count: sql`${notifications.count} + 1`,
            latest: Object.keys(latest).length ? mergeLatest(latest, open.latest) : open.latest,
            source: { ...open.source, ...source },
            readAt: null,
            updatedAt: now,
          })
          .where(and(eq(notifications.id, open.id), eq(notifications.updatedAt, open.updatedAt)))
          .returning();
        if (row) return row;
      } catch {
        // A concurrent unread row of the same group appeared: read again.
      }
      continue;
    }
    const [row] = await fresh();
    if (row) return row;
  }
  return null;
}

/**
 * Auto-resolve: the open notifications of a group (or of every group with
 * this prefix) are done, for everyone or for some people. Emits `removed`.
 */
export async function resolveNotifications(
  deps: NotificationDeps,
  orgId: string,
  match: { groupKey?: string; groupKeyPrefix?: string; userIds?: string[]; kind?: NotificationKind },
): Promise<number> {
  if (!match.groupKey && !match.groupKeyPrefix) return 0;
  if (match.userIds && match.userIds.length === 0) return 0;
  const rows = await deps.db
    .update(notifications)
    .set({ doneAt: nowOf(deps) })
    .where(
      and(
        eq(notifications.orgId, orgId),
        isNull(notifications.doneAt),
        match.groupKey ? eq(notifications.groupKey, match.groupKey) : undefined,
        match.groupKeyPrefix ? like(notifications.groupKey, `${escapeLike(match.groupKeyPrefix)}%`) : undefined,
        match.userIds ? inArray(notifications.userId, match.userIds) : undefined,
        match.kind ? eq(notifications.kind, match.kind) : undefined,
      ),
    )
    .returning({ id: notifications.id, userId: notifications.userId });
  const users = new Set<string>();
  for (const r of rows) {
    users.add(r.userId);
    await publishUserEvent(deps.pubsub, orgId, r.userId, { type: "notification.removed", id: r.id });
  }
  for (const userId of users) await publishCounts(deps, orgId, userId);
  return rows.length;
}

/**
 * A group's open notifications describe something else now (an approval card whose first waiting request was
 * decided): each person's row gets what `pick` says for them, in place (no new count, no push, same order), or
 * is resolved when `pick` has nothing left for them.
 */
export async function retargetNotifications(
  deps: NotificationDeps,
  orgId: string,
  groupKey: string,
  pick: (userId: string) => { source: Partial<NotificationSource>; latest: NotificationLatest } | null,
): Promise<void> {
  const rows = await deps.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.orgId, orgId), eq(notifications.groupKey, groupKey), isNull(notifications.doneAt)));
  const done: string[] = [];
  for (const r of rows) {
    const next = pick(r.userId);
    if (!next) {
      done.push(r.userId);
      continue;
    }
    const [row] = await deps.db
      .update(notifications)
      .set({ source: { ...r.source, ...next.source }, latest: compact({ ...r.latest, ...next.latest }) })
      .where(eq(notifications.id, r.id))
      .returning();
    if (row)
      await publishUserEvent(deps.pubsub, orgId, r.userId, {
        type: "notification.upserted",
        notification: notificationView(row),
      });
  }
  if (done.length) await resolveNotifications(deps, orgId, { groupKey, userIds: done });
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Snoozed notifications whose time came: back in the inbox, on top (worker, every 30 s). */
export async function wakeSnoozedNotifications(deps: NotificationDeps): Promise<number> {
  const now = nowOf(deps);
  const rows = await deps.db
    .update(notifications)
    .set({ snoozedUntil: null, updatedAt: now })
    .where(and(lte(notifications.snoozedUntil, now), isNull(notifications.doneAt)))
    .returning();
  const users = new Map<string, string>();
  for (const r of rows) {
    users.set(`${r.orgId}:${r.userId}`, r.orgId);
    await publishUserEvent(deps.pubsub, r.orgId, r.userId, {
      type: "notification.upserted",
      notification: notificationView(r),
    });
  }
  for (const [key, orgId] of users) await publishCounts(deps, orgId, key.slice(orgId.length + 1));
  return rows.length;
}

// ── Reading ───────────────────────────────────────────────────────────────────

/** Not done, and not snoozed into the future. */
function visible(orgId: string, userId: string, now: Date): SQL {
  return and(
    eq(notifications.orgId, orgId),
    eq(notifications.userId, userId),
    isNull(notifications.doneAt),
    or(isNull(notifications.snoozedUntil), lte(notifications.snoozedUntil, now)),
  ) as SQL;
}

function filterSql(filter: NotificationFilter): SQL | undefined {
  switch (filter) {
    case "mentions":
      return inArray(notifications.kind, MENTION_KINDS);
    case "waiting":
      return eq(notifications.waiting, true);
    case "unread":
      return isNull(notifications.readAt);
    case "reactions":
      return eq(notifications.kind, "reaction");
    default:
      return undefined;
  }
}

/** Opaque keyset cursor over `(waiting desc, updated_at desc, id desc)`. */
function encodeCursor(r: Row) {
  return Buffer.from(JSON.stringify([r.waiting ? 1 : 0, r.updatedAt.toISOString(), r.id])).toString("base64url");
}

function decodeCursor(cursor: string): [number, Date, string] {
  try {
    const [w, u, id] = JSON.parse(Buffer.from(cursor, "base64url").toString()) as [unknown, unknown, unknown];
    const at = new Date(String(u));
    if ((w !== 0 && w !== 1) || Number.isNaN(at.getTime()) || typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
      throw new Error("bad cursor");
    return [w, at, id];
  } catch {
    throw new ValidationError("Invalid cursor", "notifications.bad_cursor");
  }
}

async function countsOf(db: Database, orgId: string, userId: string, now: Date): Promise<NotificationCounts> {
  const [row] = await db
    .select({
      all: sql<number>`count(*)::int`,
      mentions: sql<number>`(count(*) filter (where ${inArray(notifications.kind, MENTION_KINDS)}))::int`,
      waiting: sql<number>`(count(*) filter (where ${notifications.waiting}))::int`,
      unread: sql<number>`(count(*) filter (where ${notifications.readAt} is null))::int`,
      reactions: sql<number>`(count(*) filter (where ${notifications.kind} = 'reaction'))::int`,
    })
    .from(notifications)
    .where(visible(orgId, userId, now));
  return {
    all: Number(row?.all ?? 0),
    mentions: Number(row?.mentions ?? 0),
    waiting: Number(row?.waiting ?? 0),
    unread: Number(row?.unread ?? 0),
    reactions: Number(row?.reactions ?? 0),
  };
}

/** The inbox: waiting first, then newest; with the counts of every filter (the same visible set). */
export async function listNotifications(
  deps: NotificationDeps,
  userId: string,
  orgId: string,
  options: { filter?: NotificationFilter; cursor?: string | null; limit?: number } = {},
): Promise<{ items: NotificationView[]; counts: NotificationCounts; nextCursor: string | null }> {
  const { db } = deps;
  await requirePermission(db, userId, orgId, "read");
  const now = nowOf(deps);
  const filter = options.filter ?? "all";
  if (!NOTIFICATION_FILTERS.includes(filter)) throw new ValidationError("Unknown filter");
  const limit = Math.max(1, Math.min(options.limit ?? 50, MAX_PAGE));
  const after = options.cursor ? decodeCursor(options.cursor) : null;
  const [rows, counts] = await Promise.all([
    db
      .select()
      .from(notifications)
      .where(
        and(
          visible(orgId, userId, now),
          filterSql(filter),
          after
            ? sql`(${notifications.waiting}::int, ${notifications.updatedAt}, ${notifications.id}) < (${after[0]}::int, ${after[1].toISOString()}::timestamptz, ${after[2]}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(notifications.waiting), desc(notifications.updatedAt), desc(notifications.id))
      .limit(limit + 1),
    countsOf(db, orgId, userId, now),
  ]);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(notificationView),
    counts,
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
}

/** The badge: unread and waiting, over the visible inbox. */
export async function notificationCounts(deps: NotificationDeps, userId: string, orgId: string) {
  await requirePermission(deps.db, userId, orgId, "read");
  const c = await countsOf(deps.db, orgId, userId, nowOf(deps));
  return { unread: c.unread, waiting: c.waiting };
}

async function publishCounts(deps: NotificationDeps, orgId: string, userId: string) {
  if (!deps.pubsub) return;
  const c = await countsOf(deps.db, orgId, userId, nowOf(deps)).catch(() => null);
  if (c)
    await publishUserEvent(deps.pubsub, orgId, userId, {
      type: "notification.counts",
      unread: c.unread,
      waiting: c.waiting,
    });
}

// ── The person's actions ──────────────────────────────────────────────────────

async function mine(deps: NotificationDeps, userId: string, orgId: string, id: string) {
  await requirePermission(deps.db, userId, orgId, "read");
  const [row] = await deps.db
    .select()
    .from(notifications)
    .where(and(eq(notifications.id, id), eq(notifications.orgId, orgId), eq(notifications.userId, userId)));
  if (!row) throw new NotFoundError("Notification not found");
  return row;
}

/**
 * Applies a change to one of the person's notifications. Bringing a row back
 * to "unread, not done" while another open row of its group exists would
 * break the one-open-row rule: then nothing changes.
 */
async function change(deps: NotificationDeps, row: Row, set: Partial<typeof notifications.$inferInsert>) {
  try {
    const [updated] = await deps.db.update(notifications).set(set).where(eq(notifications.id, row.id)).returning();
    return updated ?? row;
  } catch {
    return row;
  }
}

export async function markNotificationRead(
  deps: NotificationDeps,
  userId: string,
  orgId: string,
  id: string,
  read: boolean,
): Promise<NotificationView> {
  const row = await mine(deps, userId, orgId, id);
  const updated = await change(deps, row, { readAt: read ? (row.readAt ?? nowOf(deps)) : null });
  const view = notificationView(updated);
  if (!updated.doneAt) {
    await publishUserEvent(deps.pubsub, orgId, userId, { type: "notification.upserted", notification: view });
  }
  await publishCounts(deps, orgId, userId);
  return view;
}

/** "Concluir" (out of the inbox) or its undo. */
export async function markNotificationDone(
  deps: NotificationDeps,
  userId: string,
  orgId: string,
  id: string,
  done: boolean,
): Promise<NotificationView> {
  const row = await mine(deps, userId, orgId, id);
  const updated = await change(deps, row, { doneAt: done ? (row.doneAt ?? nowOf(deps)) : null });
  const view = notificationView(updated);
  await publishUserEvent(
    deps.pubsub,
    orgId,
    userId,
    updated.doneAt
      ? { type: "notification.removed", id: row.id }
      : { type: "notification.upserted", notification: view },
  );
  await publishCounts(deps, orgId, userId);
  return view;
}

/**
 * "Lembrar depois": hidden until `until`, then back on top (`notification.upserted`).
 * `until: null` undoes it: back in the inbox now, nothing else changes.
 */
export async function snoozeNotification(
  deps: NotificationDeps,
  userId: string,
  orgId: string,
  id: string,
  until: Date | null,
): Promise<NotificationView> {
  if (until === null) {
    const row = await mine(deps, userId, orgId, id);
    const updated = await change(deps, row, { snoozedUntil: null });
    const view = notificationView(updated);
    if (!updated.doneAt) {
      await publishUserEvent(deps.pubsub, orgId, userId, { type: "notification.upserted", notification: view });
    }
    await publishCounts(deps, orgId, userId);
    return view;
  }
  if (Number.isNaN(until.getTime())) throw new ValidationError("Invalid date", "notifications.bad_snooze");
  const now = nowOf(deps);
  if (until.getTime() <= now.getTime())
    throw new ValidationError("Pick a time in the future", "notifications.snooze_in_past");
  if (until.getTime() - now.getTime() > MAX_SNOOZE_MS)
    throw new ValidationError("At most a year ahead", "notifications.snooze_too_far");
  const row = await mine(deps, userId, orgId, id);
  const updated = await change(deps, row, { snoozedUntil: until });
  await publishUserEvent(deps.pubsub, orgId, userId, { type: "notification.removed", id: row.id });
  await publishCounts(deps, orgId, userId);
  return notificationView(updated);
}

/** "Marcar tudo como lido" (in a filter): the ids changed, for the undo. */
export async function markAllNotificationsRead(
  deps: NotificationDeps,
  userId: string,
  orgId: string,
  filter: NotificationFilter = "all",
): Promise<{ ids: string[] }> {
  await requirePermission(deps.db, userId, orgId, "read");
  if (!NOTIFICATION_FILTERS.includes(filter)) throw new ValidationError("Unknown filter");
  const now = nowOf(deps);
  const rows = await deps.db
    .update(notifications)
    .set({ readAt: now })
    .where(and(visible(orgId, userId, now), filterSql(filter), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  if (rows.length > 0) await publishCounts(deps, orgId, userId);
  return { ids: rows.map((r) => r.id) };
}
