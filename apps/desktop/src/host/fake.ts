/**
 * The host for a plain browser (`bun run dev`): fake runners in memory instead of the Tauri shell,
 * so the screens can be designed and checked without building the app. One page shows one window at
 * a time; `showWindow` switches it (the dev bar does too) and keeps the fake state.
 */
import type { TrayState } from "../control/tray";
import { acmeSeed, FakeRunner, horizonteSeed } from "../dev/fake-runner";
import type { AppInfo, Host, RunnerInfo, RunnerStateChange, WindowName } from "./types";

export interface FakeHost extends Host {
  window: WindowName;
  readonly runners: Map<string, FakeRunner>;
  readonly tray: TrayState;
  onDev(cb: () => void): () => void;
  setVersion(version: string): void;
}

/** A 14" MacBook Pro's notch. */
const FAKE_NOTCH = { width: 186, height: 32 };

export function createFakeHost(initial: WindowName, scenario: "first" | "default"): FakeHost {
  const runners = new Map<string, FakeRunner>();
  const lineListeners = new Set<(homeId: string, line: string) => void>();
  const stateListeners = new Set<(c: RunnerStateChange) => void>();
  const shownListeners = new Set<(n: WindowName) => void>();
  const devListeners = new Set<() => void>();
  let signIns = 0;
  let tray: TrayState = "idle";
  let autostart = true;
  let version = "0.1.0";
  const devChanged = () => {
    for (const l of devListeners) l();
  };

  const spawn = (homeId: string, seed: ReturnType<typeof acmeSeed> | null) => {
    const runner = new FakeRunner(
      homeId,
      seed,
      (line) => {
        for (const l of lineListeners) l(homeId, line);
      },
      () => signIns++,
    );
    runners.set(homeId, runner);
    setTimeout(() => {
      runner.start();
      for (const l of stateListeners) l({ homeId, running: true, removed: false });
    }, 30);
  };

  if (scenario === "default") {
    spawn("a1b2c3d4", acmeSeed());
    spawn("e5f6a7b8", horizonteSeed());
    signIns = 2;
  }

  const host: FakeHost = {
    window: initial,
    fake: true,
    runners,
    get tray() {
      return tray;
    },
    listRunners: async (): Promise<RunnerInfo[]> =>
      [...runners.keys()].map((homeId) => ({
        homeId,
        dir: `/Users/voce/.agentes-runner/orgs/${homeId}`,
        running: true,
        hello: {
          type: "hello",
          control: 1,
          version: "0.1.0",
          protocol: 10,
          home: `/Users/voce/.agentes-runner/orgs/${homeId}`,
        },
      })),
    send: async (homeId, line) => {
      const r = runners.get(homeId);
      if (!r) throw new Error("not running");
      r.handle(line);
    },
    addRunner: async () => {
      const id = Math.random().toString(16).slice(2, 10);
      spawn(id, null);
      return id;
    },
    removeRunner: async (homeId) => {
      runners.get(homeId)?.stop();
      runners.delete(homeId);
      for (const l of stateListeners) l({ homeId, running: false, removed: true });
    },
    onLine: (cb) => {
      lineListeners.add(cb);
      return () => lineListeners.delete(cb);
    },
    onRunnerState: (cb) => {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    onShown: (cb) => {
      shownListeners.add(cb);
      return () => shownListeners.delete(cb);
    },
    openExternal: async (url) => {
      console.info("[fake] open in the browser:", url);
    },
    setServer: async () => {},
    revealFolder: async (path) => {
      console.info("[fake] show in Finder:", path);
    },
    pickFolder: async () => {
      const picks = ["/Users/voce/Documents/Notas", "/Users/voce/Projects/Personal/site", "/Users/voce/Desktop/Fotos"];
      return picks[Math.floor(Math.random() * picks.length)] ?? null;
    },
    setTrayState: async (state) => {
      if (tray !== state) {
        tray = state;
        devChanged();
      }
    },
    showWindow: async (name) => {
      host.window = name;
      devChanged();
      for (const l of shownListeners) l(name);
    },
    hideWindow: async () => {},
    quit: async () => {
      console.info("[fake] quit");
    },
    appInfo: async (): Promise<AppInfo> => ({ version, os: "macos", arch: "aarch64" }),
    autostart: async () => autostart,
    setAutostart: async (on) => {
      autostart = on;
    },
    // No main window in the browser: nobody asks.
    onThisMac: () => () => {},
    thisMacReply: async () => {},
    // No menu bar in the browser.
    setAppMenu: async () => {},
    onMenuAction: () => () => {},
    thisMacListening: async () => {},
    setDock: async () => {},
    notify: async (title, body) => {
      console.info("[fake] notification:", title, "—", body);
    },
    installUpdate: async () => {
      console.info("[fake] install update and relaunch");
      await new Promise((r) => setTimeout(r, 1500));
      return false;
    },
    setNotch: async (on) => {
      console.info("[fake] notch:", on ? "on" : "off");
    },
    notchInfo: async () => FAKE_NOTCH,
    notchPlace: async () => FAKE_NOTCH,
    resize: async () => {},
    onDev: (cb) => {
      devListeners.add(cb);
      return () => devListeners.delete(cb);
    },
    setVersion: (v) => {
      version = v;
    },
  };
  return host;
}
