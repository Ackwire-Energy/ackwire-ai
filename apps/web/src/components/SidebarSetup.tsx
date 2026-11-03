import type { SidebarItem, SidebarPlace } from "@agenteschat/client";
import { useSetSidebarItem, useSetSidebarToolOrder, useSidebarItems, useSidebarToolOrder } from "@agenteschat/client";
import {
  moveSection,
  moveShownTool,
  placeTool,
  SIDEBAR_COUNTED,
  SIDEBAR_ITEMS,
  SIDEBAR_SECTIONS,
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
import {
  cloneElement,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useOrg } from "./org-context";
import { sectionName, useSectionOrder } from "./SidebarOrder";

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

/** The person's order of the tools in this workspace (`…/me/sidebar/tools`), saved as `null` when it is the default. */
function useToolOrder(orgId: string) {
  const order = useSidebarToolOrder(orgId);
  const save = useSetSidebarToolOrder(orgId);
  const put = (next: SidebarItem[]) => {
    if (!sameOrder(next, order)) save.mutate(sameOrder(next, SIDEBAR_ITEMS) ? null : next);
  };
  return { order, put };
}

const TOOL_DRAG = "application/x-agentes-tool";
const MOVE_KEYS = "Alt+Shift+ArrowUp Alt+Shift+ArrowDown";

/**
 * The tools shown in the sidebar's list, in the person's order: each dragged onto another goes before or after it,
 * and Alt+Shift+↑/↓ on a focused one moves it past its neighbour (the setup dialog's arrows do it too). The rows stay
 * the links `row` makes, so the browser's own menu on them is kept.
 */
export function ToolList({ items, row }: { items: SidebarItem[]; row: (id: SidebarItem) => ReactElement }) {
  const { org } = useOrg();
  const { order, put } = useToolOrder(org.id);
  const dragging = useRef<SidebarItem | null>(null);
  const [mark, setMark] = useState<{ id: SidebarItem; where: "before" | "after" } | null>(null);
  const shown = order.filter((id) => items.includes(id));
  const end = () => {
    dragging.current = null;
    setMark(null);
  };
  return shown.map((id) =>
    cloneElement(row(id) as ReactElement<Record<string, unknown>>, {
      draggable: true,
      "aria-keyshortcuts": MOVE_KEYS,
      "data-drop": mark?.id === id ? mark.where : undefined,
      onKeyDown: (e: KeyboardEvent) => {
        if (!e.altKey || !e.shiftKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
        e.preventDefault();
        put(moveShownTool(order, shown, id, e.key === "ArrowUp" ? -1 : 1));
      },
      onDragStart: (e: DragEvent) => {
        dragging.current = id;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(TOOL_DRAG, id);
      },
      onDragOver: (e: DragEvent) => {
        const from = dragging.current;
        if (!from || from === id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const r = e.currentTarget.getBoundingClientRect();
        const where = e.clientY > r.top + r.height / 2 ? "after" : "before";
        if (mark?.id !== id || mark.where !== where) setMark({ id, where });
      },
      onDrop: (e: DragEvent) => {
        const from = dragging.current;
        const m = mark;
        end();
        if (!from || !m) return;
        e.preventDefault();
        put(placeTool(order, from, m.id, m.where));
      },
      onDragEnd: end,
    }),
  );
}

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
  const tools = useToolOrder(org.id);
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
          {tools.order.map((id, i) => (
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
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon="chevronUp"
                aria-label={`${t("contextMenu.moveUp")}: ${t(`shell.${id}`)}`}
                disabled={i === 0}
                onClick={() => tools.put(moveSection(tools.order, id, -1))}
              />
              <Button
                size="sm"
                variant="ghost"
                iconOnly
                icon="chevronDown"
                aria-label={`${t("contextMenu.moveDown")}: ${t(`shell.${id}`)}`}
                disabled={i === tools.order.length - 1}
                onClick={() => tools.put(moveSection(tools.order, id, 1))}
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
          disabled={sameOrder(sections.order, SIDEBAR_SECTIONS)}
          onClick={() => sections.put([...SIDEBAR_SECTIONS])}
        >
          {t("contextMenu.restoreOrder")}
        </Button>
        <Button
          variant="ghost"
          icon="undo"
          disabled={Object.keys(items ?? {}).length === 0 && sameOrder(tools.order, SIDEBAR_ITEMS)}
          onClick={() => {
            save.mutate(null);
            tools.put([...SIDEBAR_ITEMS]);
          }}
        >
          {t("shell.sidebarSetup.reset")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
