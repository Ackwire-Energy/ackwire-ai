import type { TFunction } from "i18next";
import type { EndedTask, ManagedTask, TaskNow } from "../api/types";
import { type Activity, toolActivity } from "./activity";

/**
 * The task manager, the same on every app (ADR 0128): the web's page, the phone's list and the chat's strip read
 * these. Tasks are grouped by agent; a routine's background run goes to its own section; what a task uses now comes
 * from its latest tool call, the way the chat's live chip says it.
 */

export type TaskState = "working" | "waiting" | "queued";

/** Working, waiting on a person (an ok, an answer), or not started yet. */
export const taskState = (t: Pick<ManagedTask, "status">): TaskState =>
  t.status === "running" ? "working" : t.status === "queued" ? "queued" : "waiting";

/**
 * What the waiting is for: your ok (an approval), an answer, or no person: its computer (full or away), its plan's
 * limit, the budget (`held`).
 */
export type WaitReason = "ok" | "answer" | "computer_busy" | "computer_offline" | "plan" | "budget";

export const waitsFor = (t: Pick<ManagedTask, "status" | "held">): WaitReason | null =>
  t.status === "waiting_approval" ? "ok" : t.status === "waiting_input" ? (t.held ?? "answer") : null;

/** A wait on a person (your ok, an answer): "espera você". The others wait on a computer, a plan or a budget. */
export const waitsOnPerson = (t: Pick<ManagedTask, "status" | "held">) => {
  const w = waitsFor(t);
  return w === "ok" || w === "answer";
};

/**
 * A task waiting for room on its computer, with its place in the line ("Na fila · 2º"); null for any other state.
 * People's turns go first, then the longest wait (ADR 0032 "Calm waits").
 */
export const linePlace = (t: Pick<ManagedTask, "held" | "line">) =>
  t.held === "computer_busy" && t.line ? t.line : null;

/** The words of a wait (`taskManager.state.*`). */
export const waitKey = (w: WaitReason) =>
  w === "ok"
    ? "taskManager.state.ok"
    : w === "answer"
      ? "taskManager.state.answer"
      : w === "computer_busy"
        ? "taskManager.state.computerBusy"
        : w === "computer_offline"
          ? "taskManager.state.computerOffline"
          : w === "plan"
            ? "taskManager.state.plan"
            : "taskManager.state.budget";

/** Since when it counts (a long work's start, else the run's), in ms. */
export const taskSince = (t: Pick<ManagedTask, "startedAt" | "createdAt">) => Date.parse(t.startedAt ?? t.createdAt);

/** "6:12", "1:02:10": the clock of a task, like a process's time. */
export function taskClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/**
 * What a task uses right now ("Usando agora"):
 * - `brain`: a computer brain's turn (Claude Code, Codex, Cursor); `inner` is what it called last through us, if any;
 * - `browser`, `screen`: the agent's own browser or desktop;
 * - `terminal`: code or a command on its computer;
 * - `app`: a connector, a mailbox, a database (`activity.service` names its logo, `activity.app` its name);
 * - `agentes`: one of our own tools (an issue, the Drive, memory…);
 * - `none`: nothing yet (queued, or only thinking).
 */
export type TaskProgram =
  | { kind: "brain"; brain: "claude_code" | "codex" | "cursor"; inner: TaskProgram | null; detail: string | null }
  | { kind: "browser" | "screen" | "terminal" | "agentes"; activity: Activity; detail: string | null }
  | { kind: "app"; activity: Activity; detail: string | null }
  | { kind: "none" };

const COMPUTER_BRAINS = new Set(["claude_code", "codex", "cursor"]);

function programOf(now: TaskNow | null): TaskProgram | null {
  if (!now) return null;
  const activity = toolActivity(now.tool, now.connector, now.detail, now);
  const detail = now.detail;
  switch (activity.kind) {
    case "browsing":
      return { kind: "browser", activity, detail };
    case "usingScreen":
      return { kind: "screen", activity, detail };
    case "runningCode":
    case "runningCommand":
    case "runningCommandAny":
    case "runningSkillScript":
    case "runningSkillScriptAny":
    case "cloningRepo":
    case "pcFiles":
      return { kind: "terminal", activity, detail };
    case "consulting":
    case "queryingDatabase":
      return { kind: "app", activity, detail };
    default:
      return activity.service ? { kind: "app", activity, detail } : { kind: "agentes", activity, detail };
  }
}

