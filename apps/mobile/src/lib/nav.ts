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
