import type { AgentGroup, Team, TeamAgent } from "@agenteschat/client";
import { useAgentGroupAction, useRoutines } from "@agenteschat/client";
import { setDraftFor } from "@agenteschat/client/lib/drafts";
import { errorText } from "@agenteschat/client/lib/errors";
import { can } from "@agenteschat/client/lib/permissions";
import { sectorGap, sectorReach } from "@agenteschat/client/lib/team-views";
import { AvatarStack, Button, Card, EmptyState, Icon, Select } from "@agenteschat/ui";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar, PersonAvatar } from "@/components/AgentAvatar";
import {
  DeleteGroupDialog,
  type GroupDialogFor,
  GroupMenu,
  GroupNameDialog,
  useAgentDrag,
} from "@/components/AgentGroups";
import { useOrg } from "@/components/org-context";
import { colorOf } from "@/components/Sky";
import { useToast } from "@/lib/toast";
import { useWhen } from "@/pages/RoutinesPage";
import { ChannelName, SectorMark, sectorStyle, useTeamLookups } from "./shared";

const NOBODY = "none";
/** Routines listed on a setor's card before "and N more". */
const CARD_ROUTINES = 3;

/**
 * Equipe › Setores (ADR 0148): the agent groups (ADR 0083) as setores, one card each: who leads it and who covers,
 * its agents, the people around them, the channels they are in and their routines. Who manages agents creates,
 * edits, orders and deletes them, picks the lead and the substitute, and drags agents between cards. The sidebar's
 * AGENTES sections are the same groups.
 */
export function TeamSectors({ team, groups }: { team: Team; groups: AgentGroup[] }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const look = useTeamLookups(groups);
  const arranges = can(org, "manage_agents");
  const drag = useAgentDrag(groups);
  const [dialog, setDialog] = useState<GroupDialogFor | null>(null);
  const [deleting, setDeleting] = useState<AgentGroup | null>(null);
  const agents = team.agents.filter((a) => !look.isLodi(a));
  const placed = new Set(groups.flatMap((g) => g.agentIds));
  const outside = agents.filter((a) => !placed.has(a.id));
  const ask = () => {
    if (!look.lodi) return;
    setDraftFor(`agent:${look.lodi.id}`, t("team.sectors.askText"));
    void navigate({ to: "/org/$orgId/dm/agent/$agentId", params: { orgId: org.id, agentId: look.lodi.id } });
  };
  const actions = (
    <div className="row team-sectors__acts">
      {look.lodi && (
        <Button icon="message" onClick={ask}>
          {t("team.sectors.ask", { name: look.lodi.name })}
        </Button>
      )}
      {arranges && (
        <Button variant="primary" icon="plus" onClick={() => setDialog({ mode: "create" })}>
          {t("agentGroups.newGroup")}
        </Button>
      )}
    </div>
  );
  return (
    <section className="team-sectors" aria-label={t("team.view.sectors")}>
      <div className="team-sectors__bar">
        <span className="muted">{t("team.sectors.lead")}</span>
        {actions}
      </div>
      {groups.length === 0 ? (
        <EmptyState
          title={t("team.sectors.emptyTitle")}
          actions={
            arranges && (
              <Button variant="primary" icon="plus" onClick={() => setDialog({ mode: "create" })}>
                {t("agentGroups.create")}
              </Button>
            )
          }
        >
          {t("team.sectors.empty")}
        </EmptyState>
      ) : (
        <div className="team-sectors__grid">
          {groups.map((g, i) => (
            <SectorCard
              key={g.id}
              group={g}
              team={team}
              groups={groups}
              drag={drag}
              arranges={arranges}
              menu={
                arranges && (
                  <GroupMenu
                    group={g}
                    index={i}
                    count={groups.length}
                    onRename={() => setDialog({ mode: "rename", group: g })}
                    onDelete={() => setDeleting(g)}
                  />
                )
              }
            />
          ))}
          {(outside.length > 0 || arranges) && (
            <Card
              className="team-sector-card"
              data-none=""
              aria-label={t("agentGroups.none")}
              {...(arranges ? drag.zone(null) : {})}
            >
              <header className="team-sector-card__head">
                <Icon name="members" size={20} />
                <span className="team-sector-card__title">
                  <h3>{t("agentGroups.none")}</h3>
                  <span className="muted">{t("team.agents", { count: outside.length })}</span>
                </span>
              </header>
              <AgentChips agents={outside} drag={arranges ? drag : null} />
              {arranges && <p className="muted small">{t("team.sectors.placeHint")}</p>}
            </Card>
          )}
        </div>
      )}
      {dialog && <GroupNameDialog purpose={dialog} onClose={() => setDialog(null)} />}
      {deleting && <DeleteGroupDialog group={deleting} onClose={() => setDeleting(null)} />}
    </section>
  );
}

type Drag = ReturnType<typeof useAgentDrag>;

function AgentChips({ agents, drag }: { agents: TeamAgent[]; drag: Drag | null }) {
  const { org } = useOrg();
  return (
    <span className="team-chips">
      {agents.map((a) => (
        <Link
          key={a.id}
          to="/org/$orgId/agents/$agentId"
          params={{ orgId: org.id, agentId: a.id }}
          className="team-who team-who--chip"
          data-agent-row={a.id}
          {...(drag ? drag.row(a.id) : {})}
        >
          <AgentAvatar agentId={a.id} name={a.name} size="xs" />
          {a.name}
          <span
            className="team-node__dot"
            data-busy={a.busy || undefined}
            style={a.busy ? { background: colorOf(a) } : undefined}
            aria-hidden="true"
          />
        </Link>
      ))}
    </span>
  );
}

