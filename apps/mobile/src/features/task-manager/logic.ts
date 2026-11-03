import type { ComputerSummary, EndedTask, ManagedTask } from "@agenteschat/client";
import { type Activity, activityVerb } from "@agenteschat/client/lib/activity";
import { etaMinutes } from "@agenteschat/client/lib/computer-queue";
import { capitalize } from "@agenteschat/client/lib/format";
import { brainName } from "@agenteschat/client/lib/outages";
import {
  type AgentTasks,
  endedState,
  linePlace,
  type TaskProgram,
  taskState,
  tasksOf,
  taskWhere,
  waitsFor,
  waitsOnPerson,
} from "@agenteschat/client/lib/task-manager";
import type { TFunction } from "i18next";

/**
 * What the phone's task manager says (ADR 0128): its list, a task's screen, an agent's tasks screen and the count in
 * its DM's header, from the shared model (`@agenteschat/client/lib/task-manager`).
 */

/** A conversation: a channel's (or a DM's) main timeline, or one of its threads. */
export interface Place {
  channelId: string;
  threadId: string | null;
}

/** A task asked in this conversation: its main timeline, or this thread. */
export const isHere = (task: Pick<ManagedTask, "channelId" | "threadId">, place: Place) =>
  task.channelId === place.channelId && (task.threadId ?? null) === place.threadId;

/** `held`: it waits on no person but on its computer (full or away), its plan's limit or the budget (`held`). */
export type RowState = "working" | "ok" | "answer" | "queued" | "stopping" | HeldState;
export type HeldState = "computerBusy" | "computerOffline" | "plan" | "budget";

const HELD: Record<NonNullable<ManagedTask["held"]>, HeldState> = {
  computer_busy: "computerBusy",
  computer_offline: "computerOffline",
  plan: "plan",
  budget: "budget",
};

/** A task's state on its row: one asked to stop here says so until it leaves the list. */
export function rowState(
  task: Pick<ManagedTask, "runId" | "status" | "held">,
  stopping: ReadonlySet<string>,
): RowState {
  if (stopping.has(task.runId)) return "stopping";
  const state = taskState(task);
  if (state !== "waiting") return state;
  const wait = waitsFor(task);
  if (wait === "ok" || wait === "answer" || wait === null) return wait ?? "answer";
  return HELD[wait];
}

/** It waits on no person (a computer, a plan, a budget): grey, not "espera você". */
export const isHeld = (state: RowState): state is HeldState =>
  state === "computerBusy" || state === "computerOffline" || state === "plan" || state === "budget";

export function stateText(t: TFunction, state: RowState): string {
  switch (state) {
    case "working":
      return t("taskManager.state.working");
    case "ok":
      return t("taskManager.state.ok");
    case "answer":
      return t("taskManager.state.answer");
    case "queued":
      return t("taskManager.state.queued");
    case "stopping":
      return t("taskManager.state.stopping");
    case "computerBusy":
      return t("taskManager.state.computerBusy");
    case "computerOffline":
      return t("taskManager.state.computerOffline");
    case "plan":
      return t("taskManager.state.plan");
    case "budget":
      return t("taskManager.state.budget");
  }
}

/** A task's state in words; one waiting for room on a full computer says its place in line ("Na fila · 2º"). */
export function taskStateText(t: TFunction, task: Pick<ManagedTask, "held" | "line">, state: RowState): string {
  const line = state === "computerBusy" ? linePlace(task) : null;
  return line ? t("taskManager.state.inLine", { position: line.position }) : stateText(t, state);
}

/**
 * When a task waiting for room on its computer should start, in the computer line's own words ("começa em ~3 min");
 * null with no estimate, or when it isn't in a line.
 */
export function lineStartText(t: TFunction, task: Pick<ManagedTask, "held" | "line">, now: number): string | null {
  const at = linePlace(task)?.estimatedStartAt;
  return at ? t("queue.startsIn", { n: etaMinutes(at, now) }) : null;
}

/** A computer on the task manager: "Cheio · 2 na fila · 3 trabalhando", "Tem espaço · 1 trabalhando". */
export function computerLine(t: TFunction, computer: Pick<ComputerSummary, "working" | "inLine">): string {
  const room =
    computer.inLine > 0 ? t("taskManager.queue.full", { count: computer.inLine }) : t("taskManager.queue.room");
  return computer.working > 0 ? `${room} · ${t("taskManager.working", { count: computer.working })}` : room;
}

/** An agent's row: "1 trabalhando · 1 espera você", or "Na fila" while its tasks only wait their turn. */
export function groupLine(t: TFunction, group: Pick<AgentTasks, "working" | "waiting">) {
  const parts = [
    group.working > 0 ? t("taskManager.working", { count: group.working }) : null,
    group.waiting > 0 ? t("taskManager.waiting", { count: group.waiting }) : null,
  ].filter((p): p is string => Boolean(p));
  const mark: "working" | "waiting" | "queued" =
    group.working > 0 ? "working" : group.waiting > 0 ? "waiting" : "queued";
  return { mark, text: parts.length > 0 ? parts.join(" · ") : t("taskManager.state.queued") };
}

/**
 * Under a task's title: where it is, who asked and how far its plan got ("#produto · Ana pediu · 9 de 14 feitos").
 * Where is left out when it already is the title (a task with no label of its own).
 */
export function taskSubline(
  t: TFunction,
  task: Pick<ManagedTask, "routine" | "channelKind" | "channelName" | "background" | "requester" | "plan">,
  meId: string | null,
  title: string,
): string {
  const where = taskWhere(t, task);
  const asked = task.requester
    ? task.requester.userId === meId
      ? t("taskManager.askedByYou")
      : t("taskManager.askedBy", { name: task.requester.name })
    : null;
  const plan = task.plan && task.plan.total > 0 ? t("taskManager.plan", task.plan) : null;
  return [where === title ? null : where, asked, plan].filter(Boolean).join(" · ");
}

