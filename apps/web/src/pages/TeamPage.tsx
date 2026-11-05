import type { FormerAgent } from "@agenteschat/client";
import { useAgentGroups, useAiStatus, useFormerAgents, useTeam } from "@agenteschat/client";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { can } from "@agenteschat/client/lib/permissions";
import { isRightHand } from "@agenteschat/client/lib/right-hand";
import { Button, Card, EmptyState, Icon, PageHeader, Segmented } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { DeleteAgentDialog } from "@/components/DeleteAgentDialog";
import { ErrorState, LoadingCards } from "@/components/Loading";
import { useOrg } from "@/components/org-context";
import { TeamChart } from "@/components/team/TeamChart";
import { TeamList } from "@/components/team/TeamList";
import { TeamMap } from "@/components/team/TeamMap";
import { TeamSectors } from "@/components/team/TeamSectors";
import { TeamUsage } from "@/components/team/TeamUsage";
import { useDirectory } from "@/hooks/useDirectory";
import { STORAGE_KEYS, storage } from "@/lib/storage";
import "./team.css";

const VIEWS = ["list", "chart", "map", "sectors", "usage"] as const;
type TeamView = (typeof VIEWS)[number];
const isView = (v: string | null): v is TeamView => VIEWS.includes(v as TeamView);

/**
 * Equipe (ADR 0148): one page, five views of the same people, agents and setores. Lista, Organograma (who reports to
 * whom), Mapa (one column per channel, as the team works), Setores and Governança e uso. The view is remembered in
 * this browser.
 */
export function TeamPage() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const team = useTeam(org.id);
  const groups = useAgentGroups(org.id).data ?? [];
  const dir = useDirectory(org.id);
  // Asked with the page, so every view says at once whether an agent can work.
  useAiStatus(org.id);
  const [view, setView] = useState<TeamView>(() => {
    const saved = storage.get(STORAGE_KEYS.teamView);
    return isView(saved) ? saved : "list";
  });
  const pick = (v: TeamView) => {
    setView(v);
    storage.set(STORAGE_KEYS.teamView, v);
  };
  const data = team.data;
  const agents = data?.agents.filter((a) => !isRightHand(dir.agentById.get(a.id))) ?? [];
  // Archived agents have no page: admins delete them for good here (ADR 0082).
  const admin = can(org, "manage_agents");
  const former = useFormerAgents(org.id);
  const archived = (former.data ?? []).filter((a) => !a.deleted);
  const [deleting, setDeleting] = useState<FormerAgent | null>(null);
  const shown = view !== "usage" && data && agents.length > 0 ? data : null;
  return (
    <div className="page team">
      <PageHeader
        title={t("team.title")}
        meta={
          data &&
          [
            t("team.people", { count: dir.members.length }),
            t("team.agents", { count: agents.length }),
            t("team.sectorsCount", { count: groups.length }),
          ].join(" · ")
        }
        actions={
          can(org, "create_agents") && (
            <>
              <Button asChild icon="archiveBox">
                <Link to="/org/$orgId/settings/$section" params={{ orgId: org.id, section: "import" }}>
                  {t("shell.importAgents")}
                </Link>
              </Button>
              <Button asChild variant="primary" icon="plus">
                <Link to="/org/$orgId/agents/new" params={{ orgId: org.id }}>
                  {t("shell.createAgent")}
                </Link>
              </Button>
            </>
          )
        }
      >
        <Segmented
          value={view}
          onValueChange={pick}
          label={t("team.viewLabel")}
          options={VIEWS.map((v) => ({ value: v, label: t(`team.view.${v}`) }))}
        />
      </PageHeader>
      {view !== "usage" && team.isLoading && <LoadingCards count={2} />}
      {view !== "usage" && team.isError && !data && (
        <ErrorState error={team.error} onRetry={() => void team.refetch()} />
      )}
      {view !== "usage" && data && agents.length === 0 && (
        <EmptyState sky title={t("team.emptyTitle")}>
          {t("team.empty")}
        </EmptyState>
      )}
      {shown && view === "list" && <TeamList team={shown} groups={groups} />}
      {shown && view === "chart" && <TeamChart team={shown} groups={groups} />}
      {shown && view === "map" && <TeamMap team={shown} />}
      {shown && view === "sectors" && <TeamSectors team={shown} groups={groups} />}
      {view === "usage" && <TeamUsage />}
      {view === "list" && admin && archived.length > 0 && (
        <Card className="team-archived">
          <div className="team-archived__head">
            <Icon name="archive" size={16} />
            <h2>{t("team.archived")}</h2>
          </div>
          {archived.map((a) => (
            <div key={a.id} className="member-row">
              <AgentAvatar agentId={a.id} size="sm" name={a.name} />
              <span className="list-col">
                <b>{a.name}</b>
                {a.role && <span className="small muted">{a.role}</span>}
              </span>
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                aria-label={t("agentPage.delete.action", agentGrammar(a.name))}
                onClick={() => setDeleting(a)}
              >
                {t("agentPage.delete.button")}
              </Button>
            </div>
          ))}
        </Card>
      )}
      <DeleteAgentDialog agent={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}
