/**
 * The inbox's pure rules: which filter an item is
 * in, what is visible, how live events and my own actions change a loaded
 * page (and its counts), the day groups, where an item opens, how I answer
 * it, and the "Lembrar depois" times. No React, no i18n: the page turns these
 * into words.
 */
import type {
  AiStatus,
  AppNotification,
  NotificationCounts,
  NotificationFilter,
  NotificationKind,
  NotificationPage,
} from "../api/types";
import { billingHoldOf } from "./billing";

export const NOTIFICATION_FILTERS: NotificationFilter[] = ["all", "mentions", "waiting", "unread", "reactions"];

/** Kinds counted under "Menções": someone talks to me. */
const MENTION_KINDS: NotificationKind[] = ["mention", "dm", "agent_question"];

/**
 * Waiting ones in this order: an agent's secret request (it expires in minutes), an agent's question, my turn at the
 * table, an approval, then someone asking to join (nobody's work waits on it).
 */
const WAITING_ORDER: NotificationKind[] = [
  "secret_request",
  "agent_question",
  "forum_turn",
  "approval",
  "join_request",
];

export const isSnoozed = (n: Pick<AppNotification, "snoozedUntil">, now = Date.now()) =>
  !!n.snoozedUntil && new Date(n.snoozedUntil).getTime() > now;

/** In the inbox at all: not done and not snoozed. */
export const isVisible = (n: Pick<AppNotification, "doneAt" | "snoozedUntil">, now = Date.now()) =>
  !n.doneAt && !isSnoozed(n, now);

export function matchesFilter(n: AppNotification, filter: NotificationFilter, now = Date.now()) {
  if (!isVisible(n, now)) return false;
  switch (filter) {
    case "all":
      return true;
    case "mentions":
      return MENTION_KINDS.includes(n.kind);
    case "waiting":
      return n.waiting;
    case "unread":
      return n.readAt === null;
    case "reactions":
      return n.kind === "reaction";
  }
}

/** Server order: waiting first, then the most recently updated. */
export function compareNotifications(a: AppNotification, b: AppNotification) {
  if (a.waiting !== b.waiting) return a.waiting ? -1 : 1;
  return b.updatedAt.localeCompare(a.updatedAt);
}

/** The waiting section's order (question, forum, approval), the newest first within a kind. */
export function sortWaiting(list: AppNotification[]) {
  return [...list].sort(
    (a, b) => WAITING_ORDER.indexOf(a.kind) - WAITING_ORDER.indexOf(b.kind) || b.updatedAt.localeCompare(a.updatedAt),
  );
}

/** How the counts move when one item changes from `before` to `after` (either may be missing). */
export function countsDelta(
  counts: NotificationCounts,
  before: AppNotification | undefined,
  after: AppNotification | undefined,
  now = Date.now(),
): NotificationCounts {
  const next = { ...counts };
  for (const f of NOTIFICATION_FILTERS) {
    const was = before ? matchesFilter(before, f, now) : false;
    const is = after ? matchesFilter(after, f, now) : false;
    next[f] = Math.max(0, next[f] + (is ? 1 : 0) - (was ? 1 : 0));
  }
  return next;
}

/** The pages of one filter's list (React Query's infinite data). */
export interface NotificationPages {
  pages: NotificationPage[];
  pageParams: unknown[];
}

const findIn = (data: NotificationPages, id: string) => {
  for (const p of data.pages) {
    const hit = p.items.find((n) => n.id === id);
    if (hit) return hit;
  }
  return undefined;
};

/**
 * One item changed (a live event, or my own action): it leaves every page,
 * comes back in place on the first page when it still matches the filter,
 * and the counts move. `before` is the item as known anywhere (another
 * filter's list) when this list doesn't have it.
 */
export function upsertInPages(
  data: NotificationPages,
  filter: NotificationFilter,
  item: AppNotification,
  before?: AppNotification,
  now = Date.now(),
): NotificationPages {
  const old = findIn(data, item.id) ?? before;
  const [first, ...rest] = data.pages.map((p) => ({ ...p, items: p.items.filter((n) => n.id !== item.id) }));
  if (!first) return data;
  const items = matchesFilter(item, filter, now) ? [...first.items, item].sort(compareNotifications) : first.items;
  return {
    ...data,
    pages: [{ ...first, items, counts: countsDelta(first.counts, old, item, now) }, ...rest],
  };
}

/** Gone (auto-resolved): out of every page, and out of the counts. */
export function removeFromPages(
  data: NotificationPages,
  id: string,
  before?: AppNotification,
  now = Date.now(),
): NotificationPages {
  const old = findIn(data, id) ?? before;
  const pages = data.pages.map((p) => ({ ...p, items: p.items.filter((n) => n.id !== id) }));
  const [first, ...rest] = pages;
  if (!first) return data;
  return { ...data, pages: [{ ...first, counts: countsDelta(first.counts, old, undefined, now) }, ...rest] };
}

/** The server's numbers for the badge win over what we counted. */
export function withServerCounts(data: NotificationPages, unread: number, waiting: number): NotificationPages {
  const [first, ...rest] = data.pages;
  if (!first) return data;
  return { ...data, pages: [{ ...first, counts: { ...first.counts, unread, waiting } }, ...rest] };
}

