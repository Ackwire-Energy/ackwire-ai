import type { SidebarSection } from "@agenteschat/client";
import { useSetSidebarOrder, useSidebarOrder } from "@agenteschat/client";
import { moveSection, SIDEBAR_SECTIONS, sameOrder } from "@agenteschat/client/lib/sidebar-items";
import { Icon } from "@agenteschat/ui";
import type { TFunction } from "i18next";
import { type DragEvent, type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type MenuEntry, openContextMenu } from "@/lib/context-menu";

/** A section's name as its header (or, for the tools, the dialog) says it. */
export const sectionName = (t: TFunction, id: SidebarSection) =>
  id === "tools"
    ? t("shell.sidebarSetup.tools")
    : id === "channels"
      ? t("shell.channels")
      : id === "agents"
        ? t("shell.agents")
        : t("shell.directMessages");

const SECTION_DRAG = "application/x-agentes-section";

/**
 * The order of the sidebar's sections, the person's own in this workspace (`…/me/sidebar/order`): Mover para cima /
 * para baixo and Restaurar ordem padrão for a section's menus, and dragging a section by its grip.
 */
export function useSectionOrder(orgId: string) {
  const { t } = useTranslation();
  const order = useSidebarOrder(orgId);
  const save = useSetSidebarOrder(orgId);
  const dragging = useRef<SidebarSection | null>(null);
  const [mark, setMark] = useState<{ id: SidebarSection; where: "before" | "after" } | null>(null);
  const put = (next: SidebarSection[]) => {
    if (!sameOrder(next, order)) save.mutate(sameOrder(next, SIDEBAR_SECTIONS) ? null : next);
  };

  const entries = (id: SidebarSection): MenuEntry[] => {
    const i = order.indexOf(id);
    return [
      {
        kind: "item",
        id: "move-up",
        label: t("contextMenu.moveUp"),
        icon: "chevronUp",
        disabled: i <= 0,
        run: () => put(moveSection(order, id, -1)),
      },
      {
        kind: "item",
        id: "move-down",
        label: t("contextMenu.moveDown"),
        icon: "chevronDown",
        disabled: i >= order.length - 1,
        run: () => put(moveSection(order, id, 1)),
      },
      {
        kind: "item",
        id: "restore-order",
        label: t("contextMenu.restoreOrder"),
        icon: "undo",
        disabled: sameOrder(order, SIDEBAR_SECTIONS),
        run: () => put([...SIDEBAR_SECTIONS]),
      },
    ];
  };

  const end = () => {
    dragging.current = null;
    setMark(null);
  };
  /** A section's own box: it takes a dragged section before or after it. */
  const block = (id: SidebarSection, children: ReactNode, grip = true) => (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target for a dragged section; the grip's menu and the headers' menus are the keyboard way
    <div
      key={id}
      className="sidebar__block"
      data-section={id}
      data-drop={mark?.id === id ? mark.where : undefined}
      onDragOver={(e: DragEvent) => {
        const from = dragging.current;
        if (!from || from === id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const r = e.currentTarget.getBoundingClientRect();
        const where = e.clientY > r.top + r.height / 2 ? "after" : "before";
        if (mark?.id !== id || mark.where !== where) setMark({ id, where });
      }}
      onDrop={(e: DragEvent) => {
        const from = dragging.current;
        const m = mark;
        end();
        if (!from || !m) return;
        e.preventDefault();
        const rest = order.filter((s) => s !== from);
        rest.splice(rest.indexOf(m.id) + (m.where === "after" ? 1 : 0), 0, from);
        put(rest);
      }}
    >
      {grip && (
        <button
          type="button"
          className="sidebar__grip"
          draggable
          aria-label={t("shell.sidebarSetup.drag", { name: sectionName(t, id) })}
          title={t("shell.sidebarSetup.drag", { name: sectionName(t, id) })}
          onDragStart={(e) => {
            dragging.current = id;
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData(SECTION_DRAG, id);
            const box = e.currentTarget.parentElement;
            if (box) e.dataTransfer.setDragImage(box, 12, 12);
          }}
          onDragEnd={end}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openContextMenu(r.right, r.bottom, [{ kind: "header", label: sectionName(t, id) }, ...entries(id)]);
          }}
        >
          <Icon name="grip" size={14} />
        </button>
      )}
      {children}
    </div>
  );

  return { order, entries, block, put };
}
