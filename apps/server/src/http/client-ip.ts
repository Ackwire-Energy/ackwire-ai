/**
 * The client's address behind our proxies (Railway appends its own hops to
 * `x-forwarded-for`, and its last hop is internal). Shared by every route
 * that rate limits or records where a request came from.
 */

/** Loopback, private, CGNAT (Railway's internal network) and link-local addresses: proxies, never a client. */
export function isInternal(ip: string): boolean {
  const v4 = ip.replace(/^::ffff:/, "").match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254)
    );
  }
  const v6 = ip.toLowerCase();
  return v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

/**
 * The client's address: walking `x-forwarded-for` from the right (what our
 * proxies appended), the first one that isn't internal. Entries further left
 * come from the client and can be anything, so they never key a limit.
 * Without a public hop, the `x-real-ip` our host sets.
 */
export function clientIp(forwardedFor: string | undefined, realIp: string | undefined): string {
  const hops = (forwardedFor ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] as string;
    if (!isInternal(hop)) return hop;
  }
  return realIp?.trim() || hops[0] || "unknown";
}

/** `clientIp` of a request's headers. */
export const requestIp = (headers: { get(name: string): string | null | undefined }) =>
  clientIp(headers.get("x-forwarded-for") ?? undefined, headers.get("x-real-ip") ?? undefined);
