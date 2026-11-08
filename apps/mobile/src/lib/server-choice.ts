import { normalizeServer } from "@agenteschat/client/lib/server";

/** The server the app talks to: the one the person chose ("Seu servidor"), else the build's. */
export const currentServer = (saved: string | null, build: string) =>
  (saved ? normalizeServer(saved, { allowHttp: true }) : null) ?? build;

/** What to remember: nothing for the build's own server, so a newer build's default applies. */
export const savedServer = (server: string, build: string) => (server === build ? null : server);

/**
 * A short name for a server that storage keys and file names can take (letters and digits only): FNV-1a of its
 * address, in hex (pure).
 */
export function serverSlug(server: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < server.length; i++) {
    hash ^= server.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The prefixes each server's session is stored under (ADR 0154: one session per server). Read from storage, or on the
 * first launch that keeps sessions per server, the server the app used until then keeps the one prefix there was, so
 * whoever was signed in stays signed in with nothing to move (pure).
 */
export function prefixesFrom(raw: string | null, current: string, base: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw ?? "null") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === "string" && /^[A-Za-z0-9._-]+$/.test(e[1]),
        ),
      );
    }
  } catch {
    // Unreadable: as on the first launch.
  }
  return { [current]: base };
}

/** A server's session prefix: the one it was given, else its own from its address (pure). */
export const sessionPrefix = (prefixes: Readonly<Record<string, string>>, server: string, base: string) =>
  prefixes[server] ?? `${base}_${serverSlug(server)}`;

/** The servers this phone is signed in to, in the order they were added, from storage (pure; anything else dropped). */
export function serverListFrom(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const v of parsed) {
      const server = typeof v === "string" ? normalizeServer(v, { allowHttp: true }) : null;
      if (server && !out.includes(server)) out.push(server);
    }
    return out;
  } catch {
    return [];
  }
}

export const withServer = (list: readonly string[], server: string) =>
  list.includes(server) ? [...list] : [...list, server];

export const withoutServer = (list: readonly string[], server: string) => list.filter((s) => s !== server);

/**
 * Choosing a server or following a connect link (a QR code or `agenteschat://connect`): the app moves to it and every
 * other server stays signed in (ADR 0154). Only a one-time sign-in on a server someone is already signed in to signs
 * them out there first: one account per server.
 */
export function connectPlan(current: string, target: { server: string; token?: string }, signedInThere: boolean) {
  return {
    move: target.server !== current,
    signOut: signedInThere && Boolean(target.token),
    token: target.token ?? null,
  };
}

/**
 * Where a tapped push opens (pure): `here` on the current server (it names none, an older server's, or this one),
 * `switch` to another server this phone is signed in to, `gone` for one it no longer is.
 */
export function pushPlace(
  pushServer: string | undefined,
  current: string,
  signedIn: readonly string[],
): { kind: "here" } | { kind: "switch"; server: string } | { kind: "gone" } {
  const server = pushServer ? normalizeServer(pushServer, { allowHttp: true }) : null;
  if (!server || server === current) return { kind: "here" };
  return signedIn.includes(server) ? { kind: "switch", server } : { kind: "gone" };
}

/** The server to open after leaving one (pure): the next one still signed in, or none. */
export const serverAfter = (signedIn: readonly string[], leaving: string): string | null =>
  signedIn.find((s) => s !== leaving) ?? null;
