import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { createApiClient, createSnapshot, meQuery } from "@agenteschat/client";
import { knownErrorText } from "@agenteschat/client/lib/errors";
import { AppProviders, type AppServices } from "./app/providers";
import { createQueryClient } from "./app/query-client";
import { createBetterAuthClient } from "./auth/better-auth";
import { loadI18n, savedLocale } from "./i18n";
import {
  checkAppVersion,
  createVersionWatch,
  fetchIndexHtml,
  loadedEntry,
  startVersionWatch,
  VERSION_CHECK_MS,
} from "./lib/app-version";
import { applyDesktopDevice, askForPhone, asksForPhone, desktopPlatform } from "./lib/desktop";
import { snapshotStore } from "./lib/snapshot-store";
import { createToastStore } from "./lib/toast";
import { routeTree } from "./routeTree.gen";

const i18n = await loadI18n(savedLocale());
document.documentElement.lang = i18n.language;
// In the desktop app (ADR 0036): the site draws the window's title bar (desktop.css), with room for a Mac's
// buttons only there; and "this Mac" is this computer's own name.
const platform = desktopPlatform();
if (platform) {
  document.documentElement.dataset.desktop = platform;
  applyDesktopDevice(i18n, platform);
  if (asksForPhone(window.location.search)) askForPhone();
}
const toasts = createToastStore();
const api = createApiClient();

/** A 401 anywhere means the session ended: back to sign-in, then here again. */
function onUnauthorized() {
  if (window.location.pathname.startsWith("/login")) return;
  const redirect = window.location.pathname + window.location.search;
  queryClient.clear();
  void router.navigate({ to: "/login", search: { redirect } });
  toasts.show(i18n.t("common.signedOut"));
}

const queryClient = createQueryClient({
  onUnauthorized,
  onMutationError: (message) => toasts.show(message, "error"),
  unknownError: () => i18n.t("common.unknownError"),
  describeError: (error) => knownErrorText(i18n.t, error),
});

// The last lists and chats saved on this device show at once; everything revalidates as usual.
const snapshot = createSnapshot(queryClient, snapshotStore);
snapshot.start();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void snapshot.flush();
});
/** Opening never waits longer than this for the snapshot (a slow disk loads from the server instead). */
const SNAPSHOT_WAIT_MS = 300;

const router = createRouter({
  routeTree,
  context: { queryClient, api },
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
  // No View Transitions: they freeze the whole page while the next one renders (the sidebar's pill
  // stalled mid-slide). Each page's main fades in on mount instead (layout.css).
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// A deploy while this tab is open: say so, and the next page change loads the new app.
const versionWatch = startVersionWatch(
  createVersionWatch({
    loaded: loadedEntry(),
    fetchHtml: fetchIndexHtml,
    onStale: () =>
      toasts.show(i18n.t("common.newVersion"), "info", {
        label: i18n.t("common.reload"),
        run: () => window.location.reload(),
      }),
  }),
);
router.subscribe("onBeforeNavigate", ({ toLocation, fromLocation }) => {
  if (versionWatch.stale && fromLocation && toLocation.href !== fromLocation.href) {
    window.location.assign(toLocation.href);
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void checkAppVersion();
});
window.addEventListener("online", () => void checkAppVersion());
setInterval(() => void checkAppVersion(), VERSION_CHECK_MS);

// The connector OAuth callback reports failures as `/?connector_error=…`.
const connectorError = new URLSearchParams(window.location.search).get("connector_error");
if (connectorError) {
  toasts.show(i18n.t("connectors.errorToast", { reason: connectorError }), "error");
  window.history.replaceState(null, "", window.location.pathname);
}

const services: AppServices = { api, auth: createBetterAuthClient(), queryClient, i18n, toasts };

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");

const restored = snapshot.restore().then((found) => {
  // The saved `me` let the app open without asking: ask now (no session: sign-in, and the snapshot goes).
  if (!found) return;
  void queryClient
    .fetchQuery({ ...meQuery(api), staleTime: 0 })
    .then((me) => {
      if (!me) onUnauthorized();
    })
    .catch(() => {});
});
void Promise.race([restored, new Promise((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_MS))]).then(() => {
  createRoot(root).render(
    <StrictMode>
      <AppProviders services={services}>
        <RouterProvider router={router} />
      </AppProviders>
    </StrictMode>,
  );
});
