import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentScope, MachineRequest, RunnerAccess } from "@agenteschat/adapters/machine-protocol";
import {
  BrowserManager,
  type BrowserManagerOptions,
  chromeEnv,
  chromeLaunchArgs,
  type OwnChrome,
  type StreamSocket,
  useOwnFrame,
} from "../../runner/browser";
import { RunnerError } from "../../runner/errors";
import { handleRequest, type RequestScope } from "../../runner/handlers";
import { agentWorkspace } from "../../runner/paths";
import { removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const posix = process.platform !== "win32";
const FAKE = path.join(import.meta.dir, "fake-agent-browser.mjs");
const EXE = "/fake/browsers/chrome-155.0.8059.84/chrome-linux64/chrome";
const dev: AgentScope = { id: "01a142cb-489d-7000-87a3-efb5adb382ca", handle: "dev" };
const XAUTH = "/runner/desktop/01a142cb/Xauthority";

interface FakeChrome {
  args: string[];
  env: Record<string, string> | undefined;
  killed: boolean;
}

/** The agent's desktop as the browser sees it: `log` keeps the order of its starts and Chrome's. */
function fakeDesktops(log: string[]) {
  const d = { viewers: 0, fails: null as string | null };
  const desktops: NonNullable<BrowserManagerOptions["desktops"]> = {
    async ensure(agent) {
      log.push(`desktop ${agent.handle}`);
      if (d.fails) throw new RunnerError("desktop_busy", d.fails);
      return { display: 21, width: 1280, height: 900, startedAt: new Date(0).toISOString(), started: true };
    },
    session: () => ({
      display: 21,
      socket: "/runner/desktop/01a142cb/vnc.sock",
      xauthority: XAUTH,
      home: "/ws/dev-01a142cb/.agentes/home",
      passwords: { full: "Fullpw23", view: "Viewpw34" },
    }),
    status: () => ({ running: true, streams: d.viewers }),
  };
  return Object.assign(d, { desktops });
}

function setup(over: Partial<BrowserManagerOptions> = {}) {
  const ws = tempDir();
  const home = tempDir("runner-home-");
  dirs.push(ws, home);
  process.env.FAKE_AB_LOG = path.join(home, "ab.log");
  process.env.FAKE_AB_STATE = path.join(home, "ab-state.json");
  const log: string[] = [];
  const chromes: FakeChrome[] = [];
  const desk = fakeDesktops(log);
  let clock = 1_000_000;
  const manager = new BrowserManager({
    home,
    log: () => {},
    send: () => true,
    secret: async () => null,
    command: [process.execPath, FAKE],
    chrome: () => EXE,
    isOurChrome: async () => false,
    desktops: desk.desktops,
    now: () => clock,
    idleMs: 60_000,
    async startChrome(_exe, args, _profile, env): Promise<OwnChrome> {
      const c: FakeChrome = { args, env, killed: false };
      chromes.push(c);
      log.push("chrome");
      let quit = () => {};
      const exited = new Promise<void>((resolve) => {
        quit = resolve;
      });
      return {
        pid: 40_000 + chromes.length,
        port: 9300 + chromes.length,
        exited,
        kill: () => {
          c.killed = true;
          quit();
        },
      };
    },
    connectStream: () => {
      const socket: StreamSocket = {
        send() {},
        close() {
          socket.onclose?.();
        },
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      queueMicrotask(() => socket.onopen?.());
      return socket;
    },
    ...over,
  });
  const act = async (command: string, args: string[], desktop: boolean) =>
    manager.act(dev, await agentWorkspace(ws, dev), { op: "browser.act", command, args, timeoutSeconds: 30, desktop });
  const pids = () => JSON.parse(readFileSync(path.join(home, "browser", "chromes.json"), "utf8"));
  const tick = (ms: number) => {
    clock += ms;
  };
  return { ws, home, manager, log, chromes, desk, act, pids, tick };
}

const last = (t: { chromes: FakeChrome[] }) => t.chromes.at(-1) as FakeChrome;
const headed = (c: FakeChrome) => !c.args.includes("--headless=new");

test("headed: maximized on the agent's display, no automation bars, the debugging port still Chrome's pick", () => {
  const args = chromeLaunchArgs(EXE, "/p", "linux", null, true);
  for (const flag of ["--start-maximized", "--test-type=gpu", "--ozone-platform=x11", "--remote-debugging-port=0"]) {
    expect(args).toContain(flag);
  }
  expect(args).toContain("--disable-blink-features=AutomationControlled");
  expect(args).not.toContain("--headless=new");
  expect(args.some((a) => a.startsWith("--window-size"))).toBe(false);
  expect(args.at(-1)).toBe("about:blank");
  expect(chromeLaunchArgs(EXE, "/p", "linux", null, true, "https://shop.example/cart").at(-1)).toBe(
    "https://shop.example/cart",
  );
  // The runner's own Wayland display and session bus stay out: nothing it opens reaches the person's screen.
  expect(
    chromeEnv(
      { display: 21, xauthority: XAUTH },
      { PATH: "/usr/bin", HOME: "/home/r", WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/b" },
    ),
  ).toEqual({ PATH: "/usr/bin", HOME: "/home/r", DISPLAY: ":21", XAUTHORITY: XAUTH });
});

test("headless as before: its own window size, none of the headed flags", () => {
  const args = chromeLaunchArgs(EXE, "/p", "linux", null);
  expect(args).toContain("--headless=new");
  expect(args).toContain("--window-size=1280,800");
  expect(args.some((a) => a.startsWith("--test-type"))).toBe(false);
  for (const flag of ["--start-maximized", "--ozone-platform=x11"]) expect(args).not.toContain(flag);
  expect(args.at(-1)).toBe("about:blank");
});

test("Chrome's own frame, whenever its window manager came up: the profile's other settings stay", () => {
  const profile = tempDir("profile-");
  dirs.push(profile);
  const prefs = path.join(profile, "Default", "Preferences");
  useOwnFrame(profile);
  expect(JSON.parse(readFileSync(prefs, "utf8"))).toEqual({ browser: { custom_chrome_frame: true } });
  writeFileSync(prefs, JSON.stringify({ browser: { window_placement: { maximized: true } }, intl: { a: 1 } }));
  useOwnFrame(profile);
  expect(JSON.parse(readFileSync(prefs, "utf8"))).toEqual({
    browser: { window_placement: { maximized: true }, custom_chrome_frame: true },
    intl: { a: 1 },
  });
  // Not JSON: Chrome's own business.
  writeFileSync(prefs, "{broken");
  useOwnFrame(profile);
  expect(readFileSync(prefs, "utf8")).toBe("{broken");
});

test.if(posix)(
  "on its desktop: the desktop starts first, then Chrome on its display; chromes.json says which",
  async () => {
    const t = setup();
    expect(await t.act("open", ["https://shop.example/"], true)).toMatchObject({ success: true });
    expect(t.log).toEqual(["desktop dev", "chrome"]);
    expect(headed(last(t))).toBe(true);
    expect(last(t).env).toMatchObject({ DISPLAY: ":21", XAUTHORITY: XAUTH });
    const profile = path.join(await agentWorkspace(t.ws, dev), ".agentes", "browser");
    expect(t.pids()).toEqual([{ pid: 40_001, profile, display: 21 }]);
    expect(readFileSync(path.join(profile, "Default", "Preferences"), "utf8")).toContain('"custom_chrome_frame":true');
    // The same Chrome for the next commands: no new desktop start, no new Chrome.
    await t.act("click", ["@e1"], true);
    expect(t.log).toEqual(["desktop dev", "chrome"]);

    // Without the desktop: headless as before, with the runner's own environment.
    const other = setup();
    await other.act("open", ["https://shop.example/"], false);
    expect(other.log).toEqual(["chrome"]);
    expect(headed(last(other))).toBe(false);
    expect(last(other).env).toBeUndefined();
    expect(other.pids()[0].display).toBeUndefined();
    const otherProfile = path.join(await agentWorkspace(other.ws, dev), ".agentes", "browser");
    expect(existsSync(path.join(otherProfile, "Default", "Preferences"))).toBe(false);
  },
);

test.if(posix)("a Chrome in the other mode starts again in this one, on the same profile and page", async () => {
  const t = setup();
  await t.act("open", ["https://shop.example/cart"], false);
  // Reads never move it.
  await t.act("snapshot", [], true);
  expect(t.chromes).toHaveLength(1);
  // The next command that may start Chrome does.
  await t.act("click", ["@e1"], true);
  expect(t.chromes).toHaveLength(2);
  expect(t.chromes[0]?.killed).toBe(true);
  expect(headed(last(t))).toBe(true);
  expect(last(t).args.at(-1)).toBe("https://shop.example/cart");
  const profileOf = (c?: FakeChrome) => c?.args.find((a) => a.startsWith("--user-data-dir="));
  expect(profileOf(last(t))).toBe(profileOf(t.chromes[0]) ?? "no profile");
  expect(t.pids()).toEqual([expect.objectContaining({ pid: 40_002, display: 21 })]);
  // And back off its desktop.
  await t.act("click", ["@e1"], false);
  expect(t.chromes).toHaveLength(3);
  expect(headed(last(t))).toBe(false);
  expect(last(t).env).toBeUndefined();
});

test.if(posix)("never moved while someone watches it or a person's turn is open", async () => {
  const t = setup();
  await t.act("open", ["https://shop.example/"], true);
  // Its live view on the browser card.
  await t.manager.streamStart(dev, "watch");
  await t.act("click", ["@e1"], false);
  expect(t.chromes).toHaveLength(1);
  await t.manager.streamStop(dev);
  // A person's turn.
  t.manager.setHandoff(dev.id, { status: "active", controller: "Ana" });
  await t.act("click", ["@e1"], false);
  expect(t.chromes).toHaveLength(1);
  t.manager.setHandoff(dev.id, null);
  // Someone on its desktop, where it is.
  t.desk.viewers = 1;
  await t.act("click", ["@e1"], false);
  expect(t.chromes).toHaveLength(1);
  t.desk.viewers = 0;
  await t.act("click", ["@e1"], false);
  expect(t.chromes).toHaveLength(2);
  // A headless one comes onto a desktop someone watches: nobody watched the browser itself.
  t.desk.viewers = 1;
  await t.act("click", ["@e1"], true);
  expect(t.chromes).toHaveLength(3);
  expect(headed(last(t))).toBe(true);
});

test.if(posix)(
  "a desktop that can't start leaves Chrome headless, and isn't tried again at every command",
  async () => {
    const t = setup();
    t.desk.fails = "This computer already runs as many desktops as its memory allows";
    expect(await t.act("open", ["https://shop.example/"], true)).toMatchObject({ success: true });
    expect(headed(last(t))).toBe(false);
    await t.act("click", ["@e1"], true);
    expect(t.log).toEqual(["desktop dev", "chrome"]);
    t.desk.fails = null;
    t.tick(5 * 60_000);
    await t.act("click", ["@e1"], true);
    expect(t.log).toEqual(["desktop dev", "chrome", "desktop dev", "chrome"]);
    expect(headed(last(t))).toBe(true);
  },
);

test.if(posix)("in use on its desktop keeps the desktop; its desktop's viewers keep it", async () => {
  const t = setup();
  await t.act("open", ["https://a.example/"], false);
  // Headless: nothing to keep on the desktop.
  expect(t.manager.onDesktopInUse(dev.id)).toBe(false);
  await t.act("open", ["https://a.example/"], true);
  expect(t.manager.onDesktopInUse(dev.id)).toBe(true);
  t.tick(61_000);
  expect(t.manager.onDesktopInUse(dev.id)).toBe(false);
  // Its live view on the browser card keeps it in use however long nobody commands it.
  await t.manager.streamStart(dev, "watch");
  expect(t.manager.onDesktopInUse(dev.id)).toBe(true);
  await t.manager.streamStop(dev);

  // A person working in it through the desktop sends no command: the desktop's viewers count as use.
  t.desk.viewers = 1;
  await t.manager.sweep();
  expect(last(t).killed).toBe(false);
  t.desk.viewers = 0;
  t.tick(59_000);
  await t.manager.sweep();
  expect(last(t).killed).toBe(false);
  t.tick(2_000);
  await t.manager.sweep();
  expect(last(t).killed).toBe(true);
});

test.if(posix)("the request's desktop counts only while the machine's desktop switch is on", async () => {
  const t = setup();
  let access: RunnerAccess = {
    folders: [],
    tools: { claude: false, codex: false, commands: true, browser: true, desktop: false },
  };
  const scope: RequestScope = { signal: new AbortController().signal, output: () => {} };
  const ctx = { workspaceReal: t.ws, exec: true, token: "agm_x", access: () => access, browser: t.manager };
  const open: MachineRequest = {
    agent: dev,
    op: "browser.act",
    command: "open",
    args: ["https://a.example"],
    timeoutSeconds: 5,
    desktop: true,
  };
  await handleRequest(ctx, open, scope);
  expect(t.log).toEqual(["chrome"]);
  access = { ...access, tools: { ...access.tools, desktop: true } };
  await handleRequest(ctx, open, scope);
  expect(t.log).toEqual(["chrome", "desktop dev", "chrome"]);
  expect(headed(last(t))).toBe(true);
  // A batch too.
  access = { ...access, tools: { ...access.tools, desktop: false } };
  await handleRequest(
    ctx,
    {
      agent: dev,
      op: "browser.batch",
      commands: [{ command: "click", args: ["@e1"], timeoutSeconds: 5 }],
      desktop: true,
    },
    scope,
  );
  expect(t.chromes).toHaveLength(3);
  expect(headed(last(t))).toBe(false);
});
