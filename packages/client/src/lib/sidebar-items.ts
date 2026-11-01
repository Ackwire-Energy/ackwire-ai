import type { SidebarItem, SidebarItems, SidebarPlace, SidebarSection } from "../api/types";

/** The tools at the top of the sidebar, in their order (mirrors `SIDEBAR_ITEMS`, packages/engine/src/sidebar-items.ts). */
export const SIDEBAR_ITEMS: readonly SidebarItem[] = [
  "approvals",
  "threads",
  "issues",
  "wiki",
  "drive",
  "routines",
  "calendar",
  "forum",
];

/** Where each tool goes for someone who never moved it. */
export const SIDEBAR_DEFAULTS: Record<SidebarItem, SidebarPlace> = {
  approvals: "auto",
  threads: "always",
  issues: "always",
  wiki: "more",
  drive: "always",
  routines: "more",
  calendar: "more",
  forum: "more",
};

/** The tools with a count in the sidebar: only these can wait in More until there is something (`auto`). */
export const SIDEBAR_COUNTED: readonly SidebarItem[] = ["approvals", "threads"];

/** The sidebar's sections in their default order (mirrors `SIDEBAR_SECTIONS`, packages/engine/src/sidebar-items.ts). */
export const SIDEBAR_SECTIONS: readonly SidebarSection[] = ["tools", "channels", "agents", "people"];

/** `order` with `section` moved one place up (-1) or down (+1); the same order at an end. */
export function moveSection(order: readonly SidebarSection[], section: SidebarSection, by: -1 | 1): SidebarSection[] {
  const next = [...order];
  const i = next.indexOf(section);
  const j = i + by;
  if (i < 0 || j < 0 || j >= next.length) return next;
  [next[i], next[j]] = [next[j] as SidebarSection, section];
  return next;
}

export const sameOrder = (a: readonly SidebarSection[], b: readonly SidebarSection[]) => a.join() === b.join();

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
