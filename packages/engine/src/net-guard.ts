import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ValidationError } from "./errors";

/** Resolves a host name to its addresses (injected in tests). */
export type ResolveHost = (host: string) => Promise<string[]>;

export const resolveHostDns: ResolveHost = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

function ipv4Parts(ip: string) {
  return ip.split(".").map((p) => Number(p));
}

/**
 * The eight 16-bit groups of a valid IPv6 literal, in any notation: compressed
 * (`::`), full, or with an embedded dotted IPv4 tail. Classifying the groups (not
 * a prefix string) is what keeps the range checks from being fooled by an
 * alternate spelling of the same address, such as a hex IPv4-mapped form.
 */
type Ipv6Groups = [number, number, number, number, number, number, number, number];

function ipv6Groups(ip: string): Ipv6Groups | null {
  let s = ip;
  const dotted = /:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (dotted) {
    const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = dotted.slice(1, 5).map(Number);
    if ([b0, b1, b2, b3].some((n) => n > 255)) return null;
    s = `${s.slice(0, dotted.index + 1)}${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((x) => Number.parseInt(x, 16)));
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  const groups = halves.length === 2 ? [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail] : head;
  if (groups.length !== 8 || groups.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null;
  return groups as Ipv6Groups;
}

/** Private, loopback, link-local (cloud metadata), CGNAT, multicast and reserved addresses. */
export function isBlockedAddress(address: string): boolean {
  let ip = address.toLowerCase();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  if (isIP(ip) === 6) {
    const g = ipv6Groups(ip);
    if (!g) return true; // can't be classified → treat as internal
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d), in any notation,
    // carry an IPv4 address the socket connects to: check it under the IPv4 rules.
    // This also catches ::1 and :: (as 0.0.0.1 and 0.0.0.0, both blocked below).
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (g[5] === 0 || g[5] === 0xffff)) {
      return isBlockedAddress(`${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`);
    }
    if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7 (incl. fd00:ec2::254)
    if ((g[0] & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast ff00::/8
    return false;
  }
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

const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Name suffixes that never leave a local network: loopback, mDNS, private use and the special-use ones. */
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".test", ".example", ".invalid"];

/**
 * Whether a host is a public DNS name, from the name alone (nothing is resolved): dotted, not an IP
 * address, not `localhost` and under no local-only suffix. For a name others read as this server's own
 * (a Web Push contact), never as a check before connecting (`publicHostAddress` resolves).
 */
export function isPublicHostName(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (isIP(h) || !HOST_NAME.test(h)) return false;
  return !LOCAL_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

/**
 * A host a person typed for a direct connection (a database): an address
 * to connect to that is not private, loopback, link-local or metadata.
 * Resolved on every new connection (DNS rebinding); the caller connects to
 * the returned address, never to the name again.
 */
export async function publicHostAddress(
  host: string,
  resolve: ResolveHost = resolveHostDns,
): Promise<{ ok: true; address: string } | { ok: false; reason: "blocked" | "unreachable" }> {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal"))
    return { ok: false, reason: "blocked" };
  if (isIP(h)) return isBlockedAddress(h) ? { ok: false, reason: "blocked" } : { ok: true, address: h };
  if (!HOST_NAME.test(h)) return { ok: false, reason: "blocked" };
  let addresses: string[];
  try {
    addresses = await resolve(h);
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  const first = addresses[0];
  if (!first) return { ok: false, reason: "unreachable" };
  if (addresses.some(isBlockedAddress)) return { ok: false, reason: "blocked" };
  return { ok: true, address: first };
}
