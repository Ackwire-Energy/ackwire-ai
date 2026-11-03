import type { Agent, AgentGroup } from "@agenteschat/client";
import { useAgentGroups } from "@agenteschat/client";
import { agentSections } from "@agenteschat/client/lib/agent-groups";
import { listsAgent } from "@agenteschat/client/lib/audience";
import { can } from "@agenteschat/client/lib/permissions";
import { Button, Card, Icon } from "@agenteschat/ui";
import { Link } from "@tanstack/react-router";
import { Fragment, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDirectory } from "@/hooks/useDirectory";
import { AgentAvatar } from "./AgentAvatar";
import {
  AgentGroupMenu,
  DeleteGroupDialog,
  type GroupDialogFor,
  GroupMenu,
  GroupNameDialog,
  useAgentDrag,
} from "./AgentGroups";
import { useOrg } from "./org-context";

/**
 * Equipe's "Grupos de agentes" (ADR 0083): owners and admins make, rename, order and delete groups and move agents
 * between them (row menu or drag); everyone else reads the groups that hold an agent they see. The agents in no
 * group are under "Agentes", for who arranges.
 */
export function TeamGroups() {
  const { t } = useTranslation();
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  const groups = useAgentGroups(org.id).data ?? [];
  const arranges = can(org, "manage_agents");
  const byGroup = agentSections(
    dir.agents.filter((a) => listsAgent(org, a)),
    groups,
    (a) => a.id,
  );
  const shown = arranges ? byGroup.groups : byGroup.groups.filter((g) => g.items.length > 0);
  const drag = useAgentDrag(groups);
  const [dialog, setDialog] = useState<GroupDialogFor | null>(null);
  const [deleting, setDeleting] = useState<AgentGroup | null>(null);
  if (dir.agents.length === 0 || (!arranges && shown.length === 0)) return null;

  const row = (a: Agent) => (
    <div key={a.id} className="member-row" data-agent-row={a.id}>
      <Link
        to="/org/$orgId/agents/$agentId"
        params={{ orgId: org.id, agentId: a.id }}
        className="team-groups__agent"
        {...(arranges ? drag.row(a.id) : {})}
      >
        <AgentAvatar agentId={a.id} name={a.name} size="sm" />
        <span className="list-col">
          <b>{a.name}</b>
          {a.role && <span className="small muted">{a.role}</span>}
        </span>
      </Link>
      {arranges && (
        <AgentGroupMenu agent={a} groups={groups} onNewGroup={() => setDialog({ mode: "create", agentIds: [a.id] })} />
      )}
    </div>
  );
  const block = (key: string, title: string, groupId: string | null, items: Agent[], action?: ReactNode) => {
    // Where a dragged row would land: a line before the row at that place among the others.
    const others = items.filter((a) => a.id !== drag.dragging);
    const lineAt = groupId !== null && drag.over?.groupId === groupId ? drag.over.index : null;
    const line = <span className="sidebar__drop-line" aria-hidden="true" />;
    return (
      <section key={key} className="team-groups__group" aria-label={title} {...(arranges ? drag.zone(groupId) : {})}>
        <div className="team-groups__head">
          <h3>{title}</h3>
          {action}
        </div>
        {items.map((a) => (
          <Fragment key={a.id}>
            {lineAt === others.indexOf(a) && line}
            {row(a)}
          </Fragment>
        ))}
        {lineAt !== null && lineAt >= others.length && line}
        {arranges && groupId !== null && items.length === 0 && (
          <span className="sidebar__drop-hint">{t("agentGroups.dropHere")}</span>
        )}
      </section>
    );
  };

  return (
    <Card className="team-groups">
      <div className="team-feed__head">
        <Icon name="layers" size={16} />
        <h2>{t("team.groups.title")}</h2>
        {arranges && (
          <Button size="sm" variant="ghost" icon="plus" onClick={() => setDialog({ mode: "create" })}>
            {t("agentGroups.newGroup")}
          </Button>
        )}
      </div>
      {arranges && block("none", t("shell.agents"), null, byGroup.ungrouped)}
      {shown.map(({ group, items }, i) =>
        block(
          group.id,
          group.name,
          group.id,
          items,
          arranges && (
            <GroupMenu
              group={group}
              index={i}
              count={shown.length}
              onRename={() => setDialog({ mode: "rename", group })}
              onDelete={() => setDeleting(group)}
            />
          ),
        ),
      )}
      {dialog && <GroupNameDialog purpose={dialog} onClose={() => setDialog(null)} />}
      {deleting && <DeleteGroupDialog group={deleting} onClose={() => setDeleting(null)} />}
    </Card>
  );
}