/** How a task ended, for "Terminadas hoje": done, stopped (by you, by someone), or couldn't finish. */
export function endedText(t: TFunction, task: Pick<EndedTask, "status" | "stoppedBy">, meId: string | null): string {
  const state = endedState(task);
  if (state === "done") return t("taskManager.ended.done");
  if (state === "failed") return t("taskManager.ended.failed");
  if (!task.stoppedBy) return t("taskManager.state.stopped");
  return task.stoppedBy.userId === meId
    ? t("taskManager.ended.stopped")
    : t("taskManager.ended.stoppedBy", { name: task.stoppedBy.name });
}

/** "Terminadas hoje", the latest first. */
export const endedLatestFirst = (ended: readonly EndedTask[]) =>
  [...ended].sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));

/** What a task uses now, as its line says it: a brain's product, one of the agent's own programs or an app. */
export interface UsingNow {
  /** A computer brain's mark (`claude_code`, `codex`, `cursor`); else the call's own logo (`activity`). */
  brain: string | null;
  activity: Activity | null;
  /** "Claude Code", "Navegador", "GitHub". */
  name: string;
  /** "Navegador · página de cancelar", "PR #231". */
  detail: string | null;
}

/**
 * "Usando agora": the program and what it does there. A brain says what it called through us, if anything; one of our
 * own tools says what it does ("agentes · Escrevendo na wiki"). `appName` names a connector's app (the catalog's
 * label); null while nothing runs (queued, or only thinking).
 */
export function usingNow(
  t: TFunction,
  program: TaskProgram,
  options: { locale?: string; appName?: (activity: Activity) => string } = {},
): UsingNow | null {
  const appName = options.appName ?? ((a: Activity) => a.app ?? "");
  switch (program.kind) {
    case "none":
      return null;
    case "brain": {
      const inner = program.inner ? usingNow(t, program.inner, options) : null;
      const detail = inner
        ? inner.detail
          ? t("taskManager.program.inside", { program: inner.name, detail: inner.detail })
          : inner.name
        : program.detail;
      return { brain: program.brain, activity: null, name: brainName(program.brain), detail: detail || null };
    }
    case "browser":
    case "screen":
    case "terminal": {
      const name =
        program.kind === "browser"
          ? t("taskManager.program.browser")
          : program.kind === "screen"
            ? t("taskManager.program.screen")
            : t("taskManager.program.terminal");
      return { brain: null, activity: program.activity, name, detail: program.detail };
    }
    case "app":
      return {
        brain: null,
        activity: program.activity,
        name: appName(program.activity) || program.activity.app || program.activity.service || "",
        detail: program.detail,
      };
    case "agentes": {
      const doing = capitalize(activityVerb(t, program.activity), options.locale);
      return {
        brain: null,
        activity: program.activity,
        name: t("taskManager.program.agentes"),
        detail: [doing, program.detail].filter(Boolean).join(" · ") || null,
      };
    }
  }
}

/** One agent's tasks now: its DM header's count and its tasks screen (ADR 0128). */
export interface AgentTaskView {
  /** People's first, then its routines', oldest first; `here`: asked in the conversation it was opened from. */
  rows: { task: ManagedTask; here: boolean }[];
  /** How many work now. */
  working: number;
  /** How many wait on a person. */
  waiting: number;
  /** "Parar todas": every task one may stop that isn't stopping yet. */
  stoppable: string[];
}

/** An agent's tasks, or null while it has none; `here` tags the ones asked in that conversation. */
export function agentTasksOf(
  tasks: readonly ManagedTask[],
  agentId: string,
  here: Place | null,
  stopping: ReadonlySet<string>,
): AgentTaskView | null {
  const mine = tasksOf([...tasks], agentId);
  if (mine.length === 0) return null;
  return {
    rows: mine.map((task) => ({ task, here: here !== null && isHere(task, here) })),
    working: mine.filter((task) => taskState(task) === "working").length,
    waiting: mine.filter((task) => waitsOnPerson(task)).length,
    stoppable: mine.filter((task) => task.canStop && !stopping.has(task.runId)).map((task) => task.runId),
  };
}

/** "Feitas hoje" on an agent's tasks screen: what it finished today (stopped and failed ones aren't done). */
export const doneTodayOf = (ended: readonly EndedTask[], agentId: string) =>
  ended.filter((e) => e.agentId === agentId && endedState(e) === "done").length;

/** An agent's tasks screen, opened from a conversation (its tasks there are tagged "aqui"). */
export function agentTasksHref(agentId: string, from: Place | null) {
  if (!from) return `/agent-tasks/${agentId}` as const;
  const thread = from.threadId ? `&thread=${from.threadId}` : "";
  return `/agent-tasks/${agentId}?channel=${from.channelId}${thread}` as const;
}

/**
 * What an agent's DM header shows of its tasks: how many there are, and how many wait on you when some also work; its
 * mark is the orbit while some work, else the waiting mark (or queued). `room` is its width in the bar's buttons (44
 * points each), which the conversation's title gives up.
 */
export function tasksBadge(view: Pick<AgentTaskView, "rows" | "working" | "waiting">) {
  const both = view.working > 0 && view.waiting > 0;
  const mark: RowState = view.working > 0 ? "working" : view.waiting > 0 ? "ok" : "queued";
  return { count: view.rows.length, mark, waiting: both ? view.waiting : null, room: both ? 1.9 : 1.3 };
}
