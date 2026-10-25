import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import "./styles.css";
import { AppProvider } from "./app";
import type { LocalPhase, SetupStep, Tailnet } from "./control/local-server";
import { DesktopStore } from "./control/store";
import { DevFrame } from "./dev/DevFrame";
import { readPref } from "./hooks";
import { createFakeHost, SCENARIOS, type Scenario } from "./host/fake";
import { createTauriHost, inTauri } from "./host/tauri";
import { type Host, WINDOW_NAMES, type WindowName } from "./host/types";
import { createDesktopI18n, pickLocale, systemLocale } from "./i18n";
import { ToastProvider } from "./ui/Toast";
import { baseName } from "./ui/time";
import { WindowView } from "./WindowView";

const params = new URLSearchParams(window.location.search);
const asked = params.get("window");
const scenario = params.get("scenario");
const fakeHost = inTauri()
  ? null
  : createFakeHost(
      (WINDOW_NAMES as readonly string[]).includes(asked ?? "") ? (asked as WindowName) : "popover",
      (SCENARIOS as readonly string[]).includes(scenario ?? "") ? (scenario as Scenario) : "selfhost",
      {
        link: params.get("link"),
        found: params.get("found") !== "0",
        here: {
          phase: (params.get("phase") as LocalPhase | null) ?? undefined,
          reach: params.get("reach") === "1",
          back: params.get("back"),
          run: params.get("run") !== "0",
          usage: params.get("usage") !== "0",
          tailscale: (params.get("tailscale") as Tailnet["state"] | null) ?? undefined,
          installed: params.get("installed") === "terminal" ? "terminal" : undefined,
          claim: params.get("claim") === "1",
          serving: params.get("serving") !== "0",
          fail: (params.get("fail") as SetupStep | null) ?? undefined,
          hold: (params.get("hold") as SetupStep | null) ?? undefined,
        },
      },
    );
const host: Host = fakeHost ?? createTauriHost();

// The browser's own language, or `?lang=` while designing.
const i18n = createDesktopI18n(
  fakeHost && params.get("lang") ? pickLocale([params.get("lang")]) : systemLocale(),
  host.platform,
);
document.documentElement.lang = i18n.language;

// Light or dark like the system (`?theme=` while designing).
const dark = window.matchMedia("(prefers-color-scheme: dark)");
const forced = fakeHost ? params.get("theme") : null;
const applyTheme = () => {
  document.documentElement.dataset.theme =
    forced === "dark" || forced === "light" ? forced : dark.matches ? "dark" : "light";
};
applyTheme();
dark.addEventListener("change", applyTheme);

const store = new DesktopStore(host, {
  // Only the popover window raises notifications (every window has its own store).
  onAccessRequested: (home, request) => {
    if (host.window !== "popover" || !readPref("notify", true)) return;
    const title = i18n.t("desktop.tray.notifTitle", { agent: request.agent.name, folder: baseName(request.path) });
    const org = home.status?.org?.name;
    void host.notify(title, org ? `${org} · ${request.reason}` : request.reason).catch(() => {});
  },
});
store.start();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <AppProvider host={host} store={store}>
          <ToastProvider>{fakeHost ? <DevFrame host={fakeHost} /> : <WindowView name={host.window} />}</ToastProvider>
        </AppProvider>
      </I18nextProvider>
    </StrictMode>,
  );
}
