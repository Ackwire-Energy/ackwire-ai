import type { AppNotification, NotificationActor } from "@agenteschat/client";
import { daysAgo } from "../shared/logic";

/**
 * Atividade (D46): what waits on you on top, then the rest by day. Grouped
 * items (replies of a thread, reactions to a message) are one card that
 * says who and how many.
 */

export type ActivityFilter = "all" | "waiting";

/** Waiting ones in this order: an agent's question, my turn at the table, an approval; newest first within a kind. */
const WAITING_ORDER: AppNotification["kind"][] = ["agent_question", "forum_turn", "approval"];

export const isVisible = (n: Pick<AppNotification, "doneAt" | "snoozedUntil">, now = Date.now()) =>
  !n.doneAt && !(n.snoozedUntil && new Date(n.snoozedUntil).getTime() > now);

export function sortWaiting(list: AppNotification[]) {
  return [...list].sort(
    (a, b) => WAITING_ORDER.indexOf(a.kind) - WAITING_ORDER.indexOf(b.kind) || b.updatedAt.localeCompare(a.updatedAt),
  );
}

export type DayGroup = "today" | "yesterday" | "week" | "older";
const DAY_GROUPS: DayGroup[] = ["today", "yesterday", "week", "older"];

export function dayGroupOf(iso: string, now = new Date()): DayGroup {
  const days = daysAgo(iso, now);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  return "older";
}

/** The screen's sections: waiting first, then the rest by day (empty groups left out). */
export function activitySections(
  items: AppNotification[],
  filter: ActivityFilter,
  now = new Date(),
): { waiting: AppNotification[]; days: [DayGroup, AppNotification[]][] } {
  const visible = items.filter((n) => isVisible(n, now.getTime()));
  const waiting = sortWaiting(visible.filter((n) => n.waiting));
  if (filter === "waiting") return { waiting, days: [] };
  const groups = new Map<DayGroup, AppNotification[]>(DAY_GROUPS.map((g) => [g, []]));
  for (const n of visible.filter((x) => !x.waiting).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
    groups.get(dayGroupOf(n.updatedAt, now))?.push(n);
  }
  return { waiting, days: [...groups].filter(([, l]) => l.length > 0) };
}

/** Who did it, said short: the first one or two names and how many more. */
export interface Who {
  first: string;
  second: string | null;
  more: number;
  /** People and agents behind it (the verb's number). */
  total: number;
}

export function whoOf(actors: NotificationActor[], nameOf: (a: NotificationActor) => string): Who {
  const names = actors.map(nameOf).filter((n, i, all) => n !== "" && all.indexOf(n) === i);
  const first = names[0] ?? "";
  const second = names[1] ?? null;
  const shown = second ? 2 : first ? 1 : 0;
  return { first, second, more: Math.max(0, names.length - shown), total: Math.max(1, names.length) };
}

/** The line under the title: the snippet, the quote of a reaction, or the request's title. */
export function subtitleOf(n: AppNotification): string {
  const l = n.latest;
  if (n.kind === "reaction") return l.quote ?? "";
  if (n.kind === "approval" || n.kind === "issue_assigned" || n.kind === "forum_turn") return l.title ?? l.text ?? "";
  return l.text ?? l.title ?? "";
}

/** Where it happened ("#produto", the thread's title, the mission's name). */
export const placeOf = (n: AppNotification) => n.source.label ?? "";

/** Emojis a reaction card shows (at most 5, from the server). */
export const emojisOf = (n: AppNotification) => (n.kind === "reaction" ? (n.latest.emojis ?? []).slice(0, 5) : []);
