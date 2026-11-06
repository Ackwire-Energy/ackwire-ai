import type { SidebarItem, SidebarItems, SidebarPlace, SidebarSection } from "../api/types";

/** The tools at the top of the sidebar, in their order (mirrors `SIDEBAR_ITEMS`, packages/engine/src/sidebar-items.ts). */
export const SIDEBAR_ITEMS: readonly SidebarItem[] = [
  "approvals",
  "proposals",
  "threads",
  "issues",
  "wiki",
  "drive",
  "routines",
  "calendar",
  "team",
  "dashboards",
  "taskManager",
];

/** Where each tool goes for someone who never moved it. */
export const SIDEBAR_DEFAULTS: Record<SidebarItem, SidebarPlace> = {
  approvals: "auto",
  proposals: "more",
  threads: "always",
  issues: "always",
  wiki: "more",
  drive: "always",
  routines: "more",
  calendar: "more",
  team: "always",
  dashboards: "more",
  taskManager: "more",
};

/** The tools with a count in the sidebar: only these can wait in More until there is something (`auto`). */
export const SIDEBAR_COUNTED: readonly SidebarItem[] = ["approvals", "proposals", "threads"];

/** The sidebar's sections in their default order (mirrors `SIDEBAR_SECTIONS`, packages/engine/src/sidebar-items.ts). */
export const SIDEBAR_SECTIONS: readonly SidebarSection[] = ["tools", "channels", "agents", "people"];

/** `order` with `section` (a section or a tool) moved one place up (-1) or down (+1); the same order at an end. */
export function moveSection<T extends string>(order: readonly T[], section: T, by: -1 | 1): T[] {
  const next = [...order];
  const i = next.indexOf(section);
  const j = i + by;
  if (i < 0 || j < 0 || j >= next.length) return next;
  [next[i], next[j]] = [next[j] as T, section];
  return next;
}

/**
 * The saved order as this build can show it: only the tools it knows, then any the order lacks. A tab left open across
 * a deploy reads a newer server's tools, and a tool it has no page for would break the sidebar.
 */
export const knownToolOrder = (saved: readonly SidebarItem[]): SidebarItem[] => [
  ...new Set([...saved.filter((id) => SIDEBAR_ITEMS.includes(id)), ...SIDEBAR_ITEMS]),
];

export const sameOrder = (a: readonly string[], b: readonly string[]) => a.join() === b.join();

/** `order` with `item` put just before or after `target`; the same order when either isn't in it or they're one. */
export function placeTool(
  order: readonly SidebarItem[],
  item: SidebarItem,
  target: SidebarItem,
  where: "before" | "after",
): SidebarItem[] {
  if (item === target || !order.includes(item) || !order.includes(target)) return [...order];
  const rest = order.filter((x) => x !== item);
  rest.splice(rest.indexOf(target) + (where === "after" ? 1 : 0), 0, item);
  return rest;
}

/**
 * `item` one place up (-1) or down (+1) among the tools `shown` in the list: past its neighbour there, whatever sits
 * in More between them. The same order at an end.
 */
export function moveShownTool(
  order: readonly SidebarItem[],
  shown: readonly SidebarItem[],
  item: SidebarItem,
  by: -1 | 1,
): SidebarItem[] {
  const target = shown[shown.indexOf(item) + by];
  return target ? placeTool(order, item, target, by < 0 ? "before" : "after") : [...order];
}

export const sidebarPlace = (items: SidebarItems | undefined, item: SidebarItem): SidebarPlace =>
  items?.[item] ?? SIDEBAR_DEFAULTS[item];

/** In the list, else in More: `always`, or `auto` while its count is above zero. */
export const inSidebarList = (place: SidebarPlace, count: number) =>
  place === "always" || (place === "auto" && count > 0);

/** The choices with one tool moved. One put back on its default is dropped, so `{}` is the default. */
export function withSidebarPlace(
  items: SidebarItems | undefined,
  item: SidebarItem,
  place: SidebarPlace,
): SidebarItems {
  const next = { ...items };
  if (place === SIDEBAR_DEFAULTS[item]) delete next[item];
  else next[item] = place;
  return next;
}
