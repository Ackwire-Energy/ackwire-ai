import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import type { AgentScope, MachineRequest, RunnerAccess } from "@agenteschat/adapters/machine-protocol";
import { systemLauncher } from "../../runner/agent-users";
import { LOOK_MARKER, LOOK_SCRIPT, type LookOptions, lookFiles, lookId } from "../../runner/desktop-look";
import {
  DesktopSessions,
  type DesktopSessionsOptions,
  type DesktopSpawnOptions,
  type DesktopSystem,
  type DesktopUser,
  memAvailableBytes,
  PARK_AFTER_MS,
  runnerUser,
  systemDesktopUser,
  vncPasswordFile,
} from "../../runner/desktop-session";
import { RunnerError } from "../../runner/errors";
import { handleRequest, type RequestScope } from "../../runner/handlers";
import { errorCode, removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const posix = process.platform !== "win32";
const dev: AgentScope = { id: "01a142cb-489d-7000-87a3-efb5adb382ca", handle: "dev", name: "Dev" };
const ops: AgentScope = { id: "9f00aa11-0000-7000-8000-000000000000", handle: "ops" };
const GiB = 1024 ** 3;

interface FakeProc {
  pid: number;
  argv: string[];
  opts: DesktopSpawnOptions;
  alive: boolean;
  exit(code: number | null): void;
}

const commandOf = (p: FakeProc) =>
  p.argv.includes("agentes-look")
    ? "agentes-look"
    : p.argv.map((a) => path.basename(a)).find((a) => a === "sh" || a === "Xtigervnc" || a === "dbus-launch");

/**
 * A computer with no X: the prepare script makes its folders, the look's
 * script only answers, "Xtigervnc" takes its display's lock and socket, and
 * every process lives until killed (`hangs`: the prepare's or the look's too).
 */
function fakeComputer(lockDir: string) {
  const procs: FakeProc[] = [];
  /** Live processes that aren't ours (pid → command line). */
  const others = new Map<number, string[]>();
  const kills: [number, string][] = [];
  let nextPid = 4000;
  let xvncFails: string | null = null;
  let lookFails = false;
  const files = new Set<string>();
  const hangs = new Set<string>();
  const system: DesktopSystem = {
    platform: "linux",
    pty: true,
    runtime: "Bun 1.4.4",
    uid: 1000,
    which: (command) => `/usr/bin/${command}`,
    exists: (file) => files.has(file),
    spawn(argv, opts) {
      let settle: (code: number | null) => void = () => undefined;
      const exited = new Promise<number | null>((resolve) => {
        settle = resolve;
      });
      const p: FakeProc = {
        pid: nextPid++,
        argv,
        opts,
        alive: true,
        exit(code) {
          if (!p.alive) return;
          p.alive = false;
          settle(code);
        },
      };
      procs.push(p);
      const command = commandOf(p);
      if (hangs.has(command ?? "")) {
        // held up: it ends only when killed
      } else if (command === "agentes-look") {
        queueMicrotask(() => p.exit(lookFails ? 1 : 0));
      } else if (command === "sh") {
        for (const dir of argv.slice(-4, -2)) mkdirSync(dir, { recursive: true });
        queueMicrotask(() => p.exit(0));
      } else if (command === "Xtigervnc" && xvncFails !== null) {
        if (opts.log !== undefined) writeSync(opts.log, `${xvncFails}\n`);
        queueMicrotask(() => p.exit(1));
      } else if (command === "Xtigervnc") {
        const display = argv[argv.findIndex((a) => path.basename(a) === "Xtigervnc") + 1] ?? "";
        writeFileSync(path.join(lockDir, `.X${display.slice(1)}-lock`), `${String(p.pid).padStart(10)}\n`);
        writeFileSync(argv[argv.indexOf("-rfbunixpath") + 1] as string, "");
      }
      return { pid: p.pid, exited };
    },
    cmdline(pid) {
      const p = procs.find((x) => x.pid === pid);
      if (p?.alive) return p.argv.slice(p.argv.findIndex((a) => commandOf({ ...p, argv: [a] }) !== undefined));
      return others.get(pid) ?? null;
    },
    kill(pid, signal) {
      kills.push([pid, signal]);
      procs.find((x) => x.pid === pid)?.exit(null);
    },
  };
  const of = (command: string) => procs.filter((p) => commandOf(p) === command);
  return {
    system,
    procs,
    others,
    kills,
    of,
    failXvnc(message: string | null) {
      xvncFails = message;
    },
    failLook(fails: boolean) {
      lookFails = fails;
    },
    /** Files the computer has (`exists`). */
    files,
    /** Commands that never end by themselves ("sh": the prepare, "agentes-look"). */
    hangs,
  };
}

/** A runner that is gone: it never hears its desktops end. */
const gone = (system: DesktopSystem): DesktopSystem => ({
  ...system,
  spawn(argv, opts) {
    const p = system.spawn(argv, opts);
    return opts.detached ? { pid: p.pid, exited: new Promise<number | null>(() => undefined) } : p;
  },
});

const RUNNER = ["/opt/agentes-runner/agentes-runner"];

function setup(over: Partial<DesktopSessionsOptions> = {}) {
  // Short: Browser's socket goes in the runner's home, and a Unix socket's path has at most 103 bytes on macOS.
  const home = tempDir("dsk-");
  const lockDir = tempDir("desk-x-");
  const folders = tempDir("desk-ws-");
  dirs.push(home, lockDir, folders);
  const fake = fakeComputer(lockDir);
  const logs: string[] = [];
  const clock = { now: 1_000_000 };
  const opts: DesktopSessionsOptions = {
    home,
    log: (line) => logs.push(line),
    user: async (agent) => runnerUser(home, path.join(folders, agent.handle), agent),
    system: fake.system,
    lockDir,
    // Plenty free: parking only where a test says memory runs short.
    memAvailable: () => 4 * GiB,
    now: () => clock.now,
    runner: RUNNER,
    ...over,
  };
  const desktops = new DesktopSessions(opts);
  return { home, lockDir, folders, fake, logs, clock, opts, desktops };
}

/** The look a desktop of `agent` gets on this computer (single-user: Browser's socket in the runner's home). */
async function lookOf(t: ReturnType<typeof setup>, agent: AgentScope, over: Partial<LookOptions> = {}) {
  const user = await t.opts.user(agent);
  return {
    theme: "stock",
    dock: "panel",
    agent,
    shell: user.env.SHELL ?? "",
    browser: [...RUNNER, "desktop-browser", path.join(user.dir, "browser.sock")],
    ...over,
  } satisfies LookOptions;
}

/** What Browser's socket answers one click (`open`). */
function click(socket: string): Promise<string> {
  return new Promise((resolve) => {
    let got = "";
    const conn = createConnection(socket);
    conn.setEncoding("utf8");
    conn.on("connect", () => conn.write("open\n"));
    conn.on("data", (chunk: string) => {
      got += chunk;
    });
    conn.on("error", (err) => resolve(`${got}${err.message}`));
    conn.on("close", () => resolve(got));
  });
}

const flagValue = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

test("the password file: each password DES-encrypted with VNC's fixed key, the full one first", () => {
  expect(vncPasswordFile("password", "password").toString("hex")).toBe("dbd83cfd727a1458dbd83cfd727a1458");
  const file = vncPasswordFile("password", "Viewpw34");
  expect(file.length).toBe(16);
  expect(file.subarray(0, 8).toString("hex")).toBe("dbd83cfd727a1458");
  expect(file.subarray(8)).toEqual(vncPasswordFile("Viewpw34", "x").subarray(0, 8));
});

test("the memory available: MemAvailable from /proc/meminfo, in bytes; none when it isn't there", () => {
  const meminfo =
    "MemTotal:        8131956 kB\nMemFree:          912340 kB\nMemAvailable:    5932248 kB\nBuffers: 1 kB\n";
  expect(memAvailableBytes(meminfo)).toBe(5932248 * 1024);
  expect(memAvailableBytes("MemTotal:        8131956 kB\n")).toBeNull();
});

test("info: Linux, the runner on Bun 1.3.5 or newer, and the packages (installed without recommends)", () => {
  const t = setup();
  expect(t.desktops.info()).toEqual({ available: true, width: 1280, height: 900 });
  const ask = (system: Partial<DesktopSystem>) =>
    new DesktopSessions({ ...t.opts, system: { ...t.fake.system, ...system } }).info();
  expect(ask({ platform: "darwin" })).toMatchObject({ available: false, reason: expect.stringContaining("Linux") });
  expect(ask({ pty: false, runtime: "Node 22.12.0" }).reason).toContain("Bun 1.3.5 or newer (it runs on Node 22.12.0)");
  const missing = ask({ which: (c) => (c === "Xtigervnc" || c === "dbus-launch" ? null : `/usr/bin/${c}`) });
  expect(missing.available).toBe(false);
  expect(missing.reason).toContain(
    "sudo apt install --no-install-recommends tigervnc-standalone-server xauth dbus-x11",
  );
  expect(missing.reason).toContain("(missing: tigervnc-standalone-server, dbus-x11)");
  expect(missing.reason?.length).toBeLessThanOrEqual(500);
  expect(ask({ uid: 0 }).reason).toContain("never run as root");
});

test("a runner running as root starts a desktop only through a launcher that runs it as the agent", async () => {
  const t = setup();
  const root = { ...t.fake.system, uid: 0 };
  expect(await errorCode(() => new DesktopSessions({ ...t.opts, system: root }).ensure(dev))).toBe(
    "desktop_unavailable",
  );
  // Said to run agents as their own users, yet given no launcher: still never as root.
  const unlaunched = new DesktopSessions({ ...t.opts, system: root, agentUsers: true });
  expect(unlaunched.info().available).toBe(true);
  expect(await errorCode(() => unlaunched.ensure(dev))).toBe("desktop_unavailable");
  expect(t.fake.procs).toHaveLength(0);
  const prefix = ["/usr/sbin/runuser", "-u", "ag-01a142cb", "--"];
  const user = async (agent: AgentScope) => ({ ...(await t.opts.user(agent)), prefix });
  const launched = new DesktopSessions({ ...t.opts, system: root, agentUsers: true, user });
  await launched.ensure(dev);
  expect(t.fake.procs.length).toBeGreaterThan(0);
  for (const p of t.fake.procs) expect(p.argv.slice(0, prefix.length)).toEqual(prefix);
  launched.close();
});

test("start: Xvnc on a Unix socket only, VncAuth, never resized; the cookie and passwords never in an argument", async () => {
  const t = setup();
  const reply = await t.desktops.ensure(dev);
  expect(reply).toMatchObject({ display: 20, width: 1280, height: 900, started: true });
  const [prepare] = t.fake.of("sh");
  const [xvnc] = t.fake.of("Xtigervnc");
  const [session] = t.fake.of("dbus-launch");
  if (!prepare || !xvnc || !session) throw new Error("not started");
  const dir = path.join(t.home, "desktop", "01a142cb");

  // The cookie goes to xauth on stdin; the folder and HOME are made by the agent's user.
  expect(prepare.opts.input).toMatch(/^add :20 \. [0-9a-f]{32}\n$/);
  expect(prepare.argv.slice(-4, -2)).toEqual([dir, path.join(t.folders, "dev", ".agentes", "home")]);
  expect(prepare.argv.at(-2)).toContain('<property name="ssh-agent" type="empty">');
  expect(prepare.argv.at(-1)).toContain('<property name="vblank_mode" type="string" value="off"/>');
  const cookie = prepare.opts.input?.split(" ")[3]?.trim() ?? "";
  expect(cookie).toMatch(/^[0-9a-f]{32}$/);

  expect(xvnc.argv[0]).toBe("/usr/bin/Xtigervnc");
  expect(xvnc.argv[1]).toBe(":20");
  expect(flagValue(xvnc.argv, "-rfbport")).toBe("-1");
  expect(flagValue(xvnc.argv, "-rfbunixpath")).toBe(path.join(dir, "vnc.sock"));
  expect(flagValue(xvnc.argv, "-rfbunixmode")).toBe("0600");
  expect(flagValue(xvnc.argv, "-SecurityTypes")).toBe("VncAuth");
  expect(flagValue(xvnc.argv, "-PasswordFile")).toBe(path.join(dir, "passwd"));
  expect(flagValue(xvnc.argv, "-auth")).toBe(path.join(dir, "Xauthority"));
  expect(flagValue(xvnc.argv, "-nolisten")).toBe("tcp");
  expect(flagValue(xvnc.argv, "-geometry")).toBe("1280x900");
  expect(flagValue(xvnc.argv, "-desktop")).toBe("Dev");
  for (const flag of ["-AcceptSetDesktopSize=0", "-FrameRate=30", "-UseBlacklist=0", "-AlwaysShared"]) {
    expect(xvnc.argv).toContain(flag);
  }
  for (const flag of ["-ac", "-nopw", "-localhost", "-interface", "-rfbauth"]) expect(xvnc.argv).not.toContain(flag);
  expect(xvnc.opts.detached).toBe(true);

  const live = t.desktops.session(dev.id);
  if (!live) throw new Error("no session");
  expect(live.passwords.full).toMatch(/^[A-Za-z2-9]{8}$/);
  expect(live.passwords.view).not.toBe(live.passwords.full);
  const passwd = path.join(dir, "passwd");
  expect(readFileSync(passwd).toString("hex")).toBe(
    vncPasswordFile(live.passwords.full, live.passwords.view).toString("hex"),
  );
  expect(statSync(passwd).mode & 0o777).toBe(0o600);
  for (const p of t.fake.procs) {
    for (const part of [...p.argv, ...Object.values(p.opts.env)]) {
      for (const secret of [cookie, live.passwords.full, live.passwords.view]) expect(part).not.toContain(secret);
    }
  }

  // XFCE gets only the session's variables: nothing of the runner's own environment.
  expect(session.argv.slice(1)).toEqual(["--exit-with-session", "xfce4-session"]);
  expect(session.opts.detached).toBe(true);
  expect(Object.keys(session.opts.env).sort()).toEqual(
    [
      "ACCESSIBILITY_ENABLED",
      "DISPLAY",
      "HOME",
      "LANG",
      "LC_ALL",
      "LOGNAME",
      "PATH",
      "QT_LINUX_ACCESSIBILITY_ALWAYS_ON",
      "SHELL",
      "USER",
      "XAUTHORITY",
      "XDG_CURRENT_DESKTOP",
      "XDG_SESSION_TYPE",
    ].sort(),
  );
  expect(session.opts.env).toMatchObject({
    DISPLAY: ":20",
    XAUTHORITY: path.join(dir, "Xauthority"),
    HOME: path.join(t.folders, "dev", ".agentes", "home"),
    ACCESSIBILITY_ENABLED: "1",
    QT_LINUX_ACCESSIBILITY_ALWAYS_ON: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    XDG_CURRENT_DESKTOP: "XFCE",
  });
  expect(statSync(path.join(t.home, "desktop", "01a142cb.json")).mode & 0o777).toBe(0o600);

  // Idempotent: a running desktop is only marked used.
  t.clock.now += 60_000;
  expect(await t.desktops.ensure(dev)).toMatchObject({ display: 20, started: false });
  expect(t.fake.of("Xtigervnc")).toHaveLength(1);
  expect(t.desktops.status(dev)).toEqual({
    running: true,
    startedAt: new Date(1_000_000).toISOString(),
    lastUsedAt: new Date(1_060_000).toISOString(),
    streams: 0,
  });
  t.desktops.close();
});

test("prepare: xfwm4 never waits for a vblank, in a fresh home and in the settings file xfwm4 already wrote", async () => {
  // The real scripts (the prepare and the look's), with an xauth that only takes its cookie.
  const bin = tempDir("desk-bin-");
  dirs.push(bin);
  writeFileSync(path.join(bin, "xauth"), "#!/bin/sh\ncat > /dev/null\n", { mode: 0o755 });
  const t = setup();
  const system: DesktopSystem = {
    ...t.fake.system,
    spawn(argv, opts) {
      if (path.basename(argv[0] ?? "") !== "sh") return t.fake.system.spawn(argv, opts);
      const run = Bun.spawnSync(argv, { env: { PATH: `${bin}:/usr/bin:/bin` }, stdin: Buffer.from(opts.input ?? "") });
      return { pid: 1, exited: Promise.resolve(run.exitCode) };
    },
  };
  const desktops = new DesktopSessions({ ...t.opts, system });
  const xfconf = path.join(t.folders, "dev", ".agentes", "home", ".config", "xfce4", "xfconf", "xfce-perchannel-xml");
  const settings = path.join(xfconf, "xfwm4.xml");

  await desktops.ensure(dev);
  expect(readFileSync(settings, "utf8")).toContain('<property name="vblank_mode" type="string" value="off"/>');
  expect(readFileSync(path.join(xfconf, "xfce4-session.xml"), "utf8")).toContain('name="ssh-agent"');
  // The look's own xfwm4 settings came after, the vblank still off.
  expect(readFileSync(settings, "utf8")).toContain('name="margin_bottom"');
  const home = path.join(t.folders, "dev", ".agentes", "home");
  expect(readFileSync(path.join(home, LOOK_MARKER), "utf8")).toBe(`${lookId(home, await lookOf(t, dev))}\n`);

  // xfwm4 writes every setting it has on its first start; the next start changes that one only.
  const own = [
    '<?xml version="1.1" encoding="UTF-8"?>',
    "",
    '<channel name="xfwm4" version="1.0">',
    '  <property name="general" type="empty">',
    '    <property name="use_compositing" type="bool" value="true"/>',
    '    <property name="vblank_mode" type="string" value="auto"/>',
    '    <property name="workspace_count" type="int" value="4"/>',
    "  </property>",
    "</channel>",
    "",
  ].join("\n");
  writeFileSync(settings, own);
  await desktops.stop(dev);
  await desktops.ensure(dev);
  expect(readFileSync(settings, "utf8")).toBe(own.replace('value="auto"', 'value="off"'));
  desktops.close();
});

test("the look: written as the agent into its desktop's HOME, after the prepare and before X starts", async () => {
  const t = setup();
  await t.desktops.ensure(dev);
  const [prepare] = t.fake.of("sh");
  const [look] = t.fake.of("agentes-look");
  const [xvnc] = t.fake.of("Xtigervnc");
  if (!prepare || !look || !xvnc) throw new Error("not started");
  expect(t.fake.procs.indexOf(prepare)).toBeLessThan(t.fake.procs.indexOf(look));
  expect(t.fake.procs.indexOf(look)).toBeLessThan(t.fake.procs.indexOf(xvnc));
  const home = path.join(t.folders, "dev", ".agentes", "home");
  const stock = await lookOf(t, dev);
  // Browser runs this runner's own command, with the desktop's socket next to its cookie and password file.
  expect(stock.browser).toEqual([
    ...RUNNER,
    "desktop-browser",
    path.join(t.home, "desktop", "01a142cb", "browser.sock"),
  ]);
  expect(look.argv).toEqual([
    "/bin/sh",
    "-c",
    LOOK_SCRIPT,
    "agentes-look",
    home,
    lookId(home, stock),
    LOOK_MARKER,
    String(lookFiles(home, stock).length),
  ]);
  expect(look.opts).toMatchObject({ cwd: "/", env: { HOME: home } });
  expect(look.opts.input?.startsWith(".config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml ")).toBe(true);
  await t.desktops.stop(dev);

  // A computer with Orchis and gdk-pixbuf's SVG loader gets its theme; one with docklike, its dock.
  t.fake.files.add("/usr/share/themes/Orchis-Light/xfwm4/themerc");
  t.fake.files.add("/usr/lib/x86_64-linux-gnu/gdk-pixbuf-2.0/2.10.0/loaders/libpixbufloader_svg.so");
  await t.desktops.ensure(dev);
  expect(t.fake.of("agentes-look").at(-1)?.argv[5]).toBe(lookId(home, await lookOf(t, dev, { theme: "orchis" })));
  await t.desktops.stop(dev);
  t.fake.files.add("/usr/share/xfce4/panel/plugins/docklike.desktop");
  t.fake.files.add("/usr/lib/x86_64-linux-gnu/xfce4/panel/plugins/libdocklike.so");
  await t.desktops.ensure(dev);
  expect(t.fake.of("agentes-look").at(-1)?.argv[5]).toBe(
    lookId(home, await lookOf(t, dev, { theme: "orchis", dock: "docklike" })),
  );
  t.desktops.close();
});

test.if(posix)(
  "Browser on the desktop: a socket while the desktop runs, and a click on it asks the runner for that agent's browser",
  async () => {
    const asked: string[] = [];
    let refusal: string | null = null;
    const t = setup({
      openBrowser: async (agent, installing) => {
        asked.push(agent.handle);
        if (refusal) throw new RunnerError("not_allowed", refusal);
        if (agent.handle === "ops") installing();
      },
    });
    await t.desktops.ensure(dev);
    const socket = path.join(t.home, "desktop", "01a142cb", "browser.sock");
    expect(statSync(socket).isSocket()).toBe(true);
    expect(await click(socket)).toBe("ok\n");
    expect(asked).toEqual(["dev"]);
    // Refused: the launcher hears the code, the runner's log the reason.
    refusal = "The browser is turned off on this computer";
    expect(await click(socket)).toBe("error not_allowed\n");
    expect(t.logs).toContain("Browser on the desktop of dev didn't open: The browser is turned off on this computer");
    refusal = null;
    asked.length = 0;
    expect(await click(socket)).toBe("ok\n");
    expect(asked).toEqual(["dev"]);
    // Each desktop its own: ops's click is ops's.
    await t.desktops.ensure(ops);
    expect(await click(path.join(t.home, "desktop", "9f00aa11", "browser.sock"))).toBe("installing\nok\n");
    expect(asked).toEqual(["dev", "ops"]);
    // Gone with its desktop.
    await t.desktops.stop(dev);
    expect(existsSync(socket)).toBe(false);
    t.desktops.close();
    await t.desktops.stopAll();

    // A runner that can't open the agent's browser makes no socket for it.
    const none = setup();
    await none.desktops.ensure(dev);
    expect(existsSync(path.join(none.home, "desktop", "01a142cb", "browser.sock"))).toBe(false);
    none.desktops.close();
  },
);

test.if(posix)("a desktop taken back by the next runner gets its Browser's socket again", async () => {
  const asked: string[] = [];
  const t = setup();
  const before = new DesktopSessions({ ...t.opts, system: gone(t.fake.system) });
  await before.ensure(dev);
  before.close();
  const next = new DesktopSessions({ ...t.opts, openBrowser: async (agent) => void asked.push(agent.handle) });
  next.restore();
  const socket = path.join(t.home, "desktop", "01a142cb", "browser.sock");
  await waitFor(() => existsSync(socket));
  expect(await click(socket)).toBe("ok\n");
  expect(asked).toEqual(["dev"]);
  await next.stopAll();
});

test("a look that can't be written never stops the desktop: it starts as its HOME has it", async () => {
  const t = setup();
  t.fake.failLook(true);
  expect(await t.desktops.ensure(dev)).toMatchObject({ started: true });
  expect(t.desktops.status(dev).running).toBe(true);
  expect(t.logs.some((l) => l.includes("keeps the look its home has"))).toBe(true);
  t.desktops.close();
});

test("a step before X that is held up (a pipe in the HOME, a hung disk) is stopped: never the agent's desktop", async () => {
  const t = setup({ stepMs: 30 });
  t.fake.hangs.add("agentes-look");
  expect(await t.desktops.ensure(dev)).toMatchObject({ started: true });
  const [look] = t.fake.of("agentes-look");
  expect(t.fake.kills).toContainEqual([look?.pid ?? 0, "SIGTERM"]);
  expect(t.logs).toContainEqual(expect.stringContaining("writing the agentes.chat look was stopped after 0.03 s"));
  await t.desktops.stop(dev);

  // The prepare held up: that start fails, the display is free again, and the next start goes on.
  t.fake.hangs.clear();
  t.fake.hangs.add("sh");
  expect(await errorCode(() => t.desktops.ensure(dev))).toBe("internal");
  const [, prepare] = t.fake.of("sh");
  expect(t.fake.kills).toContainEqual([prepare?.pid ?? 0, "SIGTERM"]);
  t.fake.hangs.clear();
  expect(await t.desktops.ensure(dev)).toMatchObject({ display: 20, started: true });
  t.desktops.close();
});

test("system mode: every process as the agent, and the password file root's (readable by the agent's group only)", async () => {
  const root = tempDir("desk-sys-");
  // Root's own folder for the desktops (`/run/agentes-desktop`); short, as a socket's path has at most 103 bytes.
  const runDir = tempDir("ads-");
  dirs.push(root, runDir);
  const home = path.join(root, "home", "ag-01a142cb");
  const gid = process.getgid?.() ?? 0;
  const prefix = ["/usr/sbin/runuser", "-u", "ag-01a142cb", "--"];
  const user: DesktopUser = {
    prefix,
    env: {
      HOME: home,
      USER: "ag-01a142cb",
      LOGNAME: "ag-01a142cb",
      SHELL: "/bin/bash",
      PATH: "/usr/bin:/bin",
      LANG: "C.UTF-8",
    },
    home,
    dir: path.join(home, ".agentes", "desktop"),
    ids: { uid: 21001, gid },
  };
  const asked: string[] = [];
  const t = setup({ user: async () => user, runDir, openBrowser: async (agent) => void asked.push(agent.handle) });
  await t.desktops.ensure(dev);
  for (const p of t.fake.procs) expect(p.argv.slice(0, prefix.length)).toEqual(prefix);
  // The look goes into the agent's own home, written by the agent.
  expect(t.fake.of("agentes-look")[0]?.argv[prefix.length + 4]).toBe(home);
  // Browser's socket is root's, next to the password file, where only the agent's group may write to it; the
  // agent's own folders, which the agent could swap under root, have none.
  const socket = path.join(runDir, "21001", "browser.sock");
  const sock = statSync(socket);
  expect([sock.isSocket(), sock.mode & 0o777, sock.gid]).toEqual([true, 0o660, gid]);
  expect(existsSync(path.join(home, ".agentes", "desktop", "browser.sock"))).toBe(false);
  if (posix) {
    expect(await click(socket)).toBe("ok\n");
    expect(asked).toEqual(["dev"]);
  }
  const [xvnc] = t.fake.of("Xtigervnc");
  const passwd = path.join(runDir, "21001", "passwd");
  expect(flagValue(xvnc?.argv ?? [], "-PasswordFile")).toBe(passwd);
  expect(flagValue(xvnc?.argv ?? [], "-rfbunixpath")).toBe(path.join(home, ".agentes", "desktop", "vnc.sock"));
  const live = t.desktops.session(dev.id);
  const written = vncPasswordFile(live?.passwords.full ?? "", live?.passwords.view ?? "");
  expect(readFileSync(passwd).toString("hex")).toBe(written.toString("hex"));
  const file = statSync(passwd);
  expect([file.mode & 0o777, file.uid, file.gid]).toEqual([0o440, process.getuid?.() ?? 0, gid]);
  const folder = statSync(path.dirname(passwd));
  expect([folder.mode & 0o777, folder.gid]).toEqual([0o750, gid]);
  expect(statSync(runDir).mode & 0o777).toBe(0o711);
  // Nothing of the runner's is written into the agent's own folders.
  expect(existsSync(path.join(home, ".agentes", "desktop", "passwd"))).toBe(false);

  expect(await t.desktops.stop(dev)).toEqual({ stopped: true });
  expect(existsSync(passwd)).toBe(false);
  expect(existsSync(socket)).toBe(false);
});

test("the controller's keyboard: setxkbmap as the agent on its display; a variant only when the layout has one", async () => {
  const t = setup();
  await t.desktops.setKeyboard(dev, "br");
  expect(t.fake.procs).toHaveLength(0);
  await t.desktops.ensure(dev);
  await t.desktops.setKeyboard(dev, "us-intl");
  await t.desktops.setKeyboard(dev, "br");
  const runs = t.fake.procs.filter((p) => p.argv[0] === "/usr/bin/setxkbmap");
  expect(runs.map((p) => p.argv.slice(1))).toEqual([
    ["-layout", "us", "-variant", "intl"],
    ["-layout", "br"],
  ]);
  expect(runs[0]?.opts.env).toMatchObject({
    DISPLAY: ":20",
    XAUTHORITY: path.join(t.home, "desktop", "01a142cb", "Xauthority"),
  });
});

test("system mode's desktop user: the agent's launcher and home; the cookie and the socket in ~/.agentes/desktop", () => {
  const launcher = systemLauncher({ id: dev.id, user: "ag-01a142cb", uid: 21001 }, true);
  expect(systemDesktopUser(launcher, { uid: 21001, gid: 21004 })).toEqual({
    prefix: launcher.prefix,
    env: launcher.env,
    home: "/home/ag-01a142cb",
    dir: "/home/ag-01a142cb/.agentes/desktop",
    ids: { uid: 21001, gid: 21004 },
  });
  expect(launcher.prefix.at(-2)).toBe("ag-01a142cb");
  expect(launcher.env.HOME).toBe("/home/ag-01a142cb");
});

test("slots: an agent keeps its display; one held by another process is skipped, a stale lock is cleared", async () => {
  const t = setup();
  // :20 is held by a live X server that isn't ours; :21's server is gone.
  writeFileSync(path.join(t.lockDir, ".X20-lock"), "       777\n");
  t.fake.others.set(777, ["/usr/lib/xorg/Xorg", ":20"]);
  writeFileSync(path.join(t.lockDir, ".X21-lock"), "       778\n");
  mkdirSync(path.join(t.lockDir, ".X11-unix"));
  writeFileSync(path.join(t.lockDir, ".X11-unix", "X21"), "");

  expect((await t.desktops.ensure(dev)).display).toBe(21);
  expect(existsSync(path.join(t.lockDir, ".X11-unix", "X21"))).toBe(false);
  expect((await t.desktops.ensure(ops)).display).toBe(22);
  expect(JSON.parse(readFileSync(path.join(t.home, "desktop", "slots.json"), "utf8"))).toEqual({
    [dev.id]: 1,
    [ops.id]: 2,
  });

  // Both stop; dev comes back first and still gets its own display, not ops's.
  await t.desktops.stop(dev);
  await t.desktops.stop(ops);
  expect((await t.desktops.ensure(ops)).display).toBe(22);
  expect((await t.desktops.ensure(dev)).display).toBe(21);
  t.desktops.close();
});

test("restore: a desktop left running is taken back only when its pid is still that display's Xtigervnc", async () => {
  const t = setup();
  const before = new DesktopSessions({ ...t.opts, system: gone(t.fake.system) });
  await before.ensure(dev);
  await before.ensure(ops);
  before.close();
  const stateOf = (agent: string) => path.join(t.home, "desktop", `${agent}.json`);
  // ops's pid now belongs to something else (reused); a third file names a display its pid isn't on.
  const opsXvnc = t.fake.of("Xtigervnc")[1];
  if (!opsXvnc) throw new Error("ops not started");
  opsXvnc.alive = false;
  t.fake.others.set(opsXvnc.pid, ["/bin/bash"]);
  const qa = { id: "77aa0000-0000-7000-8000-000000000000", handle: "qa" };
  const devState = JSON.parse(readFileSync(stateOf("01a142cb"), "utf8"));
  writeFileSync(stateOf("77aa0000"), JSON.stringify({ ...devState, agent: qa, display: 25 }));

  const next = new DesktopSessions(t.opts);
  next.restore();
  expect(next.status(dev).running).toBe(true);
  expect(next.status(ops).running).toBe(false);
  expect(next.status(qa).running).toBe(false);
  expect(existsSync(stateOf("01a142cb"))).toBe(true);
  expect(existsSync(stateOf("9f00aa11"))).toBe(false);
  expect(existsSync(stateOf("77aa0000"))).toBe(false);
  expect(next.session(dev.id)?.passwords).toEqual(before.session(dev.id)?.passwords);
  // Taken back as it is: nothing new starts. :21's lock still names a live process (the reused pid).
  expect(await next.ensure(dev)).toMatchObject({ display: 20, started: false });
  expect(t.fake.of("Xtigervnc")).toHaveLength(2);
  expect((await next.ensure(qa)).display).toBe(22);
  next.close();
});

test("a desktop stays on: a day with no viewer and no use, and it still runs; a viewer is counted", async () => {
  // Each viewer that comes or goes is told (system mode: the agent's worker learns it).
  const viewers: number[] = [];
  const t = setup({ onViewers: (agentId) => viewers.push(t.desktops.status({ id: agentId }).streams) });
  await t.desktops.ensure(dev);
  const release = t.desktops.hold(dev.id);
  expect(t.desktops.status(dev).streams).toBe(1);
  release?.();
  release?.();
  expect(t.desktops.status(dev).streams).toBe(0);
  expect(viewers).toEqual([1, 0]);
  for (let hour = 0; hour < 24; hour++) {
    t.clock.now += 3_600_000;
    t.desktops.sweep();
  }
  expect(t.desktops.status(dev).running).toBe(true);
  expect(t.fake.kills).toEqual([]);
  expect(t.fake.of("Xtigervnc")).toHaveLength(1);
  t.desktops.close();
});

test("parking: short of memory, the least recently used desktop untouched for an hour goes first; never one watched, in use or just used", async () => {
  const agent = (handle: string, i: number): AgentScope => ({ id: `0000000${i}-0000-7000-8000-000000000000`, handle });
  const [a, b, watched, busy, recent, c, d, e] = ["a", "b", "watched", "busy", "recent", "c", "d", "e"].map(agent) as [
    AgentScope,
    AgentScope,
    AgentScope,
    AgentScope,
    AgentScope,
    AgentScope,
    AgentScope,
    AgentScope,
  ];
  // Each desktop takes 0.4 GiB of what this computer has; 1.5 GiB must stay free when one more starts.
  const running = () => t.fake.of("Xtigervnc").filter((p) => p.alive).length;
  const t = setup({ memAvailable: () => 3.4 * GiB - running() * 0.4 * GiB, inUse: (id) => id === busy.id });
  await t.desktops.ensure(a);
  t.clock.now += 60_000;
  for (const next of [b, watched, busy]) await t.desktops.ensure(next);
  // Watched since then: only its viewer keeps it.
  t.desktops.hold(watched.id);
  t.clock.now += 2 * PARK_AFTER_MS;
  await t.desktops.ensure(recent);
  const runs = (of: AgentScope) => t.desktops.status(of).running;

  await t.desktops.ensure(c);
  expect([a, b, c].map(runs)).toEqual([false, true, true]);
  await t.desktops.ensure(d);
  expect([b, d].map(runs)).toEqual([false, true]);
  expect(t.logs.filter((l) => l.includes("was parked"))).toHaveLength(2);
  // Nothing left to park (watched, in use, or used within the hour): refused, and nothing else stops.
  expect(await errorCode(() => t.desktops.ensure(e))).toBe("desktop_busy");
  expect([watched, busy, recent, c, d].map(runs)).toEqual([true, true, true, true, true]);
  // The agent's Chrome is about to start on its running desktop: the same room is needed.
  expect(await errorCode(() => t.desktops.ensure(recent, { chrome: true }))).toBe("desktop_busy");
  expect(runs(recent)).toBe(true);

  // An hour on, a parked desktop starts again like a first time.
  t.clock.now += PARK_AFTER_MS;
  expect(await t.desktops.ensure(a)).toMatchObject({ started: true });
  expect(runs(watched) && runs(busy)).toBe(true);
  t.desktops.close();
});

test("parking: with every display taken, the least recently used desktop untouched for an hour makes room", async () => {
  const t = setup();
  // Every display but the first two is held by programs that aren't ours.
  for (let slot = 2; slot < 50; slot++) {
    writeFileSync(path.join(t.lockDir, `.X${20 + slot}-lock`), `${String(9000 + slot).padStart(10)}\n`);
    t.fake.others.set(9000 + slot, ["/usr/lib/xorg/Xorg", `:${20 + slot}`]);
  }
  const qa: AgentScope = { id: "77aa0000-0000-7000-8000-000000000000", handle: "qa" };
  await t.desktops.ensure(dev);
  t.clock.now += 60_000;
  await t.desktops.ensure(ops);
  // Both used within the hour: no room, and both go on.
  expect(await errorCode(() => t.desktops.ensure(qa))).toBe("desktop_busy");
  t.clock.now += PARK_AFTER_MS;
  expect(await t.desktops.ensure(qa)).toMatchObject({ display: 20, started: true });
  expect([dev, ops, qa].map((a) => t.desktops.status(a).running)).toEqual([false, true, true]);
  expect(t.logs.filter((l) => l.includes("was parked"))).toHaveLength(1);
  t.desktops.close();
});

test("the agent's Chrome in use on its desktop touches it: parked an hour after that use, not as Chrome closes", async () => {
  let chromeInUse = true;
  // Short of memory while dev's desktop runs: only parking it makes room.
  const t = setup({
    memAvailable: () => (t.desktops.status(dev).running ? GiB : 4 * GiB),
    inUse: (id) => id === dev.id && chromeInUse,
  });
  await t.desktops.ensure(dev);
  // Hours of browsing on it, the sweep once a minute; then its Chrome closes.
  for (let minute = 0; minute < 180; minute++) {
    t.clock.now += 60_000;
    t.desktops.sweep();
  }
  chromeInUse = false;
  expect(await errorCode(() => t.desktops.ensure(ops))).toBe("desktop_busy");
  expect(t.desktops.status(dev).running).toBe(true);
  t.clock.now += PARK_AFTER_MS;
  expect((await t.desktops.ensure(ops)).started).toBe(true);
  expect(t.desktops.status(dev).running).toBe(false);
  t.desktops.close();
});

test("the desktops of agents this computer no longer serves stop; the others go on", async () => {
  const t = setup();
  await t.desktops.ensure(dev);
  await t.desktops.ensure(ops);
  await t.desktops.stopAll(new Set([ops.id]));
  expect([dev, ops].map((a) => t.desktops.status(a).running)).toEqual([false, true]);
  await t.desktops.stopAll();
  expect(t.desktops.status(ops).running).toBe(false);
});

test("where the memory isn't known there is always room", async () => {
  const t = setup({ memAvailable: () => null });
  for (const agent of [dev, ops]) expect((await t.desktops.ensure(agent)).started).toBe(true);
  t.desktops.close();
});

test("supervision: a desktop that ends by itself starts again, 3 times in 10 minutes at most", async () => {
  const t = setup();
  await t.desktops.ensure(dev);
  for (let restart = 1; restart <= 3; restart++) {
    t.fake.of("dbus-launch").at(-1)?.exit(0);
    await waitFor(() => t.fake.of("Xtigervnc").length === restart + 1 && t.desktops.status(dev).running);
  }
  // The X server of the crashed session went with it.
  expect(t.fake.of("Xtigervnc").filter((p) => p.alive)).toHaveLength(1);
  t.fake.of("Xtigervnc").at(-1)?.exit(1);
  await waitFor(() => t.logs.some((l) => l.includes("too often")));
  expect(t.desktops.status(dev).running).toBe(false);
  expect(t.fake.of("Xtigervnc")).toHaveLength(4);

  // Asked for again, it starts; ten minutes later the count starts over.
  await t.desktops.ensure(dev);
  t.clock.now += 10 * 60_000;
  t.fake.of("dbus-launch").at(-1)?.exit(0);
  await waitFor(() => t.fake.of("Xtigervnc").length === 6 && t.desktops.status(dev).running);
  t.desktops.close();
});

test("a desktop found gone by the sweep (taken back, so no exit event) starts again", async () => {
  const t = setup();
  const before = new DesktopSessions({ ...t.opts, system: gone(t.fake.system) });
  await before.ensure(dev);
  before.close();
  const next = new DesktopSessions(t.opts);
  next.restore();
  const session = t.fake.of("dbus-launch")[0];
  if (session) session.alive = false;
  next.sweep();
  await waitFor(() => t.fake.of("Xtigervnc").length === 2 && next.status(dev).running);
  next.close();
});

test("limits and failures: short of memory, Xvnc that doesn't start, a computer without the packages", async () => {
  let free = 4 * GiB;
  const t = setup({ memAvailable: () => free });
  await t.desktops.ensure(dev);
  free = GiB;
  expect(await errorCode(() => t.desktops.ensure(ops))).toBe("desktop_busy");
  free = 4 * GiB;
  await t.desktops.stop(dev);

  t.fake.failXvnc("(EE) Fatal server error: vncExtInit: Failed to bind socket");
  const failed = await t.desktops.ensure(ops).catch((err: Error) => err.message);
  expect(failed).toContain("Failed to bind socket");
  expect(t.desktops.status(ops).running).toBe(false);
  t.fake.failXvnc(null);
  expect((await t.desktops.ensure(ops)).started).toBe(true);
  // The failed start's log is kept beside the new one's.
  expect(readFileSync(path.join(t.home, "desktop", "9f00aa11.log.1"), "utf8")).toContain("Failed to bind socket");
  await t.desktops.stop(ops);

  const bare = new DesktopSessions({ ...t.opts, system: { ...t.fake.system, which: () => null } });
  expect(await errorCode(() => bare.ensure(dev))).toBe("desktop_unavailable");
});

test("requests: starting needs the desktop switch and an unpaused computer; stopping and asking always go", async () => {
  const t = setup();
  const ws = tempDir("desk-req-");
  dirs.push(ws);
  const tools = { claude: false, codex: false, commands: true, browser: true, desktop: false };
  const access: RunnerAccess = { folders: [], tools };
  let paused = false;
  const ctx = { workspaceReal: ws, exec: true, token: "agm_x", access: () => access, paused: () => paused };
  const scope: RequestScope = { signal: new AbortController().signal, output: () => {} };
  const run = (req: MachineRequest) => handleRequest({ ...ctx, desktops: t.desktops }, req, scope);

  expect(await errorCode(() => run({ op: "desktop.session.start", agent: dev }))).toBe("not_allowed");
  tools.desktop = true;
  expect(await run({ op: "desktop.session.start", agent: dev })).toMatchObject({ display: 20, started: true });
  expect(await errorCode(() => run({ op: "desktop.session.start" }))).toBe("bad_request");
  const none = { op: "desktop.session.start" as const, agent: ops };
  expect(await errorCode(() => handleRequest(ctx, none, scope))).toBe("desktop_unavailable");

  paused = true;
  expect(await errorCode(() => run({ op: "desktop.session.start", agent: dev }))).toBe("paused");
  tools.desktop = false;
  expect(await run({ op: "desktop.session.status", agent: dev })).toMatchObject({ running: true, streams: 0 });
  expect(await run({ op: "desktop.session.stop", agent: dev })).toEqual({ stopped: true });
  expect(await run({ op: "desktop.session.stop", agent: dev })).toEqual({ stopped: false });
  expect(await run({ op: "desktop.session.status", agent: dev })).toEqual({ running: false, streams: 0 });
});
