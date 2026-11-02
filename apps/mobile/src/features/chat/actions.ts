import type { AgentAction, AgentActionKind, AgentActionTarget } from "@agenteschat/client";
import { actionPhase, actionTimeLeft, canUndoAction, formatTimeLeft } from "@agenteschat/client/lib/actions";
import type { IconName } from "@/ui";
import { type AppHref, chatHref, routineHref } from "../links/logic";
import { isSafeId } from "../shared/logic";

/**
 * Act with undo (ADR 0037 round 2) on the phone: the receipts under an agent's reply. One change shows
 * as one sunken row; two or more as a group with "N mudanças · há X" and Desfazer tudo. The rules
 * (phase, time left, who may undo) are the shared client's `lib/actions`; this file only lays them out
 * for the phone.
 */

export type ReceiptLayout = "none" | "one" | "group";

export const receiptLayout = (list: readonly AgentAction[] | undefined): ReceiptLayout =>
  !list || list.length === 0 ? "none" : list.length === 1 ? "one" : "group";

/** The icon tile per kind (issue dot, flag for a changed issue, brain for memory…). */
export const RECEIPT_ICONS: Record<AgentActionKind, IconName> = {
  "issue.created": "issue",
  "issue.updated": "flag",
  "issue.assigned": "agent",
  "memory.saved": "brain",
  "memory.updated": "brain",
  "memory.forgotten": "brain",
  "routine.created": "clock",
  "routine.updated": "clock",
  "routine.deleted": "clock",
  "channel.agent_added": "hash",
  "channel.created": "hash",
  "wiki.page_created": "doc",
  "wiki.page_edited": "doc",
  "thread.renamed": "chat",
  "thread.closed": "chat",
  "skill.created": "brain",
  "skill.updated": "brain",
};

/** A kind a newer server sends that this build doesn't know yet gets the plain check. */
export const receiptIcon = (kind: AgentActionKind): IconName => RECEIPT_ICONS[kind] ?? "checkc";

/**
 * Where tapping the target goes: the issue, the routine, the channel or the thread (the phone has no wiki or
 * memory screens yet: null, the text is not a link).
 */
export function targetHref(target: AgentActionTarget, channelId: string): AppHref | null {
  switch (target.type) {
    case "issue":
      return typeof target.number === "number" ? `/issues/${target.number}` : null;
    case "routine":
      return isSafeId(target.id) ? routineHref(target.id) : null;
    case "channel":
      return target.id ? chatHref(target.id) : null;
    case "thread":
      return target.id ? chatHref(channelId, target.id) : null;
    default:
      return null;
  }
}

export interface Viewer {
  userId: string | null;
  /** They may manage agents here (`manage_agents`, ADR 0085). */
  managesAgents: boolean;
  /** The agent that acted is this person's (they own it). */
  ownsAgent: boolean;
}

/** Desfazer/Refazer show only to who may use them (the server checks it again). */
export function viewerCanUndo(a: Pick<AgentAction, "requestedByUserId">, viewer: Viewer): boolean {
  if (!viewer.userId) return false;
  return canUndoAction(a, { userId: viewer.userId, managesAgents: viewer.managesAgents, ownsAgent: viewer.ownsAgent });
}

/** One receipt's state on screen: the button it shows, the countdown text, whether it is struck through. */
export interface ReceiptView {
  phase: "undo" | "redo" | "settled";
  /** "4:58" while Desfazer works (empty otherwise). */
  timeLeft: string;
  struck: boolean;
  button: "undo" | "redo" | null;
}

export function receiptView(a: AgentAction, canUndo: boolean, now = Date.now()): ReceiptView {
  const phase = actionPhase(a, now);
  return {
    phase,
    timeLeft: phase === "undo" ? formatTimeLeft(actionTimeLeft(a, now)) : "",
    // Undone stays crossed out after the window too: it is history that it was undone.
    struck: Boolean(a.undoneAt),
    button: !canUndo || phase === "settled" ? null : phase,
  };
}

/** Any receipt still counting down (the screen ticks each second only while one does). */
export const anyLive = (list: readonly AgentAction[], now = Date.now()) =>
  list.some((a) => actionPhase(a, now) !== "settled");

/** "há X" of the group: from its first change. */
export function groupStart(list: readonly AgentAction[]): string | null {
  let first: string | null = null;
  for (const a of list) if (!first || a.createdAt < first) first = a.createdAt;
  return first;
}

/** Optimistic Desfazer / Refazer / Desfazer tudo: the receipts as they will look (rolled back on error). */
export function optimisticUndo(list: readonly AgentAction[], ids: readonly string[], userId: string, now = Date.now()) {
  const at = new Date(now).toISOString();
  return list.map((a) =>
    ids.includes(a.id) && !a.undoneAt && actionPhase(a, now) === "undo"
      ? { ...a, undoneAt: at, undoneByUserId: userId }
      : a,
  );
}

export function optimisticRedo(list: readonly AgentAction[], id: string, now = Date.now()) {
  const at = new Date(now).toISOString();
  return list.map((a) =>
    a.id === id && a.undoneAt && actionPhase(a, now) === "redo"
      ? { ...a, undoneAt: null, undoneByUserId: null, redoneAt: at }
      : a,
  );
}

/** A translated sentence with `<b>…</b>` marks → plain and bold runs (React Native has no HTML). */
export function boldRuns(text: string): { text: string; bold: boolean }[] {
  const out: { text: string; bold: boolean }[] = [];
  const re = /<b>([\s\S]*?)<\/b>/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), bold: false });
    if (m[1]) out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false });
  return out;
}
