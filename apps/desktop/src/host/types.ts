import type { HelloLine } from "../control/client";
import type { TrayState } from "../control/tray";

/** The app's windows (Tauri labels). */
export type WindowName = "popover" | "welcome" | "prefs";
export const WINDOW_NAMES: readonly WindowName[] = ["popover", "welcome", "prefs"];

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
  /** The current window's size in points (the popover follows its content). */
  resize(width: number, height: number): Promise<void>;
}
