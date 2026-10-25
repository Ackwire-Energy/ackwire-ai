/**
 * The host for a plain browser (`bun run dev`): fake runners and servers in memory instead of the Tauri
 * shell, so the screens can be designed and checked without building the app. One page shows one window at
 * a time; `showWindow` switches it (the dev bar does too) and keeps the fake state.
 *
 * Scenarios (`?scenario=`): `first` (a Mac, nothing chosen yet), `windows` and `linux` (the same there),
 * `cloud` (agentes.chat, nothing on this computer), `selfhost` (the default: a server on Tailscale with two
 * organizations whose agents work here) and `link` (a connect link waiting, `?link=` or a claim link).
 * Servers answer by host: agentes.tail1234.ts.net, agentes.chat and http://127.0.0.1:4310 are servers;
 * noowner.tail1234.ts.net waits for its owner; old.example.com is too old; chat.example.com doesn't answer;
 * anything else isn't agentes.chat. `?found=0` makes discovery find nothing.
 */
import { CLOUD_SERVER, readInstance, type ServerCheck } from "@agenteschat/client/lib/server";
import type { Candidate } from "../control/first-run";
import type { Platform } from "../control/platform";
import type { ServerList } from "../control/server";
import type { TrayState } from "../control/tray";
import { acmeSeed, FAKE_SERVER, FakeRunner, horizonteSeed } from "../dev/fake-runner";
import type { AppInfo, Host, RunnerInfo, RunnerStateChange, WindowName } from "./types";

export type Scenario = "first" | "windows" | "linux" | "cloud" | "selfhost" | "link";
export const SCENARIOS: readonly Scenario[] = ["first", "windows", "linux", "cloud", "selfhost", "link"];

export interface FakeHost extends Host {
  window: WindowName;
  readonly runners: Map<string, FakeRunner>;
  readonly tray: TrayState;
  readonly list: ServerList;
  onDev(cb: () => void): () => void;
  setVersion(version: string): void;
}

/** A 14" MacBook Pro's notch. */
const FAKE_NOTCH = { width: 186, height: 32 };
/** A claim link as the setup prints it, for the `link` scenario. */
const CLAIM_LINK = `agenteschat://connect?server=${encodeURIComponent(FAKE_SERVER)}&claim=b3duZXItY2xhaW0tYWJjZGVmZ2hpamtsbW5vcHFy`;

const instance = (url: string, over: Record<string, unknown> = {}) => ({
  name: "agentes.chat",
  version: "1.4.0",
  api: 1,
  minApi: 1,
  url,
  signIn: { email: true, google: false, github: false, apple: false },
  signup: "invite",
  ...over,
});

/** What each fake server answers to `GET /api/instance` (the host decides); `waits`: the link's server has no owner yet. */
function fakeCheck(server: string, waits: boolean): ServerCheck {
  const host = new URL(server).host;
  if (host === "chat.example.com") return { ok: false, server, problem: "unreachable" };
  if (host === "noowner.tail1234.ts.net") return readInstance(server, instance(server, { ownerClaim: true }));
  if (host === "old.example.com") return readInstance(server, instance(server, { api: 0, minApi: 0 }));
  if (server === FAKE_SERVER || server === CLOUD_SERVER || server === "http://127.0.0.1:4310")
    return readInstance(server, instance(server, waits && server === FAKE_SERVER ? { ownerClaim: true } : {}));
  return readInstance(server, { status: "ok" });
}

export function createFakeHost(
  initial: WindowName,
  scenario: Scenario,
  options: { link?: string | null; found?: boolean } = {},
): FakeHost {
  const runners = new Map<string, FakeRunner>();
  const lineListeners = new Set<(homeId: string, line: string) => void>();
  const stateListeners = new Set<(c: RunnerStateChange) => void>();
  const shownListeners = new Set<(n: WindowName) => void>();
  const devListeners = new Set<() => void>();
  let signIns = 0;
  let tray: TrayState = "idle";
  let autostart = true;
  let version = "0.6.0";
  const platform: Platform = scenario === "windows" ? "windows" : scenario === "linux" ? "linux" : "mac";
  const list: ServerList =
    scenario === "cloud"
      ? { current: CLOUD_SERVER, servers: [CLOUD_SERVER] }
      : scenario === "selfhost"
        ? { current: FAKE_SERVER, servers: [FAKE_SERVER, CLOUD_SERVER] }
        : { current: null, servers: [] };
  let link: string | null = scenario === "link" ? (options.link ?? CLAIM_LINK) : null;
  const waits = link?.includes("claim=") ?? false;
  const devChanged = () => {
    for (const l of devListeners) l();
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  if (scenario === "selfhost") {
    spawn("a1b2c3d4", acmeSeed());
    spawn("e5f6a7b8", horizonteSeed());
    signIns = 2;
  }

  const host: FakeHost = {
    window: initial,
    fake: true,
    platform,
    runners,
    list,
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
      console.info("[fake] open:", url);
    },
    servers: async () => ({ current: list.current, servers: [...list.servers] }),
    chooseServer: async (server, page) => {
      if (!list.servers.includes(server)) list.servers.push(server);
      list.current = server;
      console.info("[fake] main window on", server + (page ?? ""));
      devChanged();
    },
    removeServer: async (server) => {
      list.servers = list.servers.filter((s) => s !== server);
      if (list.current === server) list.current = list.servers[0] ?? null;
      devChanged();
    },
    discover: async (): Promise<Candidate[]> => {
      await wait(1200);
      if (options.found === false) return [];
      return [
        { server: "http://127.0.0.1:4310", where: "here" },
        { server: FAKE_SERVER, where: "tailnet" },
      ];
    },
    checkServer: async (server) => {
      await wait(700);
      return fakeCheck(server, waits);
    },
    takeLink: async () => {
      const taken = link;
      link = null;
      return taken;
    },
    onLink: () => () => {},
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
    setTrayVisible: async () => {},
    showWindow: async (name) => {
      host.window = name;
      devChanged();
      for (const l of shownListeners) l(name);
    },
    hideWindow: async (name) => {
      console.info("[fake] hide", name);
    },
    quit: async () => {
      console.info("[fake] quit");
    },
    appInfo: async (): Promise<AppInfo> => ({
      version,
      os: platform === "mac" ? "macos" : platform,
      arch: platform === "mac" ? "aarch64" : "x86_64",
    }),
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
    setSiteNotify: async () => {},
    onBadge: (cb) => {
      const timer = setTimeout(() => cb({ waiting: 3, unread: 5 }), 50);
      return () => clearTimeout(timer);
    },
    notify: async (title, body) => {
      console.info("[fake] notification:", title, "—", body);
    },
    installUpdate: async () => {
      console.info("[fake] install update and relaunch");
      await wait(1500);
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
