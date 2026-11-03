import type { SidebarItem, SidebarPlace } from "@agenteschat/client";
import { useSetSidebarItem, useSidebarItems } from "@agenteschat/client";
import {
  moveSection,
  SIDEBAR_COUNTED,
  SIDEBAR_ITEMS,
  sameOrder,
  sidebarPlace,
} from "@agenteschat/client/lib/sidebar-items";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  type IconName,
  Segmented,
  type SegmentedOption,
} from "@agenteschat/ui";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "./org-context";
import { SHOWN_SECTIONS, sectionName, useSectionOrder } from "./SidebarOrder";

/** The tools at the top of the sidebar: the page each opens and its icon. */
export const SIDEBAR_TOOLS = {
  approvals: { to: "/org/$orgId/approvals", icon: "waiting" },
  threads: { to: "/org/$orgId/threads", icon: "thread" },
  issues: { to: "/org/$orgId/issues", icon: "issues" },
  wiki: { to: "/org/$orgId/wiki", icon: "book" },
  drive: { to: "/org/$orgId/drive", icon: "drive" },
  routines: { to: "/org/$orgId/routines", icon: "routines" },
  calendar: { to: "/org/$orgId/calendar", icon: "calendar" },
  forum: { to: "/org/$orgId/forum", icon: "message" },
} as const satisfies Record<SidebarItem, { to: string; icon: IconName }>;

/**
 * "Personalizar a barra lateral", from More: one line per tool and where it goes, Sempre, Em Mais or, for a tool with
 * a count, Quando tiver algo. A choice applies at once (no Save) and is kept on the server for this person in this
 * workspace, so their other devices and the desktop app show the same sidebar.
 */
export function SidebarSetupDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const { data: items, refetch } = useSidebarItems(org.id);
  const save = useSetSidebarItem(org.id);
  const sections = useSectionOrder(org.id);
  // What another device changed since this one loaded shows as the dialog opens.
  useEffect(() => {
    if (open) void refetch();
  }, [open, refetch]);
  const options = (id: SidebarItem): SegmentedOption<SidebarPlace>[] => [
    { value: "always", label: t("shell.sidebarSetup.always") },
    { value: "more", label: t("shell.sidebarSetup.more") },
    ...(SIDEBAR_COUNTED.includes(id)
      ? [{ value: "auto" as const, label: t("shell.sidebarSetup.auto"), title: t("shell.sidebarSetup.autoHint") }]
      : []),
  ];
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title={t("shell.customizeSidebar")}
      description={t("shell.sidebarSetup.description")}
      closeLabel={t("common.close")}
      width={520}
    >
      <DialogBody>
        <ul className="sidebar-setup">
          {SIDEBAR_ITEMS.map((id) => (
            <li key={id} className="sidebar-setup__row">
              <span className="settings-row__icon" aria-hidden="true">
                <Icon name={SIDEBAR_TOOLS[id].icon} size={16} />
              </span>
              <span className="sidebar-setup__name">{t(`shell.${id}`)}</span>
              <Segmented
                size="sm"
                label={t(`shell.${id}`)}
                value={sidebarPlace(items, id)}
                onValueChange={(place) => save.mutate({ item: id, place })}
                options={options(id)}
              />
            </li>
          ))}
        </ul>
        <h3 className="sidebar-setup__heading">{t("shell.sidebarSetup.order")}</h3>
        <p className="small muted sidebar-setup__hint">{t("shell.sidebarSetup.orderHint")}</p>
        <ol className="sidebar-setup sidebar-setup--order">
          {sections.order.map((id, i) => (
            <li key={id} className="sidebar-setup__row" data-section={id}>
              <span className="settings-row__icon ac-num" aria-hidden="true">
                {i + 1}
              </span>
              <span className="sidebar-setup__name">{sectionName(t, id)}</span>
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon="chevronUp"
                aria-label={`${t("contextMenu.moveUp")}: ${sectionName(t, id)}`}
                disabled={i === 0}
                onClick={() => sections.put(moveSection(sections.order, id, -1))}
              />
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon="chevronDown"
                aria-label={`${t("contextMenu.moveDown")}: ${sectionName(t, id)}`}
                disabled={i === sections.order.length - 1}
                onClick={() => sections.put(moveSection(sections.order, id, 1))}
              />
            </li>
          ))}
        </ol>
      </DialogBody>
      <DialogFooter note={t("shell.sidebarSetup.instant")}>
        <Button
          variant="ghost"
          icon="undo"
          disabled={sameOrder(sections.order, SHOWN_SECTIONS)}
          onClick={() => sections.put(SHOWN_SECTIONS)}
        >
          {t("contextMenu.restoreOrder")}
        </Button>
        <Button
          variant="ghost"
          icon="undo"
          disabled={Object.keys(items ?? {}).length === 0}
          onClick={() => save.mutate(null)}
        >
          {t("shell.sidebarSetup.reset")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
