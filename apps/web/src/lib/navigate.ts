/** Leaves the app for an external URL (OAuth providers). Replaceable in tests. */
let impl = (url: string) => window.location.assign(url);

export const navigateAway = (url: string) => impl(url);

export function setNavigateAway(next: (url: string) => void) {
  impl = next;
}
