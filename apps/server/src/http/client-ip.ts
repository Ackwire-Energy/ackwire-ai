/**
 * The client's address behind a reverse proxy. Shared by every route that
 * rate limits or records where a request came from.
 */

/**
 * Loopback, private, shared (CGNAT, 100.64.0.0/10) and link-local addresses:
 * where a hosting platform's own proxies sit. Tailnet and LAN clients have
 * them too, so `clientIp` skips them only while a public hop is left.
 */
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
 * The client's address: walking `x-forwarded-for` from the right (what
 * proxies appended), the first one that isn't internal. When every hop is
 * internal, as for a tailnet client behind `tailscale serve`, the last one:
 * the address the nearest proxy saw. Entries further left, and `x-real-ip`
 * while that header exists, come from the client and can be anything, so they
 * never key a limit. Without the header, the `x-real-ip` a proxy may set.
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
  return hops.at(-1) ?? (realIp?.trim() || "unknown");
}

/** `clientIp` of a request's headers. */
export const requestIp = (headers: { get(name: string): string | null | undefined }) =>
  clientIp(headers.get("x-forwarded-for") ?? undefined, headers.get("x-real-ip") ?? undefined);
