import { normalizeServer } from "@agenteschat/client/lib/server";

/** The server the app talks to: the one the person chose ("Seu servidor"), else the build's. */
export const currentServer = (saved: string | null, build: string) =>
  (saved ? normalizeServer(saved, { allowHttp: true }) : null) ?? build;

/** What to remember: nothing for the build's own server, so a newer build's default applies. */
export const savedServer = (server: string, build: string) => (server === build ? null : server);

/**
 * Following a connect link (a QR code or `agenteschat://connect`): another server means signing out of this
 * one first, so no session or data crosses servers; a sign-in on the same server replaces whoever is in.
 */
export function connectPlan(current: string, signedIn: boolean, target: { server: string; token?: string }) {
  const move = target.server !== current;
  return { move, signOut: move || (signedIn && Boolean(target.token)), token: target.token ?? null };
}
