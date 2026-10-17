import type { Issue } from "@agenteschat/client";
import { toolActivity } from "@agenteschat/client/lib/activity";
import { toolLabel } from "@agenteschat/client/lib/work";
import { useTranslation } from "react-i18next";
import { useActors } from "@/components/actors";
import { lookOf } from "@/lib/look";

export * from "@agenteschat/client/lib/issues";

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
