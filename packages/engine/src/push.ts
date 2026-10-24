import type { PushMessage, PushSender } from "@agenteschat/adapters";
import { and, asc, type Database, eq, inArray, schema } from "@agenteschat/db";
import type { NotificationActor, NotificationLatest, NotificationSource } from "./notifications";
import { enqueue } from "./outbox";
import { pushLocale, renderPush } from "./push-messages";

const { pushDevices, notifications, agents, users, approvals } = schema;

/**
 * Push to the phone app (ADR 0035). A notification that should reach
 * the person's phone enqueues one `push.send` job; the job renders the text
 * per device language and sends through the `PushSender` adapter.
 *
 * What pushes: everything in "Esperando você" (approval, agent question,
 * forum turn), mentions, DMs from a person, and missions or routines that
 * stopped or failed. Not what is read, done or snoozed by the time the job
 * runs. Grouped notifications push once per group while unread (only the
 * event that opened the row pushes).
 */

export const PUSH_KINDS: ReadonlySet<string> = new Set([
  "approval",
  "agent_question",
  "forum_turn",
  "mention",
  "dm",
  "mission_stopped",
  "routine_failed",
  "routine_paused",
  "routine_stalled",
  "machine_connected",
  "browser_handoff",
]);

/** Expo keeps receipts for a day and has most ready within 15 minutes: ask then. */
export const PUSH_RECEIPTS_DELAY_MS = 15 * 60_000;

/** Devices kept per person (the oldest beyond this are dropped when a new one registers). */
export const MAX_PUSH_DEVICES = 10;

export const PUSH_PLATFORMS = ["ios", "android"] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

/** An Expo push token as the app gets it from `getExpoPushTokenAsync`. */
export const EXPO_PUSH_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/;

type NotificationRow = typeof notifications.$inferSelect;

/** Whether a notification should be on the person's phone (now). */
export function pushWorthy(
  row: Pick<NotificationRow, "kind" | "waiting" | "readAt" | "doneAt" | "snoozedUntil">,
  now: Date,
): boolean {
  if (!row.waiting && !PUSH_KINDS.has(row.kind)) return false;
  if (row.readAt || row.doneAt) return false;
  return !(row.snoozedUntil && row.snoozedUntil.getTime() > now.getTime());
}

/**
 * Called by `notify` for each row it created or merged into: the first event
 * of a group (count 1) of a pushing kind enqueues `push.send`, when the
 * person has a phone registered.
 */
export async function enqueuePush(db: Database, row: NotificationRow, now = new Date()): Promise<boolean> {
  if (row.count !== 1 || !pushWorthy(row, now)) return false;
  const [device] = await db
    .select({ id: pushDevices.id })
    .from(pushDevices)
    .where(eq(pushDevices.userId, row.userId))
    .limit(1);
  if (!device) return false;
  await enqueue(db, {
    orgId: row.orgId,
    kind: "push.send",
    payload: { notificationId: row.id },
    dedupeKey: `push.send:${row.id}`,
    maxAttempts: 4,
  });
  return true;
}

// ── Devices ───────────────────────────────────────────────────────────────────

/**
 * Registers (or refreshes) a phone for a person. A token already registered
 * moves to this person (the phone changed hands or accounts). Keeps the
 * newest `MAX_PUSH_DEVICES` per person.
 */
export async function registerPushDevice(
  db: Database,
  userId: string,
  input: { token: string; platform: PushPlatform; locale: string },
  now = new Date(),
) {
  await db
    .insert(pushDevices)
    .values({ userId, token: input.token, platform: input.platform, locale: input.locale, lastSeenAt: now })
    .onConflictDoUpdate({
      target: pushDevices.token,
      set: { userId, platform: input.platform, locale: input.locale, lastSeenAt: now },
    });
  const devices = await db
    .select({ id: pushDevices.id })
    .from(pushDevices)
    .where(eq(pushDevices.userId, userId))
    .orderBy(asc(pushDevices.lastSeenAt));
  const extra = devices.slice(0, Math.max(0, devices.length - MAX_PUSH_DEVICES)).map((d) => d.id);
  if (extra.length > 0) await db.delete(pushDevices).where(inArray(pushDevices.id, extra));
}

/** Forgets one of the person's phones (sign-out on the device). Other people's tokens are untouched. */
export async function unregisterPushDevice(db: Database, userId: string, token: string): Promise<boolean> {
  const rows = await db
    .delete(pushDevices)
    .where(and(eq(pushDevices.userId, userId), eq(pushDevices.token, token)))
    .returning({ id: pushDevices.id });
  return rows.length > 0;
}

export async function listPushDevices(db: Database, userId: string) {
  return db.select().from(pushDevices).where(eq(pushDevices.userId, userId)).orderBy(asc(pushDevices.createdAt));
}

// ── Delivery (job `push.send`) ────────────────────────────────────────────────

export interface PushDeps {
  db: Database;
  push?: PushSender | null;
  now?: () => Date;
}

