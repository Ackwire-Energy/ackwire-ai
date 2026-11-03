import type { Dashboard, Widget } from "@agenteschat/client";
import {
  type BoardItem,
  boardItems,
  layoutOf,
  moveItem,
  resizeItem,
  useRefreshWidget,
  useRemoveWidget,
  useSaveLayout,
} from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { Button, Card, cx, Icon, Menu, MenuItem, MenuSeparator, WidgetAddTile, WidgetCard } from "@agenteschat/ui";
import { layoutToSize, nextSize, sizeToLayout } from "@agenteschat/ui/widgets/spec";
import { type DragEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNow } from "@/hooks/useNow";
import { useToast } from "@/lib/toast";
import { useWidgetAgent, WidgetFoot } from "./parts";
import "./widgets.css";

/** A fixed tile's controls in Organize: it moves (dragged, or by the grip's arrow keys) but keeps its size. */
export interface TileOrganize {
  onMove: (delta: -1 | 1) => void;
}

/** A fixed tile of a home board: what it shows, or a function of Organize (null outside it) that draws it. */
export type BoardTileSlot = ReactNode | ((organize: TileOrganize | null) => ReactNode);

export interface WidgetBoardProps {
  orgId: string;
  board: Dashboard;
  /** "Organize": drag to reorder, cycle the size, remove. */
  arranging: boolean;
  /** Home's fixed tiles ("Waiting on you", "Working now"), placed by the board's `tiles`. */
  tiles?: Partial<Record<"waiting" | "working", BoardTileSlot>>;
  onAdd: () => void;
  onOpen: (widgetId: string) => void;
  /** "Change when it updates" (else it opens the widget, whose panel changes it). */
  onChangeSchedule?: (widgetId: string) => void;
}

/**
 * A board's grid (ADR 0134): 4 columns, each widget S (1×1), M (2×1) or L (2×2), a home board's fixed tiles among
 * them, and "+ Widget" last. Each card has Update now and its menu (Open, Update now, Ask for a change, Change when
 * it updates, Remove), a failure's Resolve, and in Organize: drag (or the grip's arrow keys) to reorder, the size
 * button, remove. Every change is saved at once (`useSaveLayout`, optimistic).
 */
export function WidgetBoard({ orgId, board, arranging, tiles, onAdd, onOpen, onChangeSchedule }: WidgetBoardProps) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const save = useSaveLayout(orgId);
  const remove = useRemoveWidget(orgId);
  const now = useNow(60_000);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const items = boardItems(board.widgets, board.kind === "home" ? board.tiles.filter((x) => tiles?.[x.key]) : []);
  const fresh = useArrivals(board.widgets);
  const editable = board.canEdit;
  const organizing = arranging && editable;

  const commit = (next: BoardItem[]) =>
    save.mutate(
      { dashboardId: board.id, home: board.kind === "home", ...layoutOf(next) },
      { onError: (e) => toast.show(errorText(t, e, i18n.language), "error") },
    );
  const move = (id: string, delta: -1 | 1) => {
    const at = items.findIndex((x) => x.id === id);
    const target = items[at + delta];
    if (at < 0 || !target) return;
    commit(moveItem(items, id, target.id));
  };
  const dropOn = (targetId: string) => {
    if (drag && drag !== targetId) commit(moveItem(items, drag, targetId));
    setDrag(null);
    setOver(null);
  };
  const removeWidget = (w: Widget, name: string) =>
    remove.mutate(w.id, {
      onSuccess: () =>
        toast.show(
          t(board.kind === "home" ? "widgets.removed.home" : "widgets.removed.board", { title: w.title, name }),
        ),
      onError: (e) => toast.show(errorText(t, e, i18n.language), "error"),
    });

  const cell = (item: BoardItem, child: ReactNode) => (
    <div
      key={item.id}
      className={cx("wb-cell", drag === item.id && "is-drag", over === item.id && drag !== item.id && "is-over")}
      data-w={item.w}
      data-h={item.h}
      data-item={item.id}
      draggable={organizing || undefined}
      onDragStart={
        organizing
          ? (e: DragEvent) => {
              setDrag(item.id);
              if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", item.id);
              }
            }
          : undefined
      }
      onDragOver={
        organizing
          ? (e: DragEvent) => {
              if (!drag) return;
              e.preventDefault();
              if (over !== item.id) setOver(item.id);
            }
          : undefined
      }
      onDrop={
        organizing
          ? (e: DragEvent) => {
              e.preventDefault();
              dropOn(item.id);
            }
          : undefined
      }
      onDragEnd={
        organizing
          ? () => {
              setDrag(null);
              setOver(null);
            }
          : undefined
      }
    >
      {child}
    </div>
  );

  return (
    <div className="wgrid" data-arrange={organizing || undefined}>
      {items.map((item) => {
        if (item.type === "tile") {
          const slot = tiles?.[item.id];
          const organize = organizing ? { onMove: (delta: -1 | 1) => move(item.id, delta) } : null;
          return cell(item, typeof slot === "function" ? slot(organize) : slot);
        }
        return cell(
          item,
          <BoardWidget
            orgId={orgId}
            widget={item.widget}
            boardKind={board.kind}
            editable={editable}
            organizing={organizing}
            isNew={fresh.has(item.id)}
            now={now}
            onOpen={() => onOpen(item.id)}
            onChangeSchedule={() => (onChangeSchedule ?? onOpen)(item.id)}
            onSize={() =>
              commit(resizeItem(items, item.id, sizeToLayout(nextSize(layoutToSize({ w: item.w, h: item.h })))))
            }
            onMove={(delta) => move(item.id, delta)}
            onRemove={(name) => removeWidget(item.widget, name)}
          />,
        );
      })}
      {editable && !organizing && (
        <WidgetAddTile text={t("widgets.add.tile")} label={t("widgets.add.label")} onClick={onAdd} />
      )}
    </div>
  );
}