export const allItems = (data: NotificationPages | undefined) => data?.pages.flatMap((p) => p.items) ?? [];

export type DayGroup = "today" | "yesterday" | "week" | "older";
export const DAY_GROUPS: DayGroup[] = ["today", "yesterday", "week", "older"];

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Hoje, Ontem, Esta semana (the last 7 days), Mais antigas: by the last update, in local time. */
export function dayGroupOf(iso: string, now = new Date()): DayGroup {
  const days = Math.round((startOfDay(now) - startOfDay(new Date(iso))) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return "week";
  return "older";
}

/** Not waiting, by day group, in order; empty groups left out. */
export function groupByDay(list: AppNotification[], now = new Date()): [DayGroup, AppNotification[]][] {
  const out = new Map<DayGroup, AppNotification[]>(DAY_GROUPS.map((g) => [g, []]));
  for (const n of [...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
    out.get(dayGroupOf(n.updatedAt, now))?.push(n);
  return [...out].filter(([, l]) => l.length > 0);
}

/** The DM's or message's channel. */
export const channelOf = (n: AppNotification) => n.source.channelId ?? n.source.dmId ?? null;

/**
 * Who asks to join in a request notice: the first people who asked, in that order (the notice's time is the first
 * one's), and how many asked in all. A notice from before it kept the names has the newest one's only.
 */
export const askersOf = (n: Pick<AppNotification, "count" | "latest">) => ({
  names: n.latest.names?.length ? n.latest.names : [n.latest.title ?? ""],
  total: n.count,
});

/**
 * What the workspace itself tells, with nobody behind it (its computer is ready, its standing changed, one of its
 * agents was held): its headline's key, the held agent's name as `name` (`source.label`); null for what someone did.
 */
export function workspaceHeadline(n: Pick<AppNotification, "kind" | "latest">) {
  if (n.kind === "computer_ready") return "computerSetup.notification.ready" as const;
  if (n.kind !== "org_standing") return null;
  const to = n.latest.statusTo;
  const billing = billingHoldOf({ state: "hold", reason: n.latest.billingHold ?? null });
  if (to === "hold" && billing) return `standing.notification.billing.${billing}` as const;
  return to === "suspended"
    ? ("standing.notification.suspended" as const)
    : to === "active"
      ? ("standing.notification.active" as const)
      : to === "agent_hold"
        ? ("standing.notification.agentHold" as const)
        : ("standing.notification.hold" as const);
}

/**
 * The restriction a notice of agentes.chat Cloud tells, as `restrictionLine` reads it: an agent held (its kind, as a
 * refused run carries it), or the workspace held or suspended with a reason (`latest.cloud`), so `review` reads as the
 * review line and an operator's reason with how to contest it. Null for any other notice, which keeps its own text.
 */
export function restrictionOf(n: Pick<AppNotification, "kind" | "latest">) {
  const l = n.latest;
  if (n.kind !== "org_standing") return null;
  if (l.statusTo === "agent_hold") return { code: "agent.paused", facts: { kind: l.holdKind, cloud: true } };
  if (!l.cloud || !l.text || (l.statusTo !== "hold" && l.statusTo !== "suspended")) return null;
  return { code: l.statusTo === "hold" ? "org.paused" : "org.suspended", facts: { reason: l.text, cloud: true } };
}

/** Grouped (several replies or comments): it expands to show them. */
export const isExpandable = (n: AppNotification) =>
  n.count > 1 &&
  ((n.kind === "thread_reply" && !!n.source.threadId && !!channelOf(n)) ||
    (n.kind === "issue_comment" && !!n.source.issueId));

/** How I answer from the inbox, if I can (through the endpoints that already exist). */
export type ReplyTarget =
  | { kind: "message"; channelId: string; threadId: string | null }
  | { kind: "issue"; issueId: string }
  | { kind: "question"; questionId: string }
  | { kind: "forum"; topicId: string };

export function replyTarget(n: AppNotification): ReplyTarget | null {
  const s = n.source;
  switch (n.kind) {
    case "agent_question":
      return s.questionId ? { kind: "question", questionId: s.questionId } : null;
    case "forum_turn":
      return s.topicId ? { kind: "forum", topicId: s.topicId } : null;
    case "issue_assigned":
    case "issue_comment":
      return s.issueId ? { kind: "issue", issueId: s.issueId } : null;
    case "mention":
    case "thread_reply":
    case "dm":
    case "agent_reply": {
      // A mention in an issue comment (its source may also carry the issue's channel).
      if (s.issueId) return { kind: "issue", issueId: s.issueId };
      const channelId = channelOf(n);
      return channelId ? { kind: "message", channelId, threadId: s.threadId ?? null } : null;
    }
    default:
      return null;
  }
}

/** Where "Abrir" goes (the app's routes). */
export type OpenTarget =
  | { to: "/org/$orgId/threads/$threadId"; params: { threadId: string } }
  | { to: "/org/$orgId/c/$channelId"; params: { channelId: string }; search?: { m: string } }
  | { to: "/org/$orgId/dm/agent/$agentId"; params: { agentId: string } }
  | { to: "/org/$orgId/dm/person/$userId"; params: { userId: string } }
  | { to: "/org/$orgId/issues/$number"; params: { number: string } }
  | { to: "/org/$orgId/forum/$topicId"; params: { topicId: string } }
  | { to: "/org/$orgId/approvals" }
  | { to: "/org/$orgId/routines"; search?: { open: string } }
  | { to: "/org/$orgId/threads"; search: { tab: "missions" } }
  | { to: "/org/$orgId/settings/computers/$machineId"; params: { machineId: string } }
  | { to: "/org/$orgId/settings/$section"; params: { section: "computers" | "members" } };

/** A routine's trouble (ADR 0053): it opens in Rotinas, where its state says what happened and how to fix it. */
export const ROUTINE_TROUBLE: ReadonlySet<NotificationKind> = new Set<NotificationKind>([
  "routine_failed",
  "routine_paused",
  "routine_stalled",
]);

/**
 * An agent that needs a person in its browser (ADR 0040) goes to its request card in the
 * conversation, like any message: the browser opens in that card (the page asks for it with
 * the notification's `handoffId`).
 */
export function openTarget(n: AppNotification): OpenTarget | null {
  const s = n.source;
  if (n.kind === "approval") return { to: "/org/$orgId/approvals" };
  // Requests to join are answered in Members (ADR 0068).
  if (n.kind === "join_request") return { to: "/org/$orgId/settings/$section", params: { section: "members" } };
  if (n.kind === "machine_connected" || n.kind === "computer_ready")
    return s.machineId
      ? { to: "/org/$orgId/settings/computers/$machineId", params: { machineId: s.machineId } }
      : { to: "/org/$orgId/settings/$section", params: { section: "computers" } };
  if (s.topicId) return { to: "/org/$orgId/forum/$topicId", params: { topicId: s.topicId } };
  if (s.issueNumber != null) return { to: "/org/$orgId/issues/$number", params: { number: String(s.issueNumber) } };
  // A routine that failed, paused or waits for its computer: the routine in Rotinas (its state and fix).
  // What a routine found opens the agent's message in its conversation (below); without one, the routine.
  if (ROUTINE_TROUBLE.has(n.kind) || (n.kind === "routine_finished" && !s.messageId && !s.threadId))
    return s.routineId ? { to: "/org/$orgId/routines", search: { open: s.routineId } } : { to: "/org/$orgId/routines" };
  // An agent's answer in its DM opens that DM, like a message there.
  if (n.kind === "agent_reply" && s.dmId && n.actors[0]?.type === "agent")
    return { to: "/org/$orgId/dm/agent/$agentId", params: { agentId: n.actors[0].id } };
  if (n.kind === "dm") {
    const who = n.actors[0];
    if (who?.type === "agent") return { to: "/org/$orgId/dm/agent/$agentId", params: { agentId: who.id } };
    if (who) return { to: "/org/$orgId/dm/person/$userId", params: { userId: who.id } };
  }
  if (s.threadId) return { to: "/org/$orgId/threads/$threadId", params: { threadId: s.threadId } };
  const channelId = channelOf(n);
  if (channelId)
    return {
      to: "/org/$orgId/c/$channelId",
      params: { channelId },
      ...(s.messageId ? { search: { m: s.messageId } } : {}),
    };
  if (s.missionId) return { to: "/org/$orgId/threads", search: { tab: "missions" } };
  return null;
}

/**
 * The workspace's computer is ready and its agents have no AI yet: opening it opens "Conectar uma IA" (the one
 * next step there is) instead of a page. `ai` unknown yet: the page.
 */
export const opensConnectAi = (
  n: Pick<AppNotification, "kind">,
  ai: Pick<AiStatus, "any" | "agents"> | undefined,
): boolean => n.kind === "computer_ready" && ai !== undefined && !ai.any && ai.agents.length > 0;

/** Mission and routine steps as strip cells: done, the one it stopped at, the rest to do. */
export function stepCells(steps: { done: number; total: number; failedAt?: number }) {
  const total = Math.max(0, Math.min(40, steps.total));
  // `failedAt` is 1-based; without it a stop is the first step not done.
  const stop = steps.failedAt != null ? steps.failedAt - 1 : null;
  return Array.from({ length: total }, (_, i) =>
    i === stop ? ("stopped" as const) : i < steps.done ? ("done" as const) : ("todo" as const),
  );
}

/** "Lembrar depois": in 1 hour, tomorrow at 9, next Monday at 9 (the person's local time). */
export function snoozeTimes(now = new Date()) {
  const hour = new Date(now.getTime() + 3_600_000);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0);
  // Next week's Monday (from a Monday, the one after).
  const toMonday = ((8 - now.getDay()) % 7 || 7) as number;
  const nextWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + toMonday, 9, 0, 0, 0);
  return { hour, tomorrow, nextWeek };
}

/** `@handle` tokens in a snippet (the page highlights mine). */
export const MENTION_RE = /(@[\p{L}\p{N}_.-]*[\p{L}\p{N}_])/u;
