import type { TFunction } from "i18next";
import type { AgentAction, ApiRule } from "../api/types";

/** A receipt's `params.rule` when it is a rule (`freq`, `timezone`); anything else is none. */
function ruleOf(value: unknown): ApiRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Partial<ApiRule>;
  return typeof r.freq === "string" && typeof r.timezone === "string" ? (r as ApiRule) : null;
}

/**
 * Act with undo (ADR 0037 round 2): how a receipt under an agent's reply
 * shows. `undo`: Desfazer with the time left; `redo`: crossed out, "Desfeito
 * por …" and Refazer; `settled`: plain history (the window passed).
 */
export type ActionPhase = "undo" | "redo" | "settled";

const at = (iso: string) => new Date(iso).getTime();

export function actionPhase(a: Pick<AgentAction, "undoneAt" | "undoableUntil">, now = Date.now()): ActionPhase {
  if (at(a.undoableUntil) <= now) return "settled";
  return a.undoneAt ? "redo" : "undo";
}

/** Milliseconds until Desfazer/Refazer stops working (0 once settled), for the countdown. */
export const actionTimeLeft = (a: Pick<AgentAction, "undoableUntil">, now = Date.now()) =>
  Math.max(0, at(a.undoableUntil) - now);

/** "4:58" for the countdown. */
export function formatTimeLeft(ms: number) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Who sees the buttons (the server checks it again): the person the agent
 * worked for, an admin (or owner) of the organization, or the agent's owner.
 */
export function canUndoAction(
  a: Pick<AgentAction, "requestedByUserId">,
  viewer: { userId: string; role: "owner" | "admin" | "member"; ownsAgent: boolean },
) {
  return a.requestedByUserId === viewer.userId || viewer.role !== "member" || viewer.ownsAgent;
}

/** The receipts Desfazer tudo would undo now (shown when a message has more than one change). */
export const undoableNow = (list: AgentAction[], now = Date.now()) =>
  list.filter((a) => actionPhase(a, now) === "undo");

/** The i18n key of a receipt's sentence: `agentActions.issue.created`… (params: `action.params`). */
export const actionTextKey = (a: Pick<AgentAction, "kind">) => `agentActions.${a.kind}`;

/** The i18n key of an undo/redo error code (`action.changed_since` → `agentActions.errors.changed_since`). */
export const actionErrorKey = (code: string) => `agentActions.errors.${code.replace(/^action\./, "")}`;

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

function joinList(items: string[], and: string) {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")}${and}${items[items.length - 1]}`;
}

/**
 * The values (and i18next `context`) for `t(actionTextKey(a), …)`: issue
 * number and title, the changed fields in words, the assignee ("você" when it
 * is the viewer), the routine's name… The sentence marks the target with
 * `<b>…</b>` (render it as the link to the issue, page, routine…).
 */
export function actionTextValues(
  a: Pick<AgentAction, "kind" | "target" | "params">,
  t: TFunction,
  viewerUserId?: string,
  /** Says a routine's rule in the person's language (the web's sentence); without it, no schedule. */
  options: { schedule?: (rule: ApiRule) => string } = {},
): Record<string, string> {
  const p = a.params;
  const fields = Array.isArray(p.fields) ? p.fields : [];
  const fieldWords = (group: "issueFields" | "routineFields") =>
    fields.length
      ? joinList(
          fields.map((f) => t(`agentActions.${group}.${f}`, { defaultValue: f })),
          t("agentActions.and"),
        )
      : t("agentActions.someFields");
  const title = str(p.title) || a.target.title || "";
  switch (a.kind) {
    case "issue.created":
    case "issue.updated":
    case "issue.assigned": {
      const v: Record<string, string> = { number: str(p.number) || str(a.target.number), title };
      if (a.kind === "issue.updated") {
        v.fields = fieldWords("issueFields");
        if (fields.length === 1 && fields[0] === "status" && p.status) {
          v.context = "status";
          v.status = t(`issues.status.${str(p.status)}`, { defaultValue: str(p.status) }).toLowerCase();
        } else if (fields.length === 1 && fields[0] === "priority" && p.priority) {
          v.context = "priority";
          v.priority = t(`issues.priority.${str(p.priority)}`, { defaultValue: str(p.priority) }).toLowerCase();
        }
      }
      const assigned = a.kind === "issue.assigned" || fields.includes("assignee");
      if (assigned) {
        if (p.assigneeIsSelf === true && a.kind === "issue.assigned") v.context = "self";
        const isViewer = viewerUserId && p.assigneeType === "user" && p.assigneeId === viewerUserId;
        v.assignee = isViewer ? t("agentActions.you") : str(p.assigneeName) || t("agentActions.someone");
      }
      return v;
    }
    case "memory.saved":
    case "memory.updated":
    case "memory.forgotten":
      return { text: str(p.text) };
    case "routine.created": {
      // When it runs, from its rule in the person's language; the server's `schedule` is English, never shown.
      const rule = ruleOf(p.rule);
      const schedule = rule && options.schedule ? options.schedule(rule) : "";
      return schedule ? { name: str(p.name) || title, schedule } : { name: str(p.name) || title, context: "bare" };
    }
    case "routine.updated": {
      const v: Record<string, string> = { name: str(p.name) || title, fields: fieldWords("routineFields") };
      if (fields.length === 1 && fields[0] === "active") v.context = p.active ? "resumed" : "paused";
      return v;
    }
    case "channel.agent_added":
      return { agentName: str(p.agentName), channel: str(p.channel) || a.target.title || "" };
    case "wiki.page_created":
    case "wiki.page_edited":
      return { title };
    case "thread.renamed":
      return { from: str(p.from), to: str(p.to) || title };
    case "thread.closed":
      return { title };
  }
}
