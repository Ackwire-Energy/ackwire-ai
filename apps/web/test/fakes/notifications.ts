/**
 * Test fake — the inbox (contract: `/notifications`, telas/Notificacoes.html):
 * the list per filter with every filter's count, the badge count, read /
 * done / snooze, and "Marcar tudo como lido". Same rules as the contract:
 * done and snoozed ones are hidden, waiting ones first, then the newest.
 */
import type { ApiClient } from "@/api/client";
import type { AppNotification, NotificationCounts, NotificationFilter } from "@/api/types";
import { compareNotifications, matchesFilter, NOTIFICATION_FILTERS } from "@/lib/notifications";
import { MockNotFoundError } from "./context";

export interface FakeInbox {
  items: AppNotification[];
}

const counts = (items: AppNotification[], now: number): NotificationCounts =>
  Object.fromEntries(
    NOTIFICATION_FILTERS.map((f) => [f, items.filter((n) => matchesFilter(n, f, now)).length]),
  ) as NotificationCounts;

/** One notification with the defaults filled in (tests set what matters). */
export function notification(over: Partial<AppNotification> & Pick<AppNotification, "id" | "kind">): AppNotification {
  const at = over.updatedAt ?? new Date().toISOString();
  return {
    waiting: false,
    actors: [],
    count: 1,
    source: {},
    latest: {},
    readAt: null,
    doneAt: null,
    snoozedUntil: null,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

export function createFakeNotifications(
  inbox: FakeInbox,
  log: (method: string, ...args: unknown[]) => void,
): ApiClient["notifications"] {
  const find = (id: string) => {
    const n = inbox.items.find((x) => x.id === id);
    if (!n) throw new MockNotFoundError("Notification not found");
    return n;
  };
  return {
    list: async (orgId, query = {}) => {
      log("notifications.list", orgId, query);
      const now = Date.now();
      const filter: NotificationFilter = query.filter ?? "all";
      const shown = inbox.items.filter((n) => matchesFilter(n, filter, now)).sort(compareNotifications);
      const start = query.cursor ? Number(query.cursor) : 0;
      const limit = query.limit ?? 50;
      const page = shown.slice(start, start + limit);
      return {
        items: structuredClone(page),
        counts: counts(inbox.items, now),
        nextCursor: start + limit < shown.length ? String(start + limit) : null,
      };
    },
    count: async (orgId) => {
      log("notifications.count", orgId);
      const c = counts(inbox.items, Date.now());
      return { unread: c.unread, waiting: c.waiting };
    },
    read: async (orgId, id, read) => {
      log("notifications.read", orgId, id, read);
      const n = find(id);
      n.readAt = read ? (n.readAt ?? new Date().toISOString()) : null;
      return structuredClone(n);
    },
    done: async (orgId, id, done) => {
      log("notifications.done", orgId, id, done);
      const n = find(id);
      n.doneAt = done ? new Date().toISOString() : null;
      if (done) n.readAt ??= new Date().toISOString();
      return structuredClone(n);
    },
    snooze: async (orgId, id, until) => {
      log("notifications.snooze", orgId, id, until);
      const n = find(id);
      n.snoozedUntil = until;
      return structuredClone(n);
    },
    readAll: async (orgId, filter) => {
      log("notifications.readAll", orgId, filter);
      const now = Date.now();
      const ids: string[] = [];
      for (const n of inbox.items)
        if (n.readAt === null && matchesFilter(n, filter ?? "all", now)) {
          n.readAt = new Date().toISOString();
          ids.push(n.id);
        }
      return { ids };
    },
  };
}
