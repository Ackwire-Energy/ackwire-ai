import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ThisMacRequest } from "../control/this-mac";
import type { TrayState } from "../control/tray";
import {
  type AppInfo,
  type Host,
  type NotchInfo,
  type RunnerInfo,
  type RunnerStateChange,
  WINDOW_NAMES,
  type WindowName,
} from "./types";

/** Tauri's `listen` is async; this returns a plain unsubscribe that also works before it resolves. */
function subscribe<T>(event: string, cb: (payload: T) => void): () => void {
  let off: UnlistenFn | null = null;
  let stopped = false;
  void listen<T>(event, (e) => cb(e.payload)).then((fn) => {
    if (stopped) fn();
    else off = fn;
  });
  return () => {
    stopped = true;
    off?.();
  };
}

/** Running inside the Tauri shell (not a plain browser). */
export const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function createTauriHost(): Host {
  const label = getCurrentWindow().label;
  const name: WindowName = (WINDOW_NAMES as readonly string[]).includes(label) ? (label as WindowName) : "popover";
  return {
    window: name,
    fake: false,
    listRunners: () => invoke<RunnerInfo[]>("runners_list"),
    send: (homeId, line) => invoke<void>("runner_send", { homeId, line }),
    addRunner: () => invoke<string>("runner_add"),
    removeRunner: (homeId) => invoke<void>("runner_remove", { homeId }),
    onLine: (cb) => subscribe<{ homeId: string; line: string }>("runner://line", (p) => cb(p.homeId, p.line)),
    onRunnerState: (cb) => subscribe<RunnerStateChange>("runner://state", cb),
    onShown: (cb) => subscribe<WindowName>("window://shown", cb),
    openExternal: (url) => invoke<void>("open_external", { url }),
    revealFolder: (path) => invoke<void>("reveal_folder", { path }),
    pickFolder: () => invoke<string | null>("pick_folder"),
    setTrayState: (state: TrayState) => invoke<void>("set_tray_state", { state }),
    showWindow: (w) => invoke<void>("show_window", { name: w }),
    hideWindow: (w) => invoke<void>("hide_window", { name: w }),
    quit: () => invoke<void>("quit_app"),
    appInfo: () => invoke<AppInfo>("app_info"),
    autostart: () => invoke<boolean>("autostart_get"),
    setAutostart: (on) => invoke<void>("autostart_set", { on }),
    notify: (title, body) => invoke<void>("notify", { title, body }),
    installUpdate: () => invoke<boolean>("update_install"),
    setNotch: (on) => invoke<void>("notch_set", { on }),
    notchInfo: () => invoke<NotchInfo | null>("notch_info"),
    notchPlace: (width, height) => invoke<NotchInfo | null>("notch_place", { width, height }),
    resize: (width, height) => getCurrentWindow().setSize(new LogicalSize(width, height)),
    onThisMac: (cb) =>
      subscribe<{ id: number; request: ThisMacRequest }>("this-mac://request", (p) => cb(p.id, p.request)),
    thisMacReply: (id, ok, data) => invoke<void>("this_mac_reply", { id, ok, data }),
  };
}
