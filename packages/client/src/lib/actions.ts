import type { TFunction } from "i18next";
import { AGENT_ACTION_KINDS, type AgentAction, type ApiRule } from "../api/types";
import { joinNames } from "./format";

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
 * Who sees the buttons (the server checks it again): the person the agent worked for, whoever manages agents
 * (`manage_agents`), or the agent's owner.
 */
export function canUndoAction(
  a: Pick<AgentAction, "requestedByUserId">,
  viewer: { userId: string; managesAgents: boolean; ownsAgent: boolean },
) {
  return a.requestedByUserId === viewer.userId || viewer.managesAgents || viewer.ownsAgent;
}

/**
 * The webhook routine whose address a receipt offers to copy ("Copiar endereço do webhook"): one the agent created or
 * changed into (or within) a webhook routine, for the person it worked for or whoever manages routines (the server
 * checks it again). Null for any other receipt.
 */
export function hookToCopy(
  a: Pick<AgentAction, "kind" | "params" | "target" | "requestedByUserId" | "undoneAt">,
  viewer: { userId: string | null; managesRoutines: boolean },
): string | null {
  const made = a.kind === "routine.created" || a.kind === "routine.updated";
  if (!made || a.params.trigger !== "webhook" || a.target.type !== "routine" || a.undoneAt) return null;
  return a.requestedByUserId === viewer.userId || viewer.managesRoutines ? a.target.id : null;
}

/** The receipts Desfazer tudo would undo now (shown when a message has more than one change). */
export const undoableNow = (list: AgentAction[], now = Date.now()) =>
  list.filter((a) => actionPhase(a, now) === "undo");

const KNOWN_KINDS = new Set<string>(AGENT_ACTION_KINDS);

/**
 * The i18n key of a receipt's sentence: `agentActions.issue.created`… (params: `action.params`). A kind this build
 * doesn't know (an open tab, an older app) says `agentActions.other`, never its raw key.
 */
export const actionTextKey = (a: Pick<AgentAction, "kind">) =>
  KNOWN_KINDS.has(a.kind) ? `agentActions.${a.kind}` : "agentActions.other";

/** The i18n key of an undo/redo error code (`action.changed_since` → `agentActions.errors.changed_since`). */
export const actionErrorKey = (code: string) => `agentActions.errors.${code.replace(/^action\./, "")}`;

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** A created routine's actions in connected apps it does without asking (its receipt's `ownActions`). */
export const routineOwnActions = (a: Pick<AgentAction, "kind" | "params">): string[] =>
  a.kind === "routine.created" && Array.isArray(a.params.ownActions)
    ? a.params.ownActions.filter((v): v is string => typeof v === "string")
    : [];

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
      ? joinNames(
          fields.map((f) => t(`agentActions.${group}.${f}`, { defaultValue: f })),
          t,
        )
      : t("agentActions.someFields");
  const title = str(p.title) || a.target.title || "";
  switch (a.kind) {
    case "issue.created":
    case "issue.updated":
    case "issue.assigned": {
      // No title: a limited task, named where not everyone sees it (ADR 0151).
      const v: Record<string, string> = {
        number: str(p.number) || str(a.target.number),
        title: title || t("whoSees.limited"),
      };
      if (a.kind === "issue.updated") {
        v.fields = fieldWords("issueFields");
        if (fields.length === 1 && fields[0] === "status" && p.status) {
          v.context = "status";
          v.status = t(`issues.statusLower.${str(p.status)}`, { defaultValue: str(p.status) });
        } else if (fields.length === 1 && fields[0] === "priority" && p.priority) {
          v.context = "priority";
          v.priority = t(`issues.priorityLower.${str(p.priority)}`, { defaultValue: str(p.priority) });
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
      return p.rule === true ? { text: str(p.text), context: "rule" } : { text: str(p.text) };
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
    case "channel.created":
      return { name: str(p.name) || a.target.title || "" };
    case "wiki.page_created":
    case "wiki.page_edited":
      return p.restricted ? { context: "restricted" } : { title };
    case "thread.renamed":
      return { from: str(p.from), to: str(p.to) || title };
    case "routine.deleted":
      return { name: str(p.name) || title };
    case "thread.closed":
      return { title };
    case "skill.created":
    case "skill.updated":
      return { name: str(p.name) || title };
    case "agent.settings_changed":
      return { agentName: str(p.agentName) || title };
    case "pr.merged":
      return p.number
        ? { repo: str(p.repo), number: str(p.number) }
        : { repo: str(p.repo), ref: str(p.ref), context: "branch" };
    default:
      // A kind the server knows and this build doesn't yet (an open tab, an older app): the key's own words.
      return {};
  }
}
