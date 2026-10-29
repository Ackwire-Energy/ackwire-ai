import type { TFunction } from "i18next";

/** The longest label Rust takes (`app_menu_set` in menus.rs refuses the whole set past it). */
export const MAX_MENU_LABEL = 120;

/**
 * Everything Rust shows in the app's language: the menu bar, the tray's own menu on Windows and Linux (the
 * server here's line in it too), the system dialog before a page pairs this computer and the server here's
 * notifications. `{org}`, `{host}` and `{version}` are left for Rust to fill in.
 */
export function menuLabels(t: TFunction): Record<string, string> {
  return {
    ...(t("desktop.menu", { returnObjects: true }) as Record<string, string>),
    serversAdd: t("desktop.servers.add"),
    serversManage: t("desktop.servers.manage"),
    trayOpen: t("desktop.tray.open"),
    trayPrefs: t("desktop.tray.prefs"),
    trayPause: t("desktop.tray.pause"),
    trayPause1h: t("desktop.tray.pause1h"),
    trayPauseTomorrow: t("desktop.tray.pauseTomorrow"),
    trayPauseManual: t("desktop.tray.pauseManual"),
    trayResume: t("desktop.tray.resume"),
    pairTitle: t("desktop.pair.title", { org: "{org}" }),
    pairBody: t("desktop.pair.body", { host: "{host}" }),
    pairAllow: t("desktop.pair.allow"),
    pairNotNow: t("desktop.pair.notNow"),
    serverTitle: t("desktop.server.title"),
    serverRunning: t("desktop.server.running"),
    serverStarting: t("desktop.server.starting"),
    serverStopped: t("desktop.server.stopped"),
    serverFailing: t("desktop.server.failing"),
    serverStart: t("desktop.server.start"),
    serverStop: t("desktop.server.stop"),
    hereStopped: t("desktop.server.stoppedBanner"),
    hereStoppedBody: t("desktop.server.stoppedBody"),
    hereFailing: t("desktop.server.failingBanner"),
    hereBack: t("desktop.server.updateBack", { version: "{version}" }),
    setupFailed: t("desktop.here.notifyFailed"),
    setupFailedBody: t("desktop.here.notifyFailedBody"),
  };
}
