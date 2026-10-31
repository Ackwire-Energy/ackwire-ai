import type { AppNotification, NotificationActor, Routine } from "@agenteschat/client";
import { approvalOriginWords } from "@agenteschat/client/lib/approval-origin";
import { namesText } from "@agenteschat/client/lib/format";
import { askersOf } from "@agenteschat/client/lib/notifications";
import { routineNotificationWords, type Words } from "@agenteschat/client/lib/routine-view";
import type { TFunction } from "i18next";
import { daysAgo } from "../shared/logic";

/**
 * Atividade: what waits on you on top, then the rest by day. Grouped
 * items (replies of a thread, reactions to a message) are one card that
 * says who and how many.
 */

export type ActivityFilter = "all" | "waiting";

/**
 * Waiting ones in this order: an agent stuck in its browser (it expires in minutes), an agent's question, my
 * turn at the table, an approval, then someone asking to join (nobody's work waits on it); newest first within a
 * kind.
 */
const WAITING_ORDER: string[] = ["browser_handoff", "agent_question", "forum_turn", "approval", "join_request"];

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

/** Says coded words (an i18n key and its values) in the person's language; `otherwise` for an unknown key. */
export type SayWords = (w: Words, otherwise?: string) => string;

/**
 * The line under the title: the snippet, the quote of a reaction, or the request's title. Coded words are
 * said in the person's language (`say`): why a routine paused or failed (its `latest.reason`, never the
 * server's English), and who asked for an approval while nobody watched, leading its title.
 */
export function subtitleOf(n: AppNotification, say: SayWords): string {
  const l = n.latest;
  if (n.kind === "reaction") return l.quote ?? "";
  const reason = routineNotificationWords(n);
  if (reason) return say(reason, l.text ?? "");
  if (n.kind === "approval") {
    const origin = approvalOriginWords({ origin: l.origin });
    return [origin ? say(origin) : "", l.title ?? l.text ?? ""].filter(Boolean).join(" · ");
  }
  if (n.kind === "issue_assigned" || n.kind === "forum_turn") return l.title ?? l.text ?? "";
  return l.text ?? l.title ?? "";
}

/** Where it happened ("#produto", the thread's title, the mission's name). */
export const placeOf = (n: AppNotification) => n.source.label ?? "";

/** Emojis a reaction card shows (at most 5, from the server). */
export const emojisOf = (n: AppNotification) => (n.kind === "reaction" ? (n.latest.emojis ?? []).slice(0, 5) : []);

// ── Esperando você as cards, and what comes next ─────────────────────────────────────────────────

/**
 * What a waiting item asks of you: approve, answer an agent, take your turn at the table, help in a browser, or let
 * someone in.
 */
export type WaitingCardKind = "approval" | "question" | "forum" | "browser" | "join";

export interface WaitingCard {
  kind: WaitingCardKind;
  /** The exact request: the action to approve, the question, the topic, what to do in the browser, who asks to join. */
  title: string;
  /** Only requests expire. */
  expiresAt: string | null;
  /** The one button: "Revisar" (a request), "Responder" or "Abrir" (the agent's browser). */
  action: "review" | "answer" | "open";
}

/** A waiting inbox item as a card: who asks (`actors`), the kind, the exact request, the deadline, one button. */
export function waitingCardOf(n: Pick<AppNotification, "kind" | "count" | "latest">): WaitingCard {
  const l = n.latest;
  if (n.kind === "browser_handoff")
    return { kind: "browser", title: l.text ?? l.title ?? "", expiresAt: l.expiresAt ?? null, action: "open" };
  if (n.kind === "approval")
    return { kind: "approval", title: l.title ?? l.text ?? "", expiresAt: l.expiresAt ?? null, action: "review" };
  if (n.kind === "forum_turn")
    return { kind: "forum", title: l.title ?? l.text ?? "", expiresAt: null, action: "answer" };
  // No actor (they aren't a member yet): the first who asked is the title; `joinRequestLine` says them all.
  if (n.kind === "join_request")
    return { kind: "join", title: askersOf(n).names[0] ?? "", expiresAt: null, action: "review" };
  return { kind: "question", title: l.text ?? l.title ?? "", expiresAt: null, action: "answer" };
}

/**
 * Who asks to join, as the card's line: "Ana asks to join", "Ana and Bruno ask to join", "Ana, Bruno and 2 more ask
 * to join"; and the faces to lead it (the names shown, as they aren't members yet: their initials).
 */
export function joinRequestLine(
  t: TFunction,
  n: Pick<AppNotification, "count" | "latest">,
): { text: string; faces: string[] } {
  const asked = askersOf(n);
  const text =
    asked.total > 1
      ? t("notifications.wait.joinRequestNames", { names: namesText(t, asked.names, 2, asked.total) })
      : t("notifications.wait.joinRequest", { count: 1, name: asked.names[0] });
  return { text, faces: asked.names.slice(0, 2) };
}

/** The next real thing coming: the soonest run of an active routine, still ahead. */
export function nextRoutine<T extends Pick<Routine, "active" | "nextRunAt">>(routines: readonly T[], now = Date.now()) {
  let next: T | null = null;
  for (const r of routines) {
    if (!r.active || !r.nextRunAt) continue;
    const at = new Date(r.nextRunAt).getTime();
    if (!(at > now)) continue;
    if (!next || at < new Date(next.nextRunAt as string).getTime()) next = r;
  }
  return next;
}

/** How "when" is said for the next event: today, tomorrow, or a later day. */
export function upcomingDay(iso: string, now = new Date()): "today" | "tomorrow" | "later" {
  const days = -daysAgo(iso, now);
  if (days <= 0) return "today";
  return days === 1 ? "tomorrow" : "later";
}
