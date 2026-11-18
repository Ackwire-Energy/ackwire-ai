import { type AgentLineChange, useSetAgentLines, useTeam } from "@agenteschat/client";
import { can } from "@agenteschat/client/lib/permissions";
import { rightHandOf } from "@agenteschat/client/lib/right-hand";
import { mayReportTo, reportsOf, supervisorOf } from "@agenteschat/client/lib/team-views";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "@/providers/org";
import { GroupedFooter, GroupedHeader, GroupedList, GroupedRow, useToast } from "@/ui";
import { router } from "@/ui/navigation";
import { useFailed } from "../routines/hooks";
import { useDirectory, useOrgId } from "../shared/hooks";
import { closeAgentChoose, openAgentChoose } from "./agent-choose";

/**
 * Responde a (ADR 0148 addendum), as the web's field: who manages agents picks the agent it reports to on a screen of
 * its own (the agents it may report to, and nobody), applied at once, with Desfazer in the toast; anyone else reads it.
 * A supervisor lists who reports to it. No drag on the phone.
 */
export function ReportsToSection({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const { org } = useOrg();
  const dir = useDirectory();
  const toast = useToast();
  const failed = useFailed();
  const team = useTeam(orgId).data?.agents ?? [];
  const set = useSetAgentLines(orgId);
  const lodiId = rightHandOf(dir.agents)?.id;
  const agent = team.find((a) => a.id === agentId);
  const apply = (changes: AgentLineChange[], undoing = false) =>
    set.mutate(changes, {
      onError: failed,
      onSuccess: ({ previous }) => {
        const to = changes[0]?.reportsToAgentId;
        const name = agent?.name ?? "";
        toast({
          title: to
            ? t("team.reportsTo.done", { agent: name, to: team.find((a) => a.id === to)?.name ?? "" })
            : t("team.reportsTo.cleared", { agent: name }),
          agentId,
          ...(undoing || previous.length === 0
            ? {}
            : { action: { label: t("agentGroups.undo"), onPress: () => apply(previous, true) } }),
        });
      },
    });
  // The screen's choice reaches the latest `apply` (the team as it is then), whenever it comes.
  const latest = useRef(apply);
  useLayoutEffect(() => {
    latest.current = apply;
  });
  useEffect(() => () => closeAgentChoose(), []);
  if (!agent || agent.id === lodiId) return null;
  const manages = can(org, "manage_agents");
  const current = supervisorOf(agent, team);
  const reports = reportsOf(agentId, team);
  if (!manages && !current && reports.length === 0) return null;
  const choose = () => {
    const choices = team.filter((a) => a.id !== lodiId && a.id !== agentId && mayReportTo(team, agentId, a.id));
    const now = agent.reportsToAgentId ?? null;
    openAgentChoose({
      title: t("team.reportsTo.label"),
      ids: choices.map((a) => a.id),
      picked: now ? [now] : [],
      none: t("team.reportsTo.none"),
      note: t("team.reportsTo.help"),
      apply: ([to]) => {
        if ((to ?? null) !== now) latest.current([{ agentId, reportsToAgentId: to ?? null }]);
      },
    });
    router.push("/agent-choose");
  };
  return (
    <>
      <GroupedHeader>{t("team.reportsTo.label")}</GroupedHeader>
      <GroupedList>
        <GroupedRow
          icon="members"
          label={t("team.reportsTo.label")}
          hint={{ name: t("common.about", { label: t("team.reportsTo.label") }), text: t("team.reportsTo.help") }}
          value={current?.name ?? t("team.reportsTo.none")}
          {...(manages ? { chevron: true, disabled: set.isPending, onPress: choose } : {})}
        />
      </GroupedList>
      {reports.length > 0 ? (
        <GroupedFooter>
          {`${t("team.reportsTo.reports", { name: agent.name })}: ${reports.map((r) => r.name).join(", ")}.`}
        </GroupedFooter>
      ) : null}
    </>
  );
}
