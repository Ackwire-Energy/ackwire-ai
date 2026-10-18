import type { AgentAction } from "../api/types";

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
