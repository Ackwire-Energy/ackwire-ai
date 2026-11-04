import { light } from "@agenteschat/tokens";

/**
 * Pure helpers for the native navigation (tab bar, headers, sheets). No React Native imports, so the
 * unit tests can load them.
 */

/** The text of a tab's badge: nothing at zero, the count up to 99, then "99+". */
export function tabBadge(count: number): string | undefined {
  if (!Number.isFinite(count) || count <= 0) return undefined;
  return count > 99 ? "99+" : String(Math.floor(count));
}

/**
 * iOS before 26 has no Liquid Glass: a transparent native header needs a blur of its own there.
 * `version` is `Platform.Version` (a string like "18.4" on iOS, the API level number on Android).
 */
export function needsHeaderBlur(os: string, version: string | number): boolean {
  if (os !== "ios") return false;
  const major = Number.parseInt(String(version), 10);
  return Number.isFinite(major) && major < 26;
}

/**
 * Tabs a system bar holds side by side: Android's bottom navigation takes at most five (a sixth throws when the tabs
 * mount), and an iPhone's bar folds the rest into "More".
 */
export const BAR_TABS_MAX = 5;

/** Search drawn apart from the tabs (iOS 26's round button), so it takes no slot of the bar. */
export function searchApart(os: string, version: string | number): boolean {
  if (os !== "ios") return false;
  const major = Number.parseInt(String(version), 10);
  return Number.isFinite(major) && major >= 26;
}

/** Whether search is in the tab bar: while every tab fits, or where it is drawn apart. Else it opens from the bar. */
export const searchInBar = (tabCount: number, os: string, version: string | number) =>
  tabCount <= BAR_TABS_MAX || searchApart(os, version);

/** The tabs the bar shows: all of them, or all but search when it would take a slot past the bar's room. */
export function barTabs<T extends { role?: "search" }>(tabs: readonly T[], os: string, version: string | number): T[] {
  return searchInBar(tabs.length, os, version) ? [...tabs] : tabs.filter((tab) => tab.role !== "search");
}

export { contrastRatio } from "@agenteschat/ui/sky/math";

/**
 * The unread badge of the tab bar: a classic red with white text in both themes. iOS always draws badge
 * text in white (UIKit has no text color for tab badges), so the background must be dark enough for it;
 * the light theme's danger red is, and it stays legible on the dark bar too.
 */
export const TAB_BADGE = { background: light.danger, text: "#ffffff" } as const;
