import type { TFunction } from "i18next";
import type {
  MachineTask,
  MachineTaskMeta,
  Message,
  Mission,
  MissionPlanChangeMeta,
  MissionPlanMeta,
  MissionReportMeta,
  MissionSuggestionMeta,
  MissionSummary,
  PlanItem,
} from "@/api/types";

/**
 * Missions (ADR 0029, telas/ThreadContexto.html "App mobile"): the pure
 * pieces the thread, the pinned card and the Missões tab share. The plan is a
 * living checklist (no phases, no gates), drawn as one pixel cell per item.
 */

/** One cell of the plan strip: done (filled), doing (moving), waiting for you (outlined), stopped with the computer (dotted outline), dropped (dotted line), to do (a faint base). */
export type PlanCell = "done" | "doing" | "waiting" | "stopped" | "dropped" | "todo";

/** The strip from the plan's items, in order. `offline`: what was being done stopped with the computer. */
export function planCells(items: Pick<PlanItem, "status">[], options: { offline?: boolean } = {}): PlanCell[] {
  return items.map((i) => {
    if (i.status === "done") return "done";
    if (i.status === "doing") return options.offline ? "stopped" : "doing";
    if (i.status === "waiting_you") return "waiting";
    if (i.status === "dropped") return "dropped";
    return "todo";
  });
}

/**
 * The strip when only the counts are known (the Missões tab's list): done
 * first, then what waits for people, then as many moving cells as tasks
 * running, then what is left.
 */
export function cellsFromCounts(
  plan: { done: number; total: number; waiting: number },
  running = 0,
  options: { offline?: boolean } = {},
): PlanCell[] {
  const total = Math.max(0, plan.total);
  const done = Math.min(total, Math.max(0, plan.done));
  const waiting = Math.min(total - done, Math.max(0, plan.waiting));
  const doing = Math.min(total - done - waiting, Math.max(0, running));
  return [
    ...Array<PlanCell>(done).fill("done"),
    ...Array<PlanCell>(waiting).fill("waiting"),
    ...Array<PlanCell>(doing).fill(options.offline ? "stopped" : "doing"),
    ...Array<PlanCell>(total - done - waiting - doing).fill("todo"),
  ];
}

/** "N de M itens": dropped items don't count (same as the server's plan counts). */
export function planCounts(items: Pick<PlanItem, "status">[]) {
  const live = items.filter((i) => i.status !== "dropped");
  return {
    total: live.length,
    done: live.filter((i) => i.status === "done").length,
    doing: live.filter((i) => i.status === "doing").length,
    waiting: live.filter((i) => i.status === "waiting_you").length,
  };
}

/** A mission still being worked on (the pinned card's controls, the composer commands). */
export const isOpenMission = (m: Pick<Mission, "status">) =>
  m.status === "proposed" || m.status === "active" || m.status === "paused";

/** What waits for people, in the order the cards show it ("2 decisões, 1 revisão"). */
export type WaitingKey = "decisions" | "provisional" | "reviews" | "suggestions";
export function waitingParts(m: Pick<Mission, "pending" | "canAct">): { key: WaitingKey; count: number }[] {
  if (!m.canAct) return [];
  const parts: { key: WaitingKey; count: number }[] = [
    { key: "decisions", count: m.pending.decisions },
    { key: "provisional", count: m.pending.provisional },
    { key: "reviews", count: m.pending.reviews },
    { key: "suggestions", count: m.pending.suggestions },
  ];
  return parts.filter((p) => p.count > 0);
}

/** "Esperando você: 2 decisões, 1 revisão" (empty when nothing waits for this person). */
export function waitingText(t: TFunction, m: Pick<Mission, "pending" | "canAct">): string {
  return waitingParts(m)
    .map((p) => t(`missions.waiting.${p.key}`, { count: p.count }))
    .join(", ");
}

