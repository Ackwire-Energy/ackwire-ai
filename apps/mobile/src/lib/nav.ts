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

/** WCAG contrast ratio between two "#rrggbb" colors (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const lum = (hex: string) => {
    const n = Number.parseInt(hex.slice(1, 7), 16);
    const [r, g, bl] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The unread badge of the tab bar: a classic red with white text in both themes. iOS always draws badge
 * text in white (UIKit has no text color for tab badges), so the background must be dark enough for it;
 * the light theme's danger red is, and it stays legible on the dark bar too.
 */
export const TAB_BADGE = { background: light.danger, text: "#ffffff" } as const;
