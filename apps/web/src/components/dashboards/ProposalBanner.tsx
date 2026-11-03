import type { Dashboard, DashboardProposalDecision } from "@agenteschat/client";
import { useDecideDashboardProposal } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, useDarkTheme, widgetTileVars } from "@agenteschat/ui";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useDirectory } from "@/hooks/useDirectory";
import { useToast } from "@/lib/toast";
import { roleNames, useCustomRoles } from "./parts";

/**
 * An agent's request to show the board to more people (ADR 0134 §11), on the board itself: "Theo built this
 * dashboard for you", what it suggests, and — for the person it asks — Keep only for me and Publish. Everyone else
 * who sees the board reads the request without the buttons.
 */
export function ProposalBanner({ board }: { board: Dashboard }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const roles = useCustomRoles(org.id);
  const dark = useDarkTheme();
  const toast = useToast();
  const decide = useDecideDashboardProposal(org.id);
  const proposal = board.proposal;
  if (!proposal) return null;
  const agent = dir.anyAgent(proposal.agentId);
  const name = agent?.name ?? t("channel.unknownAgent");
  const names = roleNames(roles, proposal.roleIds);
  const run = (decision: DashboardProposalDecision) =>
    decide.mutate(
      { dashboardId: board.id, decision },
      {
        onSuccess: () =>
          toast.show(
            t(decision === "publish" ? "dashboards.proposal.published" : "dashboards.proposal.kept", {
              title: board.title,
            }),
          ),
        onError: (error) => toast.show(errorText(t, error), "error"),
      },
    );
  return (
    <section
      className="db-proposal"
      aria-label={t("dashboards.proposal.title", { name })}
      style={widgetTileVars(colorOf(agent), dark)}
    >
      <AgentAvatar agentId={proposal.agentId} name={name} size="sm" />
      <div className="db-proposal__text">
        <b>{t("dashboards.proposal.title", { name })}</b>
        <span>
          {proposal.audience === "workspace"
            ? t("dashboards.proposal.workspace")
            : t("dashboards.proposal.roles", { roles: names })}
        </span>
        {proposal.why && <span className="db-proposal__why">{proposal.why}</span>}
      </div>
      {proposal.canDecide && (
        <div className="db-proposal__acts">
          <Button variant="ghost" size="sm" disabled={decide.isPending} onClick={() => run("keep")}>
            {t("dashboards.proposal.keep")}
          </Button>
          <Button variant="primary" size="sm" loading={decide.isPending} onClick={() => run("publish")}>
            {proposal.audience === "workspace"
              ? t("dashboards.proposal.publishWorkspace")
              : t("dashboards.proposal.publishRoles", { roles: names })}
          </Button>
        </div>
      )}
    </section>
  );
}