/** One widget on the board, with its agent's name and color, its actions and its footer. */
function BoardWidget({
  orgId,
  widget,
  boardKind,
  editable,
  organizing,
  isNew,
  now,
  onOpen,
  onChangeSchedule,
  onSize,
  onMove,
  onRemove,
}: {
  orgId: string;
  widget: Widget;
  boardKind: Dashboard["kind"];
  editable: boolean;
  organizing: boolean;
  isNew: boolean;
  now: number;
  onOpen: () => void;
  onChangeSchedule: () => void;
  onSize: () => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: (name: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const { name, color } = useWidgetAgent(widget.agentId);
  const refresh = useRefreshWidget(orgId);
  const busy = widget.status === "building" || widget.status === "updating" || refresh.isPending;
  const update = () =>
    refresh.mutate(widget.id, { onError: (e) => toast.show(errorText(t, e, i18n.language), "error") });
  const size = layoutToSize(widget.layout);
  const removeLabel = t(boardKind === "home" ? "widgets.menu.removeHome" : "widgets.menu.removeBoard");
  return (
    <WidgetCard
      className={cx(isNew && "wg--new")}
      data-widget={widget.id}
      title={widget.title}
      spec={widget.spec}
      status={widget.status}
      color={color}
      size={{ w: widget.layout.w, h: widget.layout.h }}
      locale={i18n.language}
      buildingText={t("widgets.status.building", { name })}
      onOpen={onOpen}
      footer={
        <WidgetFoot
          widget={widget}
          name={name}
          color={color}
          now={now}
          resolving={refresh.isPending && widget.status === "failed"}
          onResolve={editable ? update : undefined}
        />
      }
      actions={
        <>
          {editable && (
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon="refresh"
              aria-label={t("widgets.menu.refresh")}
              title={t("widgets.menu.refresh")}
              disabled={busy}
              onClick={update}
            />
          )}
          <Menu
            align="end"
            label={t("widgets.menu.label")}
            trigger={
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                icon="more"
                aria-label={t("widgets.menu.label")}
                title={t("widgets.menu.label")}
              />
            }
          >
            <MenuItem icon="expand" onSelect={onOpen}>
              {t("widgets.menu.open")}
            </MenuItem>
            {editable && (
              <MenuItem icon="refresh" disabled={busy} onSelect={update}>
                {t("widgets.menu.refresh")}
              </MenuItem>
            )}
            {editable && (
              <MenuItem icon="message" onSelect={onOpen}>
                {t("widgets.menu.change", { name })}
              </MenuItem>
            )}
            {editable && (
              <MenuItem icon="repeat" onSelect={onChangeSchedule}>
                {t("widgets.menu.schedule")}
              </MenuItem>
            )}
            {editable && <MenuSeparator />}
            {editable && (
              <MenuItem icon="trash" danger onSelect={() => onRemove(name)}>
                {removeLabel}
              </MenuItem>
            )}
          </Menu>
        </>
      }
      organize={
        organizing
          ? {
              sizeLabel: t("widgets.organize.size"),
              sizeText: t(`widgets.sizes.${size}`),
              removeLabel,
              dragLabel: t("widgets.organize.drag"),
              onSize,
              onRemove: () => onRemove(name),
              onMove,
            }
          : null
      }
    />
  );
}

/**
 * A fixed tile of a board (Home's "Waiting on you", "Working now"): a card like a widget's, its title and count, an
 * action at the head's end; in Organize, "Fixed" and the grip in their place.
 */
export function BoardTile({
  title,
  count,
  action,
  organize,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  organize: TileOrganize | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const grip = (e: KeyboardEvent<HTMLButtonElement>) => {
    const delta =
      e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : 0;
    if (!delta || !organize) return;
    e.preventDefault();
    organize.onMove(delta);
  };
  return (
    <Card as="section" className="wg wg--fixed" aria-label={title} data-organize={organize ? "" : undefined}>
      <div className="wg__head">
        <h2 className="wg__title">
          {title}
          {count !== undefined && count > 0 && <span className="wg__badge">{count}</span>}
        </h2>
        {organize ? (
          <span className="wg__arr">
            <span className="wg__badge">{t("widgets.organize.fixed")}</span>
            <button
              type="button"
              className="wg__grip"
              aria-label={t("widgets.organize.drag")}
              title={t("widgets.organize.drag")}
              onKeyDown={grip}
            >
              <Icon name="grip" size={16} />
            </button>
          </span>
        ) : (
          action
        )}
      </div>
      <div className="wg__body">{children}</div>
    </Card>
  );
}

/** Widgets that arrived after the board first drew (they grow in once). */
function useArrivals(widgets: readonly Widget[]): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const ids = widgets.map((w) => w.id).join(",");
  useEffect(() => {
    const now = new Set(ids ? ids.split(",") : []);
    if (!seen.current) {
      seen.current = now;
      return;
    }
    const added = [...now].filter((id) => !seen.current?.has(id));
    seen.current = now;
    if (!added.length) return;
    setFresh((s) => new Set([...s, ...added]));
    const timer = setTimeout(() => setFresh((s) => new Set([...s].filter((id) => !added.includes(id)))), 600);
    return () => clearTimeout(timer);
  }, [ids]);
  return fresh;
}
