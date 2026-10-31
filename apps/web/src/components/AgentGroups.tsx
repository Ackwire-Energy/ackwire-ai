import type { Agent, AgentGroup } from "@agenteschat/client";
import { useAgentGroupAction } from "@agenteschat/client";
import { groupOf, NO_GROUP } from "@agenteschat/client/lib/agent-groups";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Field,
  Input,
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuSeparator,
} from "@agenteschat/ui";
import { type DragEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "./org-context";

/** What the sidebar's group dialog is for: a new group (with these agents in it), or renaming one. */
export type GroupDialogFor = { mode: "create"; agentIds?: string[] } | { mode: "rename"; group: AgentGroup };

/** "Novo grupo" and "Renomear grupo": a name, nothing else. Mounted while open. */
export function GroupNameDialog({ purpose, onClose }: { purpose: GroupDialogFor; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useAgentGroupAction(org.id);
  const renaming = purpose.mode === "rename" ? purpose.group : null;
  const [name, setName] = useState(renaming?.name ?? "");
  const save = () => {
    const value = name.trim();
    if (!value) return;
    if (renaming && value === renaming.name) return onClose();
    action.mutate(
      renaming
        ? { type: "update", groupId: renaming.id, name: value }
        : { type: "create", name: value, agentIds: purpose.mode === "create" ? purpose.agentIds : undefined },
      { onSuccess: onClose },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={renaming ? t("agentGroups.renameTitle") : t("agentGroups.newGroup")}
      closeLabel={t("common.close")}
      width={440}
    >
      <form
        style={{ display: "contents" }}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <DialogBody>
          <Field label={t("agentGroups.nameLabel")} id="agent-group-name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              autoComplete="off"
              autoFocus
              placeholder={t("agentGroups.namePlaceholder")}
            />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!name.trim() || action.isPending}
            loading={action.isPending}
          >
            {renaming ? t("common.save") : t("agentGroups.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** "Excluir o grupo X?": its agents go back to Agentes. Mounted while open. */
export function DeleteGroupDialog({ group, onClose }: { group: AgentGroup; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useAgentGroupAction(org.id);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("agentGroups.deleteTitle", { name: group.name })}
      description={group.agentIds.length > 0 ? t("agentGroups.deleteText") : undefined}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button type="button" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          loading={action.isPending}
          onClick={() => action.mutate({ type: "remove", groupId: group.id }, { onSuccess: onClose })}
        >
          {t("agentGroups.delete")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** A group header's "…" (owners and admins): rename, move among the groups, delete. */
export function GroupMenu({
  group,
  index,
  count,
  onRename,
  onDelete,
}: {
  group: AgentGroup;
  index: number;
  count: number;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useAgentGroupAction(org.id);
  const label = t("agentGroups.options", { name: group.name });
  const move = (to: number) => action.mutate({ type: "update", groupId: group.id, index: to });
  return (
    <Menu
      align="end"
      label={label}
      trigger={
        <Button variant="ghost" size="sm" iconOnly icon="more" className="sidebar__section-add" aria-label={label} />
      }
    >
      <MenuItem icon="edit" onSelect={onRename}>
        {t("agentGroups.rename")}
      </MenuItem>
      {count > 1 && (
        <>
          <MenuItem icon="chevronUp" disabled={index === 0} onSelect={() => move(index - 1)}>
            {t("agentGroups.moveUp")}
          </MenuItem>
          <MenuItem icon="chevronDown" disabled={index === count - 1} onSelect={() => move(index + 1)}>
            {t("agentGroups.moveDown")}
          </MenuItem>
        </>
      )}
      <MenuSeparator />
      <MenuItem icon="trash" danger onSelect={onDelete}>
        {t("agentGroups.delete")}
      </MenuItem>
    </Menu>
  );
}

/** An agent row's "…" (owners and admins): its group, a new group with it, its place inside its group. */
export function AgentGroupMenu({
  agent,
  groups,
  onNewGroup,
}: {
  agent: Agent;
  groups: AgentGroup[];
  onNewGroup: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useAgentGroupAction(org.id);
  const current = groupOf(groups, agent.id);
  const at = current ? current.agentIds.indexOf(agent.id) : -1;
  const label = t("agentGroups.options", { name: agent.name });
  const moveTo = (groupId: string | null, index?: number) =>
    action.mutate({ type: "move", agentId: agent.id, groupId, index });
  return (
    <Menu
      align="end"
      label={label}
      trigger={
        <Button variant="ghost" size="sm" iconOnly icon="more" className="sidebar__row-menu" aria-label={label} />
      }
    >
      <MenuRadioGroup
        label={t("agentGroups.group")}
        value={current?.id ?? NO_GROUP}
        onValueChange={(v) => {
          if (v !== (current?.id ?? NO_GROUP)) moveTo(v === NO_GROUP ? null : v);
        }}
        options={[
          { value: NO_GROUP, label: t("agentGroups.none") },
          ...groups.map((g) => ({ value: g.id, label: g.name })),
        ]}
      />
      <MenuItem icon="plus" onSelect={onNewGroup}>
        {t("agentGroups.newFromAgent")}
      </MenuItem>
      {current && current.agentIds.length > 1 && (
        <>
          <MenuSeparator />
          <MenuItem icon="chevronUp" disabled={at <= 0} onSelect={() => moveTo(current.id, at - 1)}>
            {t("agentGroups.moveUp")}
          </MenuItem>
          <MenuItem
            icon="chevronDown"
            disabled={at >= current.agentIds.length - 1}
            onSelect={() => moveTo(current.id, at + 1)}
          >
            {t("agentGroups.moveDown")}
          </MenuItem>
        </>
      )}
    </Menu>
  );
}

/** Firefox starts a drag only with some data set. */
const AGENT_DRAG = "application/x-agentes-agent";

/**
 * Dragging agents between the sidebar's sections (owners and admins): rows are draggable, sections take the drop.
 * Inside a group the row lands where the pointer is (`over.index`, before the first row whose middle is below it);
 * the agents in no group keep the workspace's order.
 */
export function useAgentDrag(groups: AgentGroup[]) {
  const { org } = useOrg();
  const action = useAgentGroupAction(org.id);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ groupId: string | null; index: number } | null>(null);
  const indexAt = (e: DragEvent<HTMLElement>) => {
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>("[data-agent-row]")].filter(
      (el) => el.dataset.agentRow !== dragging,
    );
    const k = rows.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    return k < 0 ? rows.length : k;
  };
  const end = () => {
    setDragging(null);
    setOver(null);
  };
  return {
    dragging,
    over,
    row: (agentId: string) => ({
      draggable: true,
      onDragStart: (e: DragEvent<HTMLElement>) => {
        e.dataTransfer.setData(AGENT_DRAG, agentId);
        e.dataTransfer.effectAllowed = "move";
        setDragging(agentId);
      },
      onDragEnd: end,
    }),
    zone: (groupId: string | null) => ({
      "data-drop": over?.groupId === groupId || undefined,
      onDragOver: (e: DragEvent<HTMLElement>) => {
        if (!dragging) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const index = groupId ? indexAt(e) : 0;
        if (over?.groupId !== groupId || over.index !== index) setOver({ groupId, index });
      },
      onDragLeave: (e: DragEvent<HTMLElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setOver((o) => (o?.groupId === groupId ? null : o));
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        if (!dragging) return;
        e.preventDefault();
        const agentId = dragging;
        const index = groupId ? indexAt(e) : undefined;
        end();
        const from = groupOf(groups, agentId);
        if ((from?.id ?? null) === groupId && (groupId === null || from?.agentIds.indexOf(agentId) === index)) return;
        action.mutate({ type: "move", agentId, groupId, index });
      },
    }),
  };
}
