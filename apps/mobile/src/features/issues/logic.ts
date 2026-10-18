import type { Issue, IssueWork } from "@agenteschat/client";
import { toYmd } from "@agenteschat/client/lib/format";
import { isOpen } from "@agenteschat/client/lib/issues";

/**
 * Issues on the phone (MobileDriveIssues.html): the list by state, its filters and counts, the row's state
 * line, and the new issue's due date choices. The status follows the web's rules: nobody marks an issue
 * "committed"; it moves by itself (in progress when an agent starts, in review when it links a PR),
 * "trabalhando" comes from the agent's live run, and in progress with no run alive is stalled.
 */

/** What a row shows as its state (the chip). */
export type IssueState = "running" | "waiting" | "stalled" | "review" | "progress" | "todo" | "done" | "canceled";

export function issueState(i: Pick<Issue, "status" | "work">): IssueState {
  if (i.status === "done") return "done";
  if (i.status === "canceled") return "canceled";
  const w = i.work;
  if (w?.state === "running") return "running";
  if (w?.state === "waiting_approval" || w?.state === "waiting_input") return "waiting";
  if (w?.state === "stalled") return "stalled";
  if (i.status === "in_review") return "review";
  if (i.status === "in_progress") return "progress";
  return "todo";
}

/** The agent on it waits on a person (an approval, an answer): the dark strip on top and "Com você". */
export const waitsOnYou = (i: Pick<Issue, "status" | "work">) => issueState(i) === "waiting";

export type IssueFilter = "open" | "mine" | "agents" | "done";
export const ISSUE_FILTERS: IssueFilter[] = ["open", "mine", "agents", "done"];

export function passesFilter(
  i: Pick<Issue, "status" | "work" | "assignee">,
  filter: IssueFilter,
  meId: string | null,
): boolean {
  switch (filter) {
    case "open":
      return isOpen(i);
    case "mine":
      return isOpen(i) && ((i.assignee?.type === "person" && meId !== null && i.assignee.id === meId) || waitsOnYou(i));
    case "agents":
      return isOpen(i) && i.assignee?.type === "agent";
    case "done":
      return !isOpen(i);
  }
}

/** The counts on the "Abertas" and "Com você" chips (the others show none, as in the prototype). */
export function filterCounts(list: Pick<Issue, "status" | "work" | "assignee">[], meId: string | null) {
  return {
    open: list.filter((i) => passesFilter(i, "open", meId)).length,
    mine: list.filter((i) => passesFilter(i, "mine", meId)).length,
  };
}

export type IssueSectionKey = "working" | "review" | "todo" | "done";

export interface IssueSection<T> {
  key: IssueSectionKey;
  items: T[];
}

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 } as const;

/** Waiting on you first, then high priority, the nearest due date, the newest number. */
function byUrgency(a: Issue, b: Issue) {
  return (
    Number(waitsOnYou(b)) - Number(waitsOnYou(a)) ||
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
    (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999") ||
    b.number - a.number
  );
}

/**
 * The list's sections: "Trabalhando agora" (a live run), "Em revisão" (a PR open), "A fazer" (the rest that
 * is open: waiting on you first, stalled, in progress by a person, to do). Closed issues ("Concluídas")
 * come newest first in one section. Empty sections are left out.
 */
export function issueSections(list: Issue[], filter: IssueFilter, meId: string | null): IssueSection<Issue>[] {
  const shown = list.filter((i) => passesFilter(i, filter, meId));
  if (filter === "done")
    return shown.length
      ? [{ key: "done", items: [...shown].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }]
      : [];
  const working: Issue[] = [];
  const review: Issue[] = [];
  const todo: Issue[] = [];
  for (const i of shown) {
    const s = issueState(i);
    if (s === "running") working.push(i);
    else if (s === "review") review.push(i);
    else todo.push(i);
  }
  const out: IssueSection<Issue>[] = [
    { key: "working", items: working.sort(byUrgency) },
    { key: "review", items: review.sort(byUrgency) },
    { key: "todo", items: todo.sort(byUrgency) },
  ];
  return out.filter((s) => s.items.length > 0);
}

/** Criteria checked and in all ("2/4"); null without criteria. */
export function criteriaProgress(i: Pick<Issue, "criteria">): { done: number; total: number } | null {
  if (i.criteria.length === 0) return null;
  return { done: i.criteria.filter((c) => c.done).length, total: i.criteria.length };
}

/** The last PR linked (in review shows "PR #212"). */
export const latestPr = (i: Pick<Issue, "pullRequests">) => i.pullRequests.at(-1) ?? null;

/** The step the agent is on now (its last tool call), only while it works. */
export const currentStep = (w: Pick<IssueWork, "steps" | "state"> | null | undefined) =>
  w && w.state !== "stalled" ? (w.steps.at(-1) ?? null) : null;

/** Whole minutes since the run started ("trabalhando há 6 min"), at least 0. */
export const minutesSince = (iso: string, now = Date.now()) =>
  Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));

/** Late: the due date passed while the issue is open. */
export const isLate = (i: Pick<Issue, "dueDate" | "status">, now = new Date()) =>
  Boolean(i.dueDate && isOpen(i) && i.dueDate < toYmd(now));

/** "Prazo" in the new issue sheet: simple choices (no date picker in the app). */
export type DueChoice = "none" | "today" | "tomorrow" | "friday" | "nextWeek";
export const DUE_CHOICES: DueChoice[] = ["none", "today", "tomorrow", "friday", "nextWeek"];

/** The day a choice means, `YYYY-MM-DD` (null for none). "Sexta" is this week's, or next week's from Friday on. */
export function dueDateOf(choice: DueChoice, now = new Date()): string | null {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  switch (choice) {
    case "none":
      return null;
    case "today":
      break;
    case "tomorrow":
      d.setDate(d.getDate() + 1);
      break;
    case "friday": {
      const ahead = (5 - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + ahead);
      break;
    }
    case "nextWeek":
      d.setDate(d.getDate() + 7);
      break;
  }
  return toYmd(d);
}

/** Where "Conversar" goes: the issue's channel, else a direct conversation with the agent on it. */
export function conversationOf(
  i: Pick<Issue, "channelId" | "source" | "assignee">,
): { channelId: string } | { agentId: string } | null {
  const channelId = i.channelId ?? (i.source.type === "message" ? i.source.channelId : null);
  if (channelId) return { channelId };
  if (i.assignee?.type === "agent") return { agentId: i.assignee.id };
  return null;
}

/** The issue number from a route param ("134"); null when it isn't one. */
export function issueNumberOf(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}
