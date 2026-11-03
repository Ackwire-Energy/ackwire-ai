import type { Dashboard, HomeTile } from "@agenteschat/client";
import { useHomeDashboard } from "@agenteschat/client";
import { Button } from "@agenteschat/ui";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { NewWidgetDialog } from "@/components/dashboards/NewWidgetDialog";
import { useOpenParam } from "@/lib/open-param";
import { BoardTile, type TileOrganize, WidgetBoard } from "./WidgetBoard";
import { WidgetPanel } from "./WidgetPanel";
import "./widgets.css";

/** A fixed tile's content: its title, how many it holds, the action at its head's end, its rows. */
export interface MuralTile {
  title: string;
  count: number;
  action?: ReactNode;
  body: ReactNode;
}

/** Where Home's fixed tiles start, until the person's home board has come (ADR 0134 §9). */
const DEFAULT_TILES: HomeTile[] = [
  { key: "waiting", position: 0, w: 2, h: 1 },
  { key: "working", position: 3, w: 2, h: 1 },
];

/**
 * Home as a mural (ADR 0134, on ADR 0108): "Waiting on you" and "Working now" are fixed tiles of the person's home
 * board, among their widgets, in its 4 columns. "Organize" drags and resizes; "+ Widget" asks an agent for one or
 * pins a chart from the chat; a widget opens in its side panel (`?widget=<id>`).
 */
export function HomeMural({ orgId, waiting, working }: { orgId: string; waiting: MuralTile; working: MuralTile }) {
  const { t } = useTranslation();
  const home = useHomeDashboard(orgId);
  const [arranging, setArranging] = useState(false);
  const [adding, setAdding] = useState(false);
  const [widgetId, setWidgetId] = useOpenParam("widget");
  const board = withTiles(home.data ?? placeholder(orgId));
  const editable = Boolean(home.data?.canEdit);
  const tile = (it: MuralTile) => (organize: TileOrganize | null) => (
    <BoardTile title={it.title} count={it.count} action={it.action} organize={organize}>
      {it.body}
    </BoardTile>
  );
  return (
    <section className="home-sec home-mural" aria-label={t("widgets.home")}>
      <div className="list-group-head">
        <h2>{t("widgets.home")}</h2>
        {board.widgets.length > 0 && <span className="list-group-head__count">{board.widgets.length}</span>}
        {editable && (
          <span className="home-sec__acts">
            <button
              type="button"
              className="home-sec__more"
              aria-pressed={arranging}
              onClick={() => setArranging((v) => !v)}
            >
              {arranging ? t("widgets.organize.done") : t("widgets.organize.start")}
            </button>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              icon="plus"
              aria-label={t("widgets.add.label")}
              title={t("widgets.add.label")}
              onClick={() => setAdding(true)}
            />
          </span>
        )}
      </div>
      <WidgetBoard
        orgId={orgId}
        board={board}
        arranging={arranging && editable}
        tiles={{ waiting: tile(waiting), working: tile(working) }}
        tileNames={{ waiting: waiting.title, working: working.title }}
        onAdd={() => setAdding(true)}
        onOpen={(id) => setWidgetId(id)}
      />
      <WidgetPanel orgId={orgId} widgetId={widgetId} onClose={() => setWidgetId(null)} />
      <NewWidgetDialog orgId={orgId} open={adding} onClose={() => setAdding(false)} dashboardId={null} />
    </section>
  );
}

/** A home board always has both fixed tiles: one it lacks takes its default place. */
function withTiles(board: Dashboard): Dashboard {
  const missing = DEFAULT_TILES.filter((d) => !board.tiles.some((x) => x.key === d.key));
  return missing.length ? { ...board, tiles: [...board.tiles, ...missing] } : board;
}

/** The home board before it has come: only its fixed tiles, nothing to edit yet. */
function placeholder(orgId: string): Dashboard {
  const at = new Date(0).toISOString();
  return {
    id: `home:${orgId}`,
    kind: "home",
    title: "",
    about: "",
    audience: "private",
    roleIds: [],
    editPolicy: "owner",
    pinned: false,
    position: 0,
    owner: null,
    ownerUserId: null,
    mine: true,
    widgetCount: 0,
    thumbs: [],
    viewerCount: 1,
    canEdit: false,
    canManage: false,
    proposal: null,
    createdAt: at,
    updatedAt: at,
    widgets: [],
    tiles: DEFAULT_TILES,
  };
}
