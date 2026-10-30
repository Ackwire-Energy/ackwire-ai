/** Reserved system-mode TCP ports, outside Linux's usual ephemeral range. */
export const BROWSER_PORT_FIRST = 10_000;
export const BROWSER_PORT_LAST = 29_999;
export const BROWSER_UID_BUCKET = 10_000;

export type BrowserPorts = { cdp: number; stream: number };

/** A UID's pair is permanent within its 10,000-UID bucket, including across runner restarts. */
export function browserPortsForUid(uid: number): BrowserPorts {
  if (!Number.isInteger(uid) || uid < 1000 || uid > 59_999) throw new Error(`Invalid agent uid ${uid}`);
  const first = BROWSER_PORT_FIRST + 2 * (uid % BROWSER_UID_BUCKET);
  return { cdp: first, stream: first + 1 };
}

/** A host's configured UID range must map injectively into the reserved pair range. */
export function validateBrowserUidRange([first, last]: [number, number]) {
  if (
    !Number.isInteger(first) || !Number.isInteger(last) || first < 1000 || last > 59_999 ||
    first > last || Math.floor(first / BROWSER_UID_BUCKET) !== Math.floor(last / BROWSER_UID_BUCKET)
  ) {
    throw new Error("System agent uid range must fit within one 10,000-uid block for browser port isolation");
  }
}

/** `bind(0)` must never auto-assign a browser port outside the cgroup bind policy. */
export function checkEphemeralRange(text: string) {
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(text);
  const first = Number(match?.[1]);
  const last = Number(match?.[2]);
  if (!match || first < 1 || last > 65_535 || first > last) {
    throw new Error("Cannot read Linux's ip_local_port_range for browser port isolation");
  }
  if (first <= BROWSER_PORT_LAST && last >= BROWSER_PORT_FIRST) {
    throw new Error(
      `Linux's ephemeral port range ${first}-${last} overlaps reserved browser ports ${BROWSER_PORT_FIRST}-${BROWSER_PORT_LAST}`,
    );
  }
}
