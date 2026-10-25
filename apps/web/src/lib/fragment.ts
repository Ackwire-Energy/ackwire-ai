/**
 * A secret a link carries in its fragment (`/owner#claim=…`): browsers never send the fragment to a
 * server, so it stays out of request logs. Read once, then taken out of the address bar and the history.
 */
export function takeFragmentParam(name: string): string | null {
  const value = new URLSearchParams(window.location.hash.slice(1)).get(name);
  if (value !== null) {
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  }
  return value || null;
}
