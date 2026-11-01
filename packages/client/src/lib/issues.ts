import type { TFunction } from "i18next";
import type { Issue, IssueActivity, IssuePriority, IssueStatus } from "../api/types";

export const BOARD: IssueStatus[] = ["todo", "in_progress", "in_review", "done"];
export const STATUSES: IssueStatus[] = [...BOARD, "canceled"];
export const PRIORITIES: IssuePriority[] = ["low", "normal", "high"];

/** A circle that fills as the work goes. */
export const STATUS_ICON: Record<IssueStatus, "stageTodo" | "stageProgress" | "stageReview" | "stageDone" | "close"> = {
  todo: "stageTodo",
  in_progress: "stageProgress",
  in_review: "stageReview",
  done: "stageDone",
  canceled: "close",
};

/** An event of a task in the person's language from its code (`issues.event.*`); the server's words as the fallback. */
export function issueEventText(t: TFunction, a: Pick<IssueActivity, "text" | "textCode" | "textParams">) {
  if (!a.textCode) return a.text;
  const p = a.textParams ?? {};
  const extra = {
    ...(p.status ? { status: t(`issues.status.${p.status}`, { defaultValue: p.status }) } : {}),
    ...(p.priority ? { priority: t(`issues.priority.${p.priority}`, { defaultValue: p.priority }) } : {}),
  };
  return t(`issues.event.${a.textCode}`, { ...p, ...extra, defaultValue: a.text });
}

/** Description text → description + acceptance criteria (lines starting with "-", "*" or "[ ]"). */
export function splitCriteria(text: string) {
  const criteria: string[] = [];
  const rest: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:[-*]\s*(?:\[[ x]?\]\s*)?|\[[ x]?\]\s*)(.+)$/i);
    if (m?.[1]?.trim()) criteria.push(m[1].trim());
    else rest.push(line);
  }
  return { description: rest.join("\n").trim(), criteria };
}

/** An agent working on the issue now (a live run), not a stalled one. */
export const isWorking = (i: Pick<Issue, "work">) => Boolean(i.work && i.work.state !== "stalled");
/** In progress with an agent and no run alive: the agent took it but nobody is working. */
export const isStalled = (i: Pick<Issue, "work">) => i.work?.state === "stalled";
export const isOpen = (i: Pick<Issue, "status">) => i.status !== "done" && i.status !== "canceled";

/** An issue someone asked an agent to implement, as a message carries it. */
export interface IssueWorkRef {
  issueId: string;
  number: number;
  title: string;
  agentId: string;
}

function workRef(v: unknown): IssueWorkRef | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.issueId !== "string" || typeof o.number !== "number" || typeof o.title !== "string") return null;
  return {
    issueId: o.issueId,
    number: o.number,
    title: o.title,
    agentId: typeof o.agentId === "string" ? o.agentId : "",
  };
}

/** `meta.issueWork`: the root of the work thread in the requester's DM with the agent (shown as a card). */
export const issueWorkOf = (meta: Record<string, unknown> | null | undefined) => workRef(meta?.issueWork);
/** `meta.issueTaken`: the one line where the issue came from ("Ada took issue #24"). */
export const issueTakenOf = (meta: Record<string, unknown> | null | undefined) => workRef(meta?.issueTaken);
