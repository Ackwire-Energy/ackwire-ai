import type { AgentGroup, Team, TeamAgent } from "@agenteschat/client";
import { useRoles } from "@agenteschat/client";
import { agentSections } from "@agenteschat/client/lib/agent-groups";
import { can } from "@agenteschat/client/lib/permissions";
import { chartByPerson, reportsTo } from "@agenteschat/client/lib/team-views";
import { RoleMark, Segmented } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, PersonAvatar } from "@/components/AgentAvatar";
import { useAgentDrag } from "@/components/AgentGroups";
import { useOrg } from "@/components/org-context";
import { OrgMark } from "@/components/ProfilePhoto";
import { colorOf } from "@/components/Sky";
import { SectorMark, sectorStyle, useTeamLookups } from "./shared";

/**
 * Equipe › Organograma (ADR 0148): the workspace on top with its right hand, then each person with the agents that
 * report to them (its owner, else its setor's lead), or each setor with its agents. Who manages agents drags an
 * agent to another setor.
 */
export function TeamChart({ team, groups }: { team: Team; groups: AgentGroup[] }) {
  const { t } = useTranslation();
  const [by, setBy] = useState<"person" | "sector">("person");
  const look = useTeamLookups(groups);
  const lodi = look.lodi;
  return (
    <section className="team-chart" aria-label={t("team.view.chart")}>
      <div className="team-chart__bar">
        <Segmented
          size="sm"
          value={by}
          onValueChange={setBy}
          label={t("team.chart.byLabel")}
          options={[
            { value: "person", label: t("team.chart.byPerson") },
            { value: "sector", label: t("team.chart.bySector") },
          ]}
        />
        <span className="muted">
          {by === "person" ? t("team.chart.subPerson") : t("team.chart.subSector", { name: lodi?.name ?? "" })}
        </span>
      </div>
      {by === "person" ? <ByPerson team={team} groups={groups} /> : <BySector team={team} groups={groups} />}
    </section>
  );
}

function AgentNode({ agent, drag }: { agent: TeamAgent; drag?: ReturnType<ReturnType<typeof useAgentDrag>["row"]> }) {
  const { org } = useOrg();
  return (
    <Link
      to="/org/$orgId/agents/$agentId"
      params={{ orgId: org.id, agentId: agent.id }}
      className="team-node team-node--agent"
      data-agent-row={agent.id}
      {...drag}
    >
      <AgentAvatar agentId={agent.id} name={agent.name} size="sm" />
      <span className="team-node__text">
        <b>{agent.name}</b>
        {agent.role && <span className="muted">{agent.role}</span>}
      </span>
      <span
        className="team-node__dot"
        data-busy={agent.busy || undefined}
        style={agent.busy ? { background: colorOf(agent) } : undefined}
        aria-hidden="true"
      />
    </Link>
  );
}

function ByPerson({ team, groups }: { team: Team; groups: AgentGroup[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const look = useTeamLookups(groups);
  const roles = useRoles(org.id).data?.roles ?? [];
  const columns = chartByPerson(team.agents, groups, look.members, look.isLodi);
  const lodi = look.lodi;
  return (
    <div className="team-tree">
      <div className="team-tree__top">
        <span className="team-node team-node--org">
          <OrgMark logo={org.logo} size={32} />
          <span className="team-node__text">
            <b>{org.name}</b>
            <span className="muted">{t("team.chart.workspace")}</span>
          </span>
        </span>
        {lodi && (
          <Link
            to="/org/$orgId/dm/agent/$agentId"
            params={{ orgId: org.id, agentId: lodi.id }}
            className="team-node team-node--lodi"
          >
            <AgentAvatar agentId={lodi.id} name={lodi.name} size="md" />
            <span className="team-node__text">
              <b>{lodi.name}</b>
              <span className="muted">{t("rightHand.label")}</span>
            </span>
          </Link>
        )}
      </div>
      <div className="team-tree__row">
        {columns.map((c) => {
          const m = c.personId ? look.dir.memberById.get(c.personId) : undefined;
          const role = roles.find((r) => m?.roleIds?.includes(r.id));
          return (
            <div key={c.personId ?? "none"} className="team-tree__col">
              <div className="team-node team-node--person" data-none={c.personId ? undefined : ""}>
                {c.personId && m ? (
                  <>
                    <PersonAvatar id={c.personId} name={m.name} size="sm" presence />
                    <span className="team-node__text">
                      <b>{m.name}</b>
                      <span className="muted team-sector">
                        {role ? (
                          <>
                            <RoleMark color={role.color} icon={role.icon} size={14} />
                            {role.name}
                          </>
                        ) : (
                          t(`roles.${m.role}`)
                        )}
                      </span>
                    </span>
                  </>
                ) : (
                  <span className="team-node__text">
                    <b>{t("team.noOwner")}</b>
                  </span>
                )}
              </div>
              <div className="team-tree__agents">
                {c.agents.map((a) => (
                  <AgentNode key={a.id} agent={a} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BySector({ team, groups }: { team: Team; groups: AgentGroup[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const look = useTeamLookups(groups);
  const arranges = can(org, "manage_agents");
  const drag = useAgentDrag(groups);
  const by = agentSections(
    team.agents.filter((a) => !look.isLodi(a)),
    groups,
    (a) => a.id,
  );
  if (groups.length === 0) return <p className="team-empty">{t("team.sectors.emptyTitle")}</p>;
  const column = (key: string, group: AgentGroup | null, agents: TeamAgent[]) => {
    const leads = [...new Set(agents.map((a) => reportsTo(a, groups, look.members)).filter(Boolean))];
    const others = agents.filter((a) => a.id !== drag.dragging);
    const lineAt = drag.over?.groupId === (group?.id ?? null) && group ? drag.over.index : null;
    const line = <span className="sidebar__drop-line" aria-hidden="true" />;
    return (
      <section
        key={key}
        className="team-frame"
        data-none={group ? undefined : ""}
        style={sectorStyle(group)}
        aria-label={group?.name ?? t("agentGroups.none")}
        {...(arranges ? drag.zone(group?.id ?? null) : {})}
      >
        <header className="team-frame__head">
          {group && <span className="team-eyebrow">{t("agentGroups.group")}</span>}
          <span className="team-frame__title">
            {group && <SectorMark group={group} size={18} />}
            <b>{group?.name ?? t("agentGroups.none")}</b>
            <span className="muted">{t("team.agents", { count: agents.length })}</span>
          </span>
          {leads.length > 0 && (
            <span className="muted small">
              {t("team.chart.responsible", { names: leads.map((id) => look.personName(id)).join(", ") })}
            </span>
          )}
        </header>
        {agents.map((a) => (
          <Fragment key={a.id}>
            {lineAt === others.indexOf(a) && line}
            <AgentNode agent={a} drag={arranges ? drag.row(a.id) : undefined} />
          </Fragment>
        ))}
        {lineAt !== null && lineAt >= others.length && line}
        {arranges && group && agents.length === 0 && (
          <span className="sidebar__drop-hint">{t("agentGroups.dropHere")}</span>
        )}
      </section>
    );
  };
  return (
    <div className="team-frames">
      {by.groups.map(({ group, items }) => column(group.id, group, items))}
      {by.ungrouped.length > 0 && column("none", null, by.ungrouped)}
    </div>
  );
}
