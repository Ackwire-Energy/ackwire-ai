import type {
  DashboardAudience,
  DashboardEditPolicy,
  DashboardKind,
  DashboardLayoutInput,
  DashboardSummary,
  HomeTile,
  Widget,
  WidgetCostEstimate,
  WidgetSchedule,
} from "./types";

/**
 * What the web and the phone share about boards (ADR 0134), without React: the list's groups, who has access in
 * Share, a board's order of widgets and tiles, Organize's moves, a failure's words and the cost line.
 */

const byOrder = (a: DashboardSummary, b: DashboardSummary) =>
  Number(b.pinned) - Number(a.pinned) || a.position - b.position || a.title.localeCompare(b.title);

/** The Dashboards list: the workspace's, the viewer's roles', and only theirs; pinned first, then by position. */
export function dashboardGroups(list: readonly DashboardSummary[]): {
  workspace: DashboardSummary[];
  roles: DashboardSummary[];
  mine: DashboardSummary[];
} {
  const boards = list.filter((d) => d.kind === "board").sort(byOrder);
  return {
    workspace: boards.filter((d) => d.audience === "workspace"),
    roles: boards.filter((d) => d.audience === "roles"),
    mine: boards.filter((d) => d.audience === "private"),
  };
}

export type DashboardAccess = "edits" | "sees" | "none";

/**
 * What one person may do on a board with this audience (Share's "Who has access"), by the same rule as the server:
 * its owner edits; admins see every board but private ones and edit what they see; others see a `workspace` board,
 * or a `roles` one when they hold one of its roles, and edit it when `viewers` edit.
 */
export function dashboardAccessOf(
  person: { userId: string; roleIds: readonly string[]; admin: boolean },
  board: {
    kind: DashboardKind;
    audience: DashboardAudience;
    roleIds: readonly string[];
    editPolicy: DashboardEditPolicy;
    ownerUserId: string | null;
  },
): DashboardAccess {
  if (board.ownerUserId === person.userId) return "edits";
  if (board.kind === "home" || board.audience === "private") return "none";
  const sees =
    board.audience === "workspace" || person.admin || board.roleIds.some((id) => person.roleIds.includes(id));
  if (!sees) return "none";
  return person.admin || board.editPolicy === "viewers" ? "edits" : "sees";
}

/** One cell of a board: a widget, or a home board's fixed tile. */
export type BoardItem =
  | { type: "widget"; id: string; position: number; w: 1 | 2; h: 1 | 2; widget: Widget }
  | { type: "tile"; id: HomeTile["key"]; position: number; w: 1 | 2; h: 1 | 2; tile: HomeTile };

/** A board's widgets and tiles in their order (a tile first on a tie). */
export function boardItems(widgets: readonly Widget[], tiles: readonly HomeTile[] = []): BoardItem[] {
  const items: BoardItem[] = [
    ...tiles.map((tile) => ({
      type: "tile" as const,
      id: tile.key,
      position: tile.position,
      w: tile.w,
      h: tile.h,
      tile,
    })),
    ...widgets.map((widget) => ({
      type: "widget" as const,
      id: widget.id,
      position: widget.layout.position,
      w: widget.layout.w,
      h: widget.layout.h,
      widget,
    })),
  ];
  return items.sort((a, b) => a.position - b.position || (a.type === b.type ? 0 : a.type === "tile" ? -1 : 1));
}

/** `items` with `id` moved to where `targetId` is (before it, or after it when moving down); else the same order. */
export function moveItem<T extends { id: string }>(items: readonly T[], id: string, targetId: string): T[] {
  const from = items.findIndex((x) => x.id === id);
  const to = items.findIndex((x) => x.id === targetId);
  if (from < 0 || to < 0 || from === to) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
}

/** `items` with one resized. */
export function resizeItem<T extends { id: string; w: 1 | 2; h: 1 | 2 }>(
  items: readonly T[],
  id: string,
  size: { w: 1 | 2; h: 1 | 2 },
): T[] {
  return items.map((x) => (x.id === id ? { ...x, w: size.w, h: size.h } : x));
}

/** What "Done" in Organize saves: positions 0, 1, 2… in the order shown, and each size. */
export function layoutOf(items: readonly BoardItem[]): DashboardLayoutInput {
  const widgets: DashboardLayoutInput["widgets"] = [];
  const tiles: HomeTile[] = [];
  items.forEach((item, position) => {
    if (item.type === "tile") tiles.push({ key: item.id, position, w: item.w, h: item.h });
    else widgets.push({ id: item.id, position, w: item.w, h: item.h });
  });
  return tiles.length ? { widgets, tiles } : { widgets };
}

/** Failure codes with words of their own under `widgets.failure.*`; any other reads as `error`. */
export const WIDGET_FAILURE_CODES = [
  "agent_reported",
  "no_update",
  "error",
  "budget_exceeded",
  "waiting_computer",
  "waiting_plan",
  "waiting_budget",
  "creator_left",
  "creator_no_access",
  "agent_archived",
  "audience",
  "failing",
  "stopped",
  "missing_credential",
  "timeout",
  "invalid_data",
] as const;
export type WidgetFailureCode = (typeof WIDGET_FAILURE_CODES)[number];

/** The `widgets.failure.*` key of a failure code. `agent_reported` shows the agent's own words instead. */
export function widgetFailureKey(code: string): `widgets.failure.${WidgetFailureCode}` {
  const known = (WIDGET_FAILURE_CODES as readonly string[]).includes(code) ? (code as WidgetFailureCode) : "error";
  return `widgets.failure.${known}`;
}

/** The cost line of "New widget": a day, a week, only when asked, on a plan, or nothing known. */
export type WidgetCostLine =
  | { kind: "day"; usd: number }
  | { kind: "week"; usd: number }
  | { kind: "manual" }
  | { kind: "plan" }
  | { kind: "unknown" };

export function widgetCostLine(
  schedule: WidgetSchedule,
  estimate: WidgetCostEstimate | null | undefined,
): WidgetCostLine {
  if (schedule === "manual") return { kind: "manual" };
  if (!estimate) return { kind: "unknown" };
  if (estimate.billedTo === "plan") return { kind: "plan" };
  const usd = schedule === "week" ? estimate.perWeekUsd : estimate.perDayUsd;
  if (usd === null) return { kind: "unknown" };
  return schedule === "week" ? { kind: "week", usd } : { kind: "day", usd };
}

/** The widgets of a board that are updating or being built (a sweep on each). */
export const busyWidgets = (widgets: readonly Widget[]) =>
  widgets.filter((w) => w.status === "updating" || w.status === "building");