/** "1 h 25", "14 min", "40 s": a span in the person's language. */
export function formatSpan(t: TFunction, seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return t("missions.span.s", { s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("missions.span.m", { m });
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h < 24)
    return rest ? t("missions.span.hm", { h, m: String(rest).padStart(2, "0") }) : t("missions.span.h", { h });
  return t("missions.span.d", { count: Math.floor(h / 24) });
}

/** How long a task has run (or ran), in seconds. */
export function taskSeconds(task: Pick<MachineTask, "seconds" | "startedAt" | "status">, now = Date.now()): number {
  if (task.status === "running" && task.startedAt) return Math.max(0, (now - Date.parse(task.startedAt)) / 1000);
  return task.seconds ?? 0;
}

/** The status icon of a session row (never a colored dot). */
export type SessionState = "running" | "done" | "failed" | "interrupted" | "canceled" | "queued";
export const sessionState = (task: Pick<MachineTask, "status">): SessionState => task.status;

/** The tasks of a mission, running first, then the newest. */
export function missionTasks(tasks: MachineTask[], missionId: string): MachineTask[] {
  const rank = (t: MachineTask) => (t.status === "running" ? 0 : t.status === "queued" ? 1 : 2);
  return tasks
    .filter((t) => t.missionId === missionId && !t.resumedTaskId)
    .sort((a, b) => rank(a) - rank(b) || (a.createdAt < b.createdAt ? 1 : -1));
}

/** A pull request named in a line ("PR #431", a GitHub pull URL). */
export function prOf(text: string | null | undefined): { number: string; url: string | null } | null {
  if (!text) return null;
  const url = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/.exec(text);
  if (url?.[1]) return { number: url[1], url: url[0] };
  const short = /\bPR #(\d+)\b/i.exec(text);
  return short?.[1] ? { number: short[1], url: null } : null;
}

/** The plan change line: "+ Notificações · − Drawer lateral" (renames and status changes too). */
export function planChangeParts(change: Pick<MissionPlanChangeMeta, "added" | "removed" | "changed">) {
  return {
    added: change.added.map((i) => i.title),
    removed: change.removed.map((i) => i.title),
    done: change.changed.filter((i) => i.to === "done").map((i) => i.title),
    renamed: change.changed.filter((i) => i.renamedFrom).map((i) => ({ from: i.renamedFrom ?? "", to: i.title })),
  };
}

/** `/summary`: the counts as lines in the person's language (the server's text is English). */
export type SummaryKey = "plan" | "doing" | "running" | "decisions" | "provisional" | "reviews" | "waiting";
export function summaryParts(s: MissionSummary): { key: SummaryKey; count: number; total?: number }[] {
  const parts: { key: SummaryKey; count: number; total?: number }[] = [
    { key: "plan", count: s.plan.done, total: s.plan.total },
    { key: "doing", count: s.plan.doing },
    { key: "running", count: s.running },
    { key: "decisions", count: s.pendingDecisions },
    { key: "provisional", count: s.provisionalDecisions },
    { key: "reviews", count: s.pendingReviews },
    { key: "waiting", count: s.plan.waiting },
  ];
  return parts.filter((p) => p.key === "plan" || p.count > 0);
}

/** Composer commands (English, like the server's): `/mission <goal>`, `/stop`, `/pause`, `/resume`, `/summary`, `/plan`. */
export const MISSION_COMMANDS = ["mission", "stop", "pause", "resume", "summary", "plan"] as const;
export type MissionCommand = (typeof MISSION_COMMANDS)[number];

export function parseMissionCommand(text: string): { command: MissionCommand; arg: string } | null {
  const m = /^\/(mission|stop|pause|resume|summary|plan)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m?.[1]) return null;
  const command = m[1].toLowerCase() as MissionCommand;
  const arg = (m[2] ?? "").trim();
  if (command === "mission" && !arg) return null;
  if (command !== "mission" && arg) return null;
  return { command, arg };
}

// ── Message meta ─────────────────────────────────────────────────────────────

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown) => (typeof v === "string" ? v : "");

export function missionPlanOf(meta: Message["meta"]): MissionPlanMeta | null {
  const p = obj(meta?.missionPlan);
  if (!p || !str(p.missionId)) return null;
  return {
    missionId: str(p.missionId),
    title: str(p.title),
    goal: str(p.goal),
    computer: str(p.computer),
    executor: str(p.executor) || "claude",
  };
}

export function missionReportOf(meta: Message["meta"]): MissionReportMeta | null {
  const p = obj(meta?.missionReport);
  if (!p || !str(p.missionId)) return null;
  return {
    missionId: str(p.missionId),
    taskId: str(p.taskId),
    status: str(p.status),
    executor: str(p.executor) || "claude",
    computer: str(p.computer) || null,
    main: p.main === true,
  };
}

export function missionCardRef(meta: Message["meta"], key: "missionDecision" | "missionReview") {
  const p = obj(meta?.[key]);
  return p && str(p.id) && str(p.missionId) ? { id: str(p.id), missionId: str(p.missionId) } : null;
}

export function missionPlanChangeOf(meta: Message["meta"]): MissionPlanChangeMeta | null {
  const p = obj(meta?.missionPlanChange);
  if (!p || !str(p.missionId)) return null;
  const list = (v: unknown) =>
    (Array.isArray(v) ? v : []).flatMap((x) => {
      const o = obj(x);
      return o && str(o.title) ? [{ ...o, id: str(o.id), title: str(o.title) }] : [];
    });
  return {
    missionId: str(p.missionId),
    version: typeof p.version === "number" ? p.version : 0,
    added: list(p.added),
    removed: list(p.removed),
    changed: list(p.changed) as MissionPlanChangeMeta["changed"],
  };
}

