import { CLOUD_SERVER, normalizeServer } from "@agenteschat/client/lib/server";
import type { Home } from "./store";

/** Preference: the server the next sign-in goes to ("Seu servidor" in the welcome window). */
export const SERVER_PREF = "server";

/** The preference's server; agentes.chat until one is chosen. */
export const serverFromPref = (pref: string | null) => (pref ? normalizeServer(pref) : null) ?? CLOUD_SERVER;

/** The site to open: the first of these organizations' server, else the one chosen for signing in. */
export function siteOf(homes: readonly Home[], chosen: string): string {
  for (const home of homes) {
    const server = home.status?.paired && home.status.server ? normalizeServer(home.status.server) : null;
    if (server) return server;
  }
  return chosen;
}