function SectorCard({
  group,
  team,
  groups,
  drag,
  arranges,
  menu,
}: {
  group: AgentGroup;
  team: Team;
  groups: AgentGroup[];
  drag: Drag;
  arranges: boolean;
  menu: ReactNode;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const look = useTeamLookups(groups);
  const action = useAgentGroupAction(org.id);
  const toast = useToast();
  const when = useWhen();
  const routines = (useRoutines(org.id).data ?? []).filter((r) => r.active && group.agentIds.includes(r.agentId));
  const reach = sectorReach(group, team.agents);
  const gap = sectorGap(group);
  const people = look.dir.members;
  const pick = (key: "leadUserId" | "backupUserId", value: string) => {
    const id = value === NOBODY ? null : value;
    action.mutate(
      { type: "update", groupId: group.id, ...(key === "leadUserId" ? { leadUserId: id } : { backupUserId: id }) },
      { onError: (e) => toast.show(errorText(t, e), "error") },
    );
  };
  const person = (key: "leadUserId" | "backupUserId") => {
    const id = group[key] ?? null;
    if (arranges)
      return (
        <Select
          size="sm"
          aria-label={t(key === "leadUserId" ? "team.sectors.leadOf" : "team.sectors.backupOf", { name: group.name })}
          value={id ?? NOBODY}
          onValueChange={(v) => pick(key, v)}
          options={[
            { value: NOBODY, label: t("team.sectors.nobody") },
            ...people.map((m) => ({ value: m.userId, label: m.name })),
          ]}
        />
      );
    return id ? (
      <span className="team-who">
        <PersonAvatar id={id} name={look.personName(id)} size="xs" />
        {look.personName(id)}
      </span>
    ) : (
      <span className="team-gap">{t("team.sectors.nobody")}</span>
    );
  };
  const channels = reach.channelIds.flatMap((id) => look.channelById.get(id) ?? []);
  return (
    <Card
      className="team-sector-card"
      style={sectorStyle(group)}
      aria-label={group.name}
      {...(arranges ? drag.zone(group.id) : {})}
    >
      <header className="team-sector-card__head">
        <SectorMark group={group} size={32} />
        <span className="team-sector-card__title">
          <h3>{group.name}</h3>
          <span className="muted">
            {t("team.people", { count: reach.people.length })} · {t("team.agents", { count: reach.agents.length })}
          </span>
        </span>
        {menu}
      </header>
      <dl className="team-sector-card__rows">
        <dt>{t("team.sectors.leadLabel")}</dt>
        <dd className="team-sector-card__people">
          {person("leadUserId")}
          <span className="muted">{t("team.sectors.backupLabel")}</span>
          {person("backupUserId")}
        </dd>
        <dt>{t("team.list.agents")}</dt>
        <dd>
          {reach.agents.length > 0 ? (
            <AgentChips agents={reach.agents} drag={arranges ? drag : null} />
          ) : (
            <span className="muted">{arranges ? t("agentGroups.dropHere") : t("team.sectors.none")}</span>
          )}
        </dd>
        <dt>{t("team.list.people")}</dt>
        <dd>
          {reach.people.length > 0 ? (
            <span className="team-who">
              <AvatarStack>
                {reach.people.slice(0, 5).map((id) => (
                  <span key={id} title={look.personName(id)}>
                    <PersonAvatar id={id} name={look.personName(id)} size="xs" />
                  </span>
                ))}
              </AvatarStack>
              {reach.people.map((id) => look.personName(id)).join(", ")}
            </span>
          ) : (
            <span className="muted">{t("team.sectors.none")}</span>
          )}
        </dd>
        <dt>{t("team.sectors.channels")}</dt>
        <dd>
          {channels.length > 0 ? (
            <span className="team-chips">
              {channels.map((c) => (
                <Link
                  key={c.id}
                  to="/org/$orgId/c/$channelId"
                  params={{ orgId: org.id, channelId: c.id }}
                  className="team-chip"
                >
                  <ChannelName name={c.name} private={c.visibility === "private"} />
                </Link>
              ))}
            </span>
          ) : (
            <span className="muted">{t("team.sectors.none")}</span>
          )}
        </dd>
        <dt>{t("team.sectors.routines")}</dt>
        <dd>
          {routines.length > 0 ? (
            <ul className="team-map__facts">
              {routines.slice(0, CARD_ROUTINES).map((r) => (
                <li key={r.id}>
                  <Icon name="routines" size={14} />
                  <span>
                    {r.name} · {when(r)}
                  </span>
                </li>
              ))}
              {routines.length > CARD_ROUTINES && (
                <li className="muted">{t("team.map.moreRoutines", { count: routines.length - CARD_ROUTINES })}</li>
              )}
            </ul>
          ) : (
            <span className="muted">{t("team.sectors.none")}</span>
          )}
        </dd>
      </dl>
      {gap && (
        <p className="team-sector-card__gap">
          <span className="team-sector-card__gap-dot" aria-hidden="true" />
          {t(`team.sectors.gap.${gap}`)}
        </p>
      )}
    </Card>
  );
}