export function taskProgram(t: Pick<ManagedTask, "brain" | "now" | "status">): TaskProgram {
  if (t.status === "queued") return { kind: "none" };
  const inner = programOf(t.now);
  if (t.brain && COMPUTER_BRAINS.has(t.brain)) {
    const brain = t.brain as "claude_code" | "codex" | "cursor";
    return { kind: "brain", brain, inner, detail: t.now?.detail ?? null };
  }
  return inner ?? { kind: "none" };
}

/** A stable key for a program, to show each app once on an agent's row (`claude_code`, `browser`, `app:github`). */
export function programKey(p: TaskProgram): string | null {
  switch (p.kind) {
    case "none":
      return null;
    case "brain":
      return p.brain;
    case "app":
      return `app:${p.activity.service ?? p.activity.app ?? ""}`;
    default:
      return p.kind;
  }
}

/** What a task is about, for its row: its label, else where it is ("Conversa com Ana", "#produto"). */
export function taskTitle(t: TFunction, task: Pick<ManagedTask, "label" | "routine" | "channelKind" | "channelName">) {
  if (task.label?.trim()) return task.label.trim();
  if (task.routine?.name) return task.routine.name;
  return taskWhere(t, task);
}

/** Where it is: "#produto", "Conversa direta", "Rotina «Backups»". */
export function taskWhere(
  t: TFunction,
  task: Pick<ManagedTask, "routine" | "channelKind" | "channelName"> & { background?: boolean },
) {
  if (task.background) {
    return task.routine?.name
      ? t("taskManager.where.routine", { name: task.routine.name })
      : t("taskManager.where.background");
  }
  if (task.channelKind === "dm") return t("taskManager.where.dm");
  return `#${task.channelName ?? ""}`;
}

export interface AgentTasks {
  agentId: string;
  tasks: ManagedTask[];
  working: number;
  waiting: number;
  /** Tasks it can stop now (not already stopping on this screen). */
  stoppable: string[];
}

/**
 * The task manager's sections: tasks people asked for, grouped by agent (agents with someone waiting on them or
 * working first, then by their oldest task), and the routines' background runs.
 */
export function groupTasks(tasks: ManagedTask[], stopping: ReadonlySet<string> = new Set()) {
  const asked = tasks.filter((t) => !t.background);
  const background = tasks.filter((t) => t.background);
  const byAgent = new Map<string, ManagedTask[]>();
  for (const task of asked) byAgent.set(task.agentId, [...(byAgent.get(task.agentId) ?? []), task]);
  const groups: AgentTasks[] = [...byAgent].map(([agentId, list]) => {
    const sorted = [...list].sort((a, b) => taskSince(a) - taskSince(b));
    return {
      agentId,
      tasks: sorted,
      working: sorted.filter((t) => taskState(t) === "working").length,
      waiting: sorted.filter((t) => waitsOnPerson(t)).length,
      stoppable: sorted.filter((t) => t.canStop && !stopping.has(t.runId)).map((t) => t.runId),
    };
  });
  groups.sort((a, b) => taskSince(a.tasks[0] as ManagedTask) - taskSince(b.tasks[0] as ManagedTask));
  return { groups, background: [...background].sort((a, b) => taskSince(a) - taskSince(b)) };
}

/** An agent's tasks (its card, the chat's strip): people's first, then its routines', oldest first. */
export const tasksOf = (tasks: ManagedTask[], agentId: string) =>
  tasks
    .filter((t) => t.agentId === agentId)
    .sort((a, b) => Number(a.background) - Number(b.background) || taskSince(a) - taskSince(b));

/** The cards' summary: how many tasks and how many wait on a person. */
export function agentSummary(tasks: ManagedTask[]) {
  return {
    tasks: tasks.length,
    working: tasks.filter((t) => taskState(t) === "working").length,
    waiting: tasks.filter((t) => waitsOnPerson(t)).length,
  };
}

/** The last `points` minutes of an agent's activity (zeros when it did nothing). */
export function activityLine(activity: Record<string, number[]>, agentId: string | null, points = 30): number[] {
  const lines = agentId ? [activity[agentId] ?? []] : Object.values(activity);
  const out = Array.from({ length: points }, () => 0);
  for (const line of lines) {
    const tail = line.slice(-points);
    const offset = points - tail.length;
    tail.forEach((n, i) => {
      out[offset + i] = (out[offset + i] ?? 0) + n;
    });
  }
  return out;
}

/** How a task ended, for "Terminadas hoje": done, stopped (by whom) or couldn't. */
export const endedState = (e: Pick<EndedTask, "status">): "done" | "stopped" | "failed" =>
  e.status === "done" ? "done" : e.status === "canceled" ? "stopped" : "failed";

/** Since when "Terminadas hoje" counts: the local midnight. */
export function todayStart(now = new Date()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}
