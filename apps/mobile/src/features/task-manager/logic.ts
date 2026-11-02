import type { EndedTask, ManagedTask } from "@agenteschat/client";
import { type Activity, activityVerb } from "@agenteschat/client/lib/activity";
import { capitalize } from "@agenteschat/client/lib/format";
import { brainName } from "@agenteschat/client/lib/outages";
import {
  type AgentTasks,
  endedState,
  type TaskProgram,
  tasksOf,
  taskState,
  taskWhere,
  waitsFor,
} from "@agenteschat/client/lib/task-manager";
import type { TFunction } from "i18next";

/**
 * What the phone's task manager says (ADR 0125): its list, a task's screen and the strip over an agent's DM composer,
 * from the shared model (`@agenteschat/client/lib/task-manager`).
 */

/** A conversation: a channel's (or a DM's) main timeline, or one of its threads. */
export interface Place {
  channelId: string;
  threadId: string | null;
}

/** A task asked in this conversation: its main timeline, or this thread. */
export const isHere = (task: Pick<ManagedTask, "channelId" | "threadId">, place: Place) =>
  task.channelId === place.channelId && (task.threadId ?? null) === place.threadId;

export type RowState = "working" | "ok" | "answer" | "queued" | "stopping";

/** A task's state on its row: one asked to stop here says so until it leaves the list. */
export function rowState(task: Pick<ManagedTask, "runId" | "status">, stopping: ReadonlySet<string>): RowState {
  if (stopping.has(task.runId)) return "stopping";
  const state = taskState(task);
  if (state === "waiting") return waitsFor(task) === "answer" ? "answer" : "ok";
  return state;
}

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
  }
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

/** The strip over an agent's DM composer (ADR 0125). */
export interface Strip {
  /** The agent's tasks, people's first then its routines', oldest first; `here`: asked in this conversation. */
  rows: { task: ManagedTask; here: boolean }[];
  /** Some task works now (the strip's orbit); otherwise they wait. */
  working: boolean;
  /** How many wait on a person. */
  waiting: number;
  /** "Parar esta": the task here one may stop. */
  stopHere: ManagedTask | null;
  /** The task here was just asked to stop. */
  stoppingHere: boolean;
  /** "Parar todas": every task one may stop that isn't stopping yet. */
  stoppable: string[];
}

/**
 * The agent's tasks for the strip over its DM's composer, or null while it works only here (or not at all): the
 * working line already says what it does here and stops it, so the strip shows only when there is more to see.
 */
export function stripOf(
  tasks: readonly ManagedTask[],
  agentId: string,
  place: Place,
  stopping: ReadonlySet<string>,
): Strip | null {
  const mine = tasksOf([...tasks], agentId);
  const rows = mine.map((task) => ({ task, here: isHere(task, place) }));
  if (!rows.some((r) => !r.here)) return null;
  const free = (task: ManagedTask) => task.canStop && !stopping.has(task.runId);
  return {
    rows,
    working: mine.some((task) => taskState(task) === "working"),
    waiting: mine.filter((task) => taskState(task) === "waiting").length,
    stopHere: rows.find((r) => r.here && free(r.task))?.task ?? null,
    stoppingHere: rows.some((r) => r.here && stopping.has(r.task.runId)),
    stoppable: mine.filter(free).map((task) => task.runId),
  };
}
