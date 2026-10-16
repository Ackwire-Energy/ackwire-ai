import { useTranslation } from "react-i18next";
import type { Issue, IssuePriority, IssueStatus } from "@/api/types";
import { useActors } from "@/components/actors";
import { toolActivity } from "@/lib/activity";
import { lookOf } from "@/lib/look";
import { toolLabel } from "@/lib/work";

export const BOARD: IssueStatus[] = ["todo", "in_progress", "in_review", "done"];
export const STATUSES: IssueStatus[] = [...BOARD, "canceled"];
export const PRIORITIES: IssuePriority[] = ["low", "normal", "high"];

export const STATUS_ICON: Record<IssueStatus, "issues" | "waiting" | "checks" | "check" | "close"> = {
  todo: "issues",
  in_progress: "waiting",
  in_review: "checks",
  done: "check",
  canceled: "close",
};

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

/** The agent's color for the pixel pieces (people and nobody: neutral). */
export function useAssigneeColor() {
  const { dir } = useActors();
  return (i: Pick<Issue, "assignee">) =>
    i.assignee?.type === "agent" ? (lookOf(dir.agentById.get(i.assignee.id))?.color ?? "sky") : null;
}

/** The step an agent is on, in the person's words ("Atualizou uma issue", "Consultou o github"). */
export function useStepText() {
  const { t } = useTranslation();
  return (step: { tool: string; detail?: string } | undefined) => {
    if (!step) return "";
    const a = toolActivity(step.tool, null, step.detail ?? null);
    const tt = t as unknown as (k: string, o: Record<string, unknown>) => string;
    const label = tt(`chat.work.step.${a.kind}`, { app: a.app ?? "", tool: toolLabel(step.tool) });
    return step.detail ? `${label} · ${step.detail}` : label;
  };
}