export function missionSuggestionOf(meta: Message["meta"]): MissionSuggestionMeta | null {
  const p = obj(meta?.missionSuggestion);
  const status = str(p?.status);
  if (!p || !str(p.missionId) || !["pending", "accepted", "declined"].includes(status)) return null;
  return {
    status: status as MissionSuggestionMeta["status"],
    missionId: str(p.missionId),
    ...(str(p.by) ? { by: str(p.by) } : {}),
    ...(str(p.at) ? { at: str(p.at) } : {}),
  };
}

export function machineTaskOf(meta: Message["meta"]): MachineTaskMeta | null {
  const p = obj(meta?.machineTask);
  if (!p || !str(p.id)) return null;
  return {
    id: str(p.id),
    title: str(p.title),
    status: (str(p.status) || "done") as MachineTaskMeta["status"],
    exitCode: typeof p.exitCode === "number" ? p.exitCode : null,
    seconds: typeof p.seconds === "number" ? p.seconds : 0,
    computer: str(p.computer),
    executor: str(p.executor),
    ...(str(p.branch) ? { branch: str(p.branch) } : {}),
    ...(str(p.lastLine) ? { lastLine: str(p.lastLine) } : {}),
    ...(Array.isArray(p.files) ? { files: p.files.map(String) } : {}),
    ...(str(p.result) ? { result: str(p.result) } : {}),
    ...(str(p.missionId) ? { missionId: str(p.missionId) } : {}),
  };
}

/** The server's notices about a computer and its tasks (offline, back, a task that ended): event lines. */
export function taskNoticeOf(meta: Message["meta"]): { code: string; params: Record<string, string> } | null {
  const code = str(meta?.bodyCode);
  if (!/^machine_(offline|task_[a-z]+)$/.test(code)) return null;
  const params = obj(meta?.bodyParams) ?? {};
  return { code, params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v ?? "")])) };
}

/** An executor's name for people ("Claude Code", "Codex"): a product, not jargon. */
export const executorName = (executor: string) => (executor === "codex" ? "Codex" : "Claude Code");

// ── The `.agentes/` files, as the panel draws them ───────────────────────────

/** A checklist line's mark (the server writes `[ ]`, `[~]`, `[!]`, `[x]`, `[-]`). */
export type CheckState = "todo" | "doing" | "waiting" | "done" | "dropped";
const CHECK: Record<string, CheckState> = {
  " ": "todo",
  "~": "doing",
  "!": "waiting",
  x: "done",
  X: "done",
  "-": "dropped",
};

export type MdLine =
  | { kind: "h1" | "h2" | "p" | "li" | "quote"; text: string }
  | { kind: "check"; text: string; state: CheckState; note?: string }
  | { kind: "blank" };

/** A small Markdown subset (headings, checklists, bullets, quotes, paragraphs), line by line. */
export function mdLines(content: string): MdLine[] {
  return content.split("\n").map((raw): MdLine => {
    const l = raw.trimEnd();
    if (!l.trim()) return { kind: "blank" };
    if (l.startsWith("# ")) return { kind: "h1", text: l.slice(2) };
    if (/^#{2,6} /.test(l)) return { kind: "h2", text: l.replace(/^#{2,6} /, "") };
    const ck = /^\s*[-*] \[( |x|X|~|!|-)\] (.*?)(?: \((.+)\)| · (.+))?$/.exec(l);
    if (ck) {
      const note = ck[3] ?? ck[4];
      return { kind: "check", state: CHECK[ck[1] ?? " "] ?? "todo", text: ck[2] ?? "", ...(note ? { note } : {}) };
    }
    if (/^\s*[-*] /.test(l)) return { kind: "li", text: l.replace(/^\s*[-*] /, "") };
    if (l.startsWith("> ")) return { kind: "quote", text: l.slice(2) };
    return { kind: "p", text: l };
  });
}

/** Lines of `next` that weren't in `prev` (a new note, a new decision): they fade in. */
export function newLineIndexes(prev: string | null | undefined, next: string): Set<number> {
  if (prev == null) return new Set();
  const before = new Map<string, number>();
  for (const l of prev.split("\n")) before.set(l, (before.get(l) ?? 0) + 1);
  const out = new Set<number>();
  next.split("\n").forEach((l, i) => {
    const n = before.get(l) ?? 0;
    if (n > 0) before.set(l, n - 1);
    else if (l.trim()) out.add(i);
  });
  return out;
}

/** The small diff of an edit found on the machine ("- …" / "+ …" lines). */
export function editDiff(diff: string | undefined): { kind: "add" | "del"; text: string }[] {
  return (diff ?? "")
    .split("\n")
    .filter((l) => l.startsWith("- ") || l.startsWith("+ "))
    .map((l) => ({ kind: l.startsWith("+") ? ("add" as const) : ("del" as const), text: l.slice(2) }));
}
