import type { AppNotification } from "@agenteschat/client";
import { appCreatedLine } from "@agenteschat/client/lib/apps";
import { restrictionOf, workspaceHeadline } from "@agenteschat/client/lib/notifications";
import { useTranslation } from "react-i18next";
import { useDirectory } from "../shared/hooks";
import { runFailedLines, whoOf } from "./logic";

/** Stands in for the names in the translated title, so they can be drawn bold. */
const NAMES = "⁣names⁣";

/**
 * Who did what, as Atividade and the island (ADR 0071 §9) say it: the sentence's pieces around the names (drawn
 * bold between them), the names, and the whole sentence (for VoiceOver). With a restriction on agentes.chat Cloud
 * or several agents' failures of one cause, what goes under it too.
 */
export function useNoticeTitle(n: AppNotification) {
  const { t } = useTranslation();
  const dir = useDirectory();
  // A restriction on agentes.chat Cloud: its whole line under the headline, and a held agent's name heads it.
  const restriction = restrictionOf(n);
  const held = restriction?.code === "agent.paused";
  const who = whoOf(n.actors, (a) => dir.nameOf({ type: a.type === "agent" ? "agent" : "person", id: a.id }));
  const names = held
    ? (n.source.label ?? "")
    : who.second
      ? who.more > 0
        ? t("mobile.names.more", { first: who.first, second: who.second, count: who.more })
        : t("mobile.names.two", { first: who.first, second: who.second })
      : who.first;
  const kind =
    n.kind === "browser_handoff" && n.source.screen === "desktop"
      ? "desktop_handoff"
      : n.kind === "catch_up_closed_asker" && n.latest.reason === "task_canceled"
        ? "catch_up_closed_asker_task"
        : n.kind === "approval_cover" && (n.latest.statusTo === "declined" || n.latest.statusTo === "ended")
          ? `approval_cover_${n.latest.statusTo}`
          : n.kind;
  const template = held
    ? t("standing.notification.agentHold", { name: NAMES })
    : n.kind === "app_created"
      ? appCreatedLine(t, n)
      : n.kind === "skill_update"
        ? t(workspaceHeadline(n) ?? "skills.notice.updated", { name: n.source.label ?? "" })
        : t(`mobile.activity.kind.${kind}`, {
            names: NAMES,
            // `catch_up_closed`: the conversations it skipped.
            count: n.kind === "catch_up_closed" ? n.count : who.total,
            // `plan_reset_unknown`: the plan's name.
            plan: n.latest.title ?? "",
            // `catch_up_closed_asker`: who was credited.
            who: n.latest.title ?? "",
            defaultValue: NAMES,
          });
  // Agents that failed for one cause close together: one line for all, who they are under it.
  const failed = runFailedLines(t, n, (id) => dir.nameOf({ type: "agent", id }));
  const parts = failed ? [failed.title] : template.split(NAMES);
  const title = parts.join(names);
  return { parts, names, title, restriction, failed };
}
