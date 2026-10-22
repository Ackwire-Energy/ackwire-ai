import { CLOUD_SERVER, normalizeServer, serverHost } from "@agenteschat/client/lib/server";
import type { TFunction } from "i18next";
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

/** The label of the link to `site`: agentes.chat opens in the app's own window, another server in the browser. */
export const openSiteLabel = (site: string, t: TFunction) =>
  site === CLOUD_SERVER ? t("desktop.tray.openSite") : t("desktop.tray.openServer", { host: serverHost(site) });
