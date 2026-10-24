import type { HelloLine } from "../control/client";
import type { ThisMacRequest } from "../control/this-mac";
import type { TrayState } from "../control/tray";

/** The app's windows (Tauri labels). */
export type WindowName = "popover" | "welcome" | "prefs" | "notch";
export const WINDOW_NAMES: readonly WindowName[] = ["popover", "welcome", "prefs", "notch"];

/** One organization home and its runner child, as the Rust side knows it. */
export interface RunnerInfo {
  homeId: string;
  dir: string;
  running: boolean;
  hello: HelloLine | null;
}

export interface RunnerStateChange {
  homeId: string;
  running: boolean;
  /** The home was deleted (left the organization). */
  removed: boolean;
}

/** The MacBook's notch, in points. */
export interface NotchInfo {
  width: number;
  height: number;
}

export interface AppInfo {
  version: string;
  os: string;
  /** Rust's name: `aarch64` or `x86_64`. */
  arch: string;
}

/**
 * What the web view may ask of the app around it: the Tauri shell in the real app, an in-browser fake
 * in development (`bun run dev`). Nothing here reaches the file system or a shell beyond these calls.
 */
export interface Host {
  readonly window: WindowName;
  /** The in-browser fake (design work), not the real app. */
  readonly fake: boolean;
  listRunners(): Promise<RunnerInfo[]>;
  send(homeId: string, line: string): Promise<void>;
  /** A new, empty organization home with its runner started; resolves with its id. */
  addRunner(): Promise<string>;
  /** Stops the home's runner and deletes the home (the agents' folders stay). */
  removeRunner(homeId: string): Promise<void>;
  onLine(cb: (homeId: string, line: string) => void): () => void;
  onRunnerState(cb: (change: RunnerStateChange) => void): () => void;
  /** A window was brought up (`show_window`). */
  onShown(cb: (name: WindowName) => void): () => void;
  /** Opens an https://agentes.chat link in the person's browser. */
  openExternal(url: string): Promise<void>;
  /** Shows a local folder in Finder. */
  revealFolder(path: string): Promise<void>;
  pickFolder(): Promise<string | null>;
  setTrayState(state: TrayState): Promise<void>;
  showWindow(name: WindowName): Promise<void>;
  hideWindow(name: WindowName): Promise<void>;
  quit(): Promise<void>;
  appInfo(): Promise<AppInfo>;
  autostart(): Promise<boolean>;
  setAutostart(on: boolean): Promise<void>;
  notify(title: string, body: string): Promise<void>;
  /** Installs the newer version and relaunches the app; false when there is nothing to install. */
  installUpdate(): Promise<boolean>;
  /** Creates (on) or destroys (off) the notch window. */
  setNotch(on: boolean): Promise<void>;
  /** The notch of this Mac's screen; null without one (an external display alone). */
  notchInfo(): Promise<NotchInfo | null>;
  /** Sizes and shows the notch window over the notch (0 × 0 hides it); null when there's no notch. */
  notchPlace(width: number, height: number): Promise<NotchInfo | null>;
  /** The current window's size in points (the popover follows its content). */
  resize(width: number, height: number): Promise<void>;
  /** The site in the main window asking this Mac (ADR 0036; the popover answers, `this_mac` in main_window.rs). */
  onThisMac(cb: (id: number, request: ThisMacRequest) => void): () => void;
  thisMacReply(id: number, ok: boolean, data: unknown): Promise<void>;
  /** The Mac's menu bar, in the app's language (only the popover sets it; `app_menu_set` in menus.rs). */
  setAppMenu(labels: Record<string, string>): Promise<void>;
  /** A menu bar choice the popover owns (`menu://action`): updates, quit, access requests, this Mac. */
  onMenuAction(cb: (action: MenuAction) => void): () => void;
  /** The popover listens for the site's requests now (requests sent before that wait, main_window.rs). */
  thisMacListening(): Promise<void>;
  /** Preferências → "Mostrar no Dock" (dock.rs): off, the app lives in the menu bar while no window shows. */
  setDock(show: boolean): Promise<void>;
}

export type MenuAction = "updates" | "quit" | "requests" | "thisMac";