/** Same rule as the web's approval card: production, irreversible or external actions are high risk. */
export function approvalIsHighRisk(approval: { tool: string; scope: string }): boolean {
  const text = `${approval.tool} ${approval.scope}`.toLowerCase();
  if (text.includes("merge")) return false;
  if (text.includes("rollback")) return true;
  if (text.includes("deploy") || text.includes("workflow") || text.includes("actions.run")) return true;
  if (/delete|remove|destroy|drop|purge/.test(text)) return true;
  return /send|email|mail\b|sms/.test(text) && !text.includes("post_message");
}

async function actorName(db: Database, orgId: string, actor: NotificationActor | undefined) {
  if (!actor) return null;
  if (actor.type === "agent") {
    const [a] = await db
      .select({ name: agents.name })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.id, actor.id)));
    return a?.name ?? null;
  }
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, actor.id));
  return u?.name ?? null;
}

/**
 * Sends the push of one notification to every phone of its person, unless it
 * was read, done or snoozed meanwhile. Tokens Expo reports as unregistered
 * are deleted. Accepted tickets are checked again later: a `push.receipts`
 * job ~15 min after (`checkPushReceipts`). Without a sender (push off) it
 * does nothing.
 */
export async function deliverPush(deps: PushDeps, notificationId: string): Promise<{ sent: number; removed: number }> {
  const none = { sent: 0, removed: 0 };
  if (!deps.push) return none;
  const { db } = deps;
  const [row] = await db.select().from(notifications).where(eq(notifications.id, notificationId));
  if (!row || !pushWorthy(row, deps.now?.() ?? new Date())) return none;
  const devices = await listPushDevices(db, row.userId);
  if (devices.length === 0) return none;

  const source = row.source as NotificationSource;
  const latest = row.latest as NotificationLatest;
  const actor = row.actors[0];
  const name = await actorName(db, row.orgId, actor);
  let highRisk = false;
  if (row.kind === "approval" && source.approvalId) {
    const [approval] = await db
      .select({ tool: approvals.tool, scope: approvals.scope })
      .from(approvals)
      .where(and(eq(approvals.orgId, row.orgId), eq(approvals.id, source.approvalId)));
    highRisk = approval ? approvalIsHighRisk(approval) : true;
  }
  const data: Record<string, unknown> = { orgId: row.orgId, kind: row.kind, notificationId: row.id };
  for (const key of ["channelId", "threadId", "approvalId", "missionId", "handoffId"] as const) {
    if (source[key]) data[key] = source[key];
  }
  const messages: PushMessage[] = devices.map((d) => ({
    to: d.token,
    ...renderPush(pushLocale(d.locale), {
      kind: row.kind,
      waiting: row.waiting,
      actorName: name,
      actorType: actor?.type ?? null,
      label: source.label,
      title: latest.title,
      text: latest.text,
      highRisk,
      routine: latest.origin?.kind === "routine" ? latest.origin.routineName : null,
      screen: source.screen ?? null,
    }),
    data,
    priority: row.waiting ? "high" : "default",
  }));
  const results = await deps.push.send(messages);
  const gone = results.filter((r) => r.unregistered).map((r) => r.token);
  if (gone.length > 0) {
    await db.delete(pushDevices).where(and(eq(pushDevices.userId, row.userId), inArray(pushDevices.token, gone)));
  }
  const tickets = results.flatMap((r) => (r.ok && r.ticketId ? [{ id: r.ticketId, token: r.token }] : []));
  if (tickets.length > 0 && deps.push.receipts) {
    const now = deps.now?.() ?? new Date();
    await enqueue(db, {
      orgId: row.orgId,
      kind: "push.receipts",
      payload: { tickets },
      dedupeKey: `push.receipts:${row.id}`,
      runAt: new Date(now.getTime() + PUSH_RECEIPTS_DELAY_MS),
      maxAttempts: 4,
    });
  }
  return { sent: results.filter((r) => r.ok).length, removed: gone.length };
}

export interface PushTicket {
  id: string;
  token: string;
}

/** A job payload's tickets, keeping only well-formed ones. */
export function pushTicketsOf(value: unknown): PushTicket[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((t) =>
    t && typeof t === "object" && typeof t.id === "string" && typeof t.token === "string"
      ? [{ id: t.id, token: t.token }]
      : [],
  );
}

/**
 * Job `push.receipts`: asks the push service what happened to earlier
 * tickets and deletes the tokens whose device is gone
 * (`DeviceNotRegistered`), whoever holds them now. Tickets without a
 * receipt are left alone.
 */
export async function checkPushReceipts(
  deps: PushDeps,
  tickets: PushTicket[],
): Promise<{ checked: number; removed: number }> {
  if (!deps.push?.receipts || tickets.length === 0) return { checked: 0, removed: 0 };
  const receipts = await deps.push.receipts(tickets.map((t) => t.id));
  const tokenOf = new Map(tickets.map((t) => [t.id, t.token]));
  const gone = [
    ...new Set(
      receipts.flatMap((r) => (r.unregistered && tokenOf.has(r.ticketId) ? [tokenOf.get(r.ticketId) as string] : [])),
    ),
  ];
  if (gone.length === 0) return { checked: receipts.length, removed: 0 };
  const removed = await deps.db
    .delete(pushDevices)
    .where(inArray(pushDevices.token, gone))
    .returning({ id: pushDevices.id });
  return { checked: receipts.length, removed: removed.length };
}
