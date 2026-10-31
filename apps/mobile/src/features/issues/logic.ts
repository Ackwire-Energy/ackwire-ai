import type { Issue, IssueColumn, IssueStatus, IssueWork } from "@agenteschat/client";
import { toYmd } from "@agenteschat/client/lib/format";
import { isOpen, STATUSES } from "@agenteschat/client/lib/issues";
import { foldSteps, stepPhrase } from "@agenteschat/client/lib/work";
import type { TFunction } from "i18next";

/**
 * Tasks ("Tarefas", internally issues) on the phone: the list by stage
 * and board column, its filters and counts, the row's state line, the column picker, and the new task's due
 * date choices. The status follows the web's rules: nobody marks an issue
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

/**
 * The state a row in the list still says. The list is grouped by status, so "A fazer", "Em andamento",
 * "Em revisão", "Feita" and "Cancelada" are already its section; only what happens inside one shows
 * (working, waiting on you, stalled, a PR in review).
 */
export function listState(i: Pick<Issue, "status" | "work" | "pullRequests">): IssueState | null {
  const state = issueState(i);
  if (state === "running" || state === "waiting" || state === "stalled") return state;
  if (state === "review" && latestPr(i)) return state;
  return null;
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

/** The counts on the "Abertas" and "Com você" chips (the others show none, as designed). */
export function filterCounts(list: Pick<Issue, "status" | "work" | "assignee">[], meId: string | null) {
  return {
    open: list.filter((i) => passesFilter(i, "open", meId)).length,
    mine: list.filter((i) => passesFilter(i, "mine", meId)).length,
  };
}

/** The list's stages: what is moving first, then what waits to start; closed ones under "Concluídas". */
const OPEN_STAGES: IssueStatus[] = ["in_progress", "in_review", "todo"];
const CLOSED_STAGES: IssueStatus[] = ["done", "canceled"];

/** A column's tasks inside a stage; `column` null when the board's columns aren't known yet. */
export interface IssueColumnGroup<T> {
  key: string;
  column: IssueColumn | null;
  items: T[];
}

export interface IssueSection<T> {
  /** The stage (the issue status). */
  key: IssueStatus;
  count: number;
  /** Show each column's name: the stage has more than one column, or a named one. */
  showColumns: boolean;
  groups: IssueColumnGroup<T>[];
}

/** The stage's columns, in board order. */
export const stageColumns = (columns: IssueColumn[], stage: IssueStatus) => columns.filter((c) => c.stage === stage);

/** The board is customized in this stage: more than one column, or a column with its own name. */
export const stageCustomized = (columns: IssueColumn[]) => columns.length > 1 || columns.some((c) => c.name !== null);

/** The column an issue sits in: its own when it belongs to its stage, else the stage's first. */
export function columnOfIssue(i: Pick<Issue, "columnId" | "status">, columns: IssueColumn[]): IssueColumn | null {
  const own = i.columnId ? columns.find((c) => c.id === i.columnId && c.stage === i.status) : undefined;
  return own ?? columns.find((c) => c.stage === i.status) ?? null;
}

/** Inside a column: the board's order (lowest rank first), then the newest number. */
const byBoard = (a: Issue, b: Issue) => a.boardRank - b.boardRank || b.number - a.number;

/**
 * The list's sections, one per stage (Em andamento, Em revisão, A fazer; Feitas and Canceladas under the
 * "Concluídas" filter), and inside each stage its columns in board order, each in the board's order.
 * Column names show only where the board is customized. Empty stages and columns are left out.
 */
export function issueSections(
  list: Issue[],
  filter: IssueFilter,
  meId: string | null,
  columns: IssueColumn[] = [],
): IssueSection<Issue>[] {
  const shown = list.filter((i) => passesFilter(i, filter, meId));
  const out: IssueSection<Issue>[] = [];
  for (const stage of filter === "done" ? CLOSED_STAGES : OPEN_STAGES) {
    const items = shown.filter((i) => i.status === stage);
    if (items.length === 0) continue;
    const cols = stageColumns(columns, stage);
    const byColumn = new Map<string | null, Issue[]>();
    for (const i of items) {
      const id = columnOfIssue(i, cols)?.id ?? null;
      byColumn.set(id, [...(byColumn.get(id) ?? []), i]);
    }
    const groups: IssueColumnGroup<Issue>[] = [];
    const loose = byColumn.get(null);
    if (loose) groups.push({ key: `${stage}:none`, column: null, items: loose.sort(byBoard) });
    for (const c of cols) {
      const inColumn = byColumn.get(c.id);
      if (inColumn) groups.push({ key: c.id, column: c, items: inColumn.sort(byBoard) });
    }
    out.push({ key: stage, count: items.length, showColumns: stageCustomized(cols), groups });
  }
  return out;
}

/** The column picker: the stages in board order, each with its columns (stages without columns left out). */
export function columnChoices(columns: IssueColumn[]): { stage: IssueStatus; columns: IssueColumn[] }[] {
  return STATUSES.map((stage) => ({ stage, columns: stageColumns(columns, stage) })).filter((s) => s.columns.length);
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

/**
 * The work card's steps as its lines: the same words in a row once, with how many ("Rodou: npm test ×3") and the
 * last one's time. The last line is the step the agent is on while the run works (`going`), and reads as going on
 * ("…") unless its command was refused or waits on a person.
 */
export function workLines(t: TFunction, steps: IssueWork["steps"], running: boolean) {
  const lines = foldSteps(steps, (s) => stepPhrase(t, s));
  return lines.map(({ step, text, count }, k) => {
    const last = k === lines.length - 1;
    const going = last && running;
    const dots = going && !step.outcome ? "…" : "";
    const times = count > 1 ? ` ${t("chat.work.times", { count })}` : "";
    return { key: `${step.at}-${step.tool}-${k}`, step, text: `${text}${dots}${times}`, last, going };
  });
}

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
