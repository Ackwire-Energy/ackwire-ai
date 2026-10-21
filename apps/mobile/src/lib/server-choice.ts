import { normalizeServer } from "@agenteschat/client/lib/server";

/** The server the app talks to: the one the person chose ("Seu servidor"), else the build's. */
export const currentServer = (saved: string | null, build: string) =>
  (saved ? normalizeServer(saved, { allowHttp: true }) : null) ?? build;

/** What to remember: nothing for the build's own server, so a newer build's default applies. */
export const savedServer = (server: string, build: string) => (server === build ? null : server);

/**
 * Choosing a server or following a connect link (a QR code or `agenteschat://connect`): another server means
 * leaving this one first, so no session or data crosses servers. Signed in, that is a sign-out; with nobody
 * signed in, the stored cookie is only forgotten (nothing to end on a server that may not even answer). A
 * sign-in on the same server replaces whoever is in.
 */
export function connectPlan(current: string, signedIn: boolean, target: { server: string; token?: string }) {
  const move = target.server !== current;
  return {
    move,
    signOut: signedIn && (move || Boolean(target.token)),
    forget: move && !signedIn,
    token: target.token ?? null,
  };
}
