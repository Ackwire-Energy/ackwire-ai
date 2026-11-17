import type { IssueProject, IssueProjectRef, IssueProjects } from "@agenteschat/client";
import { useIssueProjectAction, useIssueProjects } from "@agenteschat/client";
import {
  NO_PROJECT,
  PROJECT_COLORS,
  PROJECT_NAME_MAX,
  pickableProjects,
  projectFilterRows,
} from "@agenteschat/client/lib/issue-projects";
import {
  Button,
  ColorDot,
  Dialog,
  DialogBody,
  DialogFooter,
  ditherUrl,
  Field,
  FilterChip,
  type FilterOption,
  Input,
  Locked,
} from "@agenteschat/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useFilterCopy } from "@/components/filters";
import { useOrg } from "@/components/org-context";
import "@/components/roles/roles.css";

/** The first color no project wears yet, so a new one stands apart without a choice. */
const freeColor = (projects: IssueProjectRef[]) =>
  PROJECT_COLORS.find((c) => !projects.some((p) => p.color === c)) ?? PROJECT_COLORS[0] ?? "graphite";

/**
 * "Novo projeto" and "Editar projeto": a name and one of the roles' colors. Mounted while open. `onDone` gets the
 * project as saved, so whoever opened it from a task's field can put the task in it.
 */
export function ProjectDialog({
  project,
  onClose,
  onDone,
}: {
  /** The project to edit. None: a new one. */
  project?: IssueProjectRef;
  onClose: () => void;
  onDone?: (project: IssueProjectRef) => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useIssueProjectAction(org.id);
  const projects = useIssueProjects(org.id).data?.projects ?? [];
  const [name, setName] = useState(project?.name ?? "");
  const [picked, setPicked] = useState<string | null>(project?.color ?? null);
  const color = picked ?? freeColor(projects);
  const save = () => {
    const value = name.trim();
    if (!value || action.isPending) return;
    if (project && value === project.name && color === project.color) return onClose();
    action.mutate(
      project ? { type: "update", projectId: project.id, name: value, color } : { type: "create", name: value, color },
      {
        onSuccess: (saved) => {
          if (saved) onDone?.(saved);
          onClose();
        },
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t(project ? "issues.projects.edit" : "issues.projects.new")}
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
        <Locked when={action.isPending}>
          <DialogBody>
            <Field label={t("rolesPage.name")} id="issue-project-name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={PROJECT_NAME_MAX}
                autoComplete="off"
                autoFocus
              />
            </Field>
            <div className="roles-colors" role="radiogroup" aria-label={t("rolesPage.color")}>
              {PROJECT_COLORS.map((c) => (
                // biome-ignore lint/a11y/useSemanticElements: a swatch button in a radio group
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={color === c}
                  aria-label={t("rolesPage.colorOf", { color: c })}
                  className="roles-color"
                  style={{ backgroundImage: `url("${ditherUrl(c, 8)}")` }}
                  onClick={() => setPicked(c)}
                />
              ))}
            </div>
          </DialogBody>
        </Locked>
        <DialogFooter>
          <Button type="button" onClick={onClose} disabled={action.isPending}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={!name.trim() || action.isPending}
            loading={action.isPending}
          >
            {project ? t("common.save") : t("issues.projects.create")}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** "Excluir o projeto X?": its tasks stay, with no project. Mounted while open. */
export function DeleteProjectDialog({
  project,
  onClose,
  onDeleted,
}: {
  project: IssueProjectRef;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const action = useIssueProjectAction(org.id);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !action.isPending && onClose()}
      title={t("issues.projects.deleteTitle", { name: project.name })}
      description={t("issues.projects.deleteBody")}
      closeLabel={t("common.close")}
      width={440}
    >
      <DialogFooter>
        <Button type="button" onClick={onClose} disabled={action.isPending}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          loading={action.isPending}
          disabled={action.isPending}
          onClick={() =>
            action.mutate(
              { type: "delete", projectId: project.id },
              {
                onSuccess: () => {
                  onDeleted();
                  onClose();
                },
              },
            )
          }
        >
          {t("issues.projects.delete")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * The toolbar's "Projeto" chip, which is the whole projects list: each project with its color and its open tasks,
 * "Sem projeto", the archived ones under their own heading, and "Novo projeto" for who may create one. Picking one
 * opens its board. With one picked the chip wears its dot and name, and × goes back to every task.
 */
export function ProjectChip({
  data,
  value,
  onChange,
  onNew,
}: {
  data: IssueProjects | undefined;
  /** A project's id, `none`, or nothing. */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  /** Who may create tasks: "Novo projeto" at the menu's end. */
  onNew?: () => void;
}) {
  const { t } = useTranslation();
  const copy = useFilterCopy();
  const projects = data?.projects ?? [];
  const row = (p: IssueProject | null): FilterOption =>
    p
      ? {
          value: p.id,
          label: p.name,
          leading: <ColorDot color={p.color} />,
          count: p.open,
          ...(p.archived ? { group: t("issues.projects.archived") } : {}),
        }
      : { value: NO_PROJECT, label: t("issues.projects.none"), leading: <ColorDot />, count: data?.unfiled ?? 0 };
  // Before the first project there is nothing to filter by: the menu is "Novo projeto" alone, and who can't make one
  // has no chip.
  if (projects.length === 0 && !onNew) return null;
  const options = projects.length === 0 ? [] : projectFilterRows(projects).map(row);
  return (
    <FilterChip
      label={t("issues.projects.label")}
      icon="layers"
      options={options}
      value={value ? [value] : []}
      onChange={(next) => onChange(next[0])}
      valueText={(o) => o.label}
      valueLeading
      clearLabel={copy.clearOf(t("issues.projects.label"))}
      searchLabel={t("issues.projects.label")}
      action={onNew && { label: t("issues.projects.new"), icon: "plus", onSelect: onNew }}
    />
  );
}

/** In a task's project select: opens "Novo projeto" instead of choosing. */
export const NEW_PROJECT = "new";

/** What a task's "Projeto" select offers: the projects in use (and the task's own, even archived), none, a new one. */
export function useProjectOptions(current: IssueProjectRef | null | undefined, mayCreate: boolean) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const projects = useIssueProjects(org.id).data?.projects ?? (current ? [{ ...current, open: 0 }] : []);
  return [
    ...pickableProjects(projects, current).map((p) => ({
      value: p.id,
      label: p.name,
      leading: <ColorDot color={p.color} />,
    })),
    { value: NO_PROJECT, label: t("issues.projects.none"), leading: <ColorDot /> },
    ...(mayCreate ? [{ value: NEW_PROJECT, label: t("issues.projects.new"), action: true }] : []),
  ];
}
