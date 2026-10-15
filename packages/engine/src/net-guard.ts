import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ValidationError } from "./errors";

/** Resolves a host name to its addresses (injected in tests). */
export type ResolveHost = (host: string) => Promise<string[]>;

export const resolveHostDns: ResolveHost = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

function ipv4Parts(ip: string) {
  return ip.split(".").map((p) => Number(p));
}

/** Private, loopback, link-local (cloud metadata), CGNAT, multicast and reserved addresses. */
export function isBlockedAddress(address: string): boolean {
  let ip = address.toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped?.[1]) ip = mapped[1];
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ipv4Parts(ip);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return a >= 224; // multicast and reserved
  }
  if (isIP(ip) === 6) {
    if (ip === "::" || ip === "::1") return true;
    if (/^f[cd]/.test(ip)) return true; // unique local fc00::/7
    if (/^fe[89ab]/.test(ip)) return true; // link-local fe80::/10
    if (ip.startsWith("ff")) return true; // multicast
    return ip === "fd00:ec2::254"; // AWS metadata over IPv6
  }
  return true; // not an IP at all
}

/**
 * Checks a URL a person typed for an outbound connection (custom MCP
 * servers, an org's own storage endpoint): https only, no credentials in
 * it, and neither the host nor any address it resolves to may be private,
 * loopback, link-local or a cloud metadata address (SSRF). DNS can change
 * between this check and the request; the check still stops the obvious
 * cases and every typed-in internal name.
 */
export async function assertPublicHttpsUrl(raw: string, resolve: ResolveHost = resolveHostDns): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError("Invalid address", "url.invalid");
  }
  if (url.protocol !== "https:") throw new ValidationError("Use an https:// address", "url.https_required");
  if (url.username || url.password)
    throw new ValidationError("The address can't have a user or password", "url.credentials");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new ValidationError("This address points to an internal network", "url.internal");
  }
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new ValidationError("This address points to an internal network", "url.internal");
    return url;
  }
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new ValidationError(`Couldn't find ${host}`, "url.not_found", { host });
  }
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new ValidationError("This address points to an internal network", "url.internal");
  }
  return url;
}
