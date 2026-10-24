import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import path from "node:path";
import type { AgentScope, MachineRequest, RunnerAccess } from "@agenteschat/adapters/machine-protocol";
import { systemLauncher } from "../../runner/agent-users";
import {
  DESKTOP_IDLE_MS,
  DesktopSessions,
  type DesktopSessionsOptions,
  type DesktopSpawnOptions,
  type DesktopSystem,
  type DesktopUser,
  defaultMaxDesktops,
  runnerUser,
  systemDesktopUser,
  vncPasswordFile,
} from "../../runner/desktop-session";
import { handleRequest, type RequestScope } from "../../runner/handlers";
import { errorCode, removeDirs, tempDir, waitFor } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const dev: AgentScope = { id: "01a142cb-489d-7000-87a3-efb5adb382ca", handle: "dev", name: "Dev" };
const ops: AgentScope = { id: "9f00aa11-0000-7000-8000-000000000000", handle: "ops" };
const MiB = 1024 * 1024;

interface FakeProc {
  pid: number;
  argv: string[];
  opts: DesktopSpawnOptions;
  alive: boolean;
  exit(code: number | null): void;
}

const commandOf = (p: FakeProc) =>
  p.argv.map((a) => path.basename(a)).find((a) => a === "sh" || a === "Xtigervnc" || a === "dbus-launch");

/**
 * A computer with no X: the prepare script makes its folders, "Xtigervnc"
 * takes its display's lock and socket, and every process lives until killed.
 */
function fakeComputer(lockDir: string) {
  const procs: FakeProc[] = [];
  /** Live processes that aren't ours (pid → command line). */
  const others = new Map<number, string[]>();
  const kills: [number, string][] = [];
  let nextPid = 4000;
  let xvncFails: string | null = null;
  const system: DesktopSystem = {
    platform: "linux",
    pty: true,
    runtime: "Bun 1.4.4",
    uid: 1000,
    which: (command) => `/usr/bin/${command}`,
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
      if (command === "sh") {
        for (const dir of argv.slice(-3, -1)) mkdirSync(dir, { recursive: true });
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

function setup(over: Partial<DesktopSessionsOptions> = {}) {
  const home = tempDir("desk-home-");
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
    maxDesktops: 7,
    now: () => clock.now,
    ...over,
  };
  const desktops = new DesktopSessions(opts);
  return { home, lockDir, folders, fake, logs, clock, opts, desktops };
}

const flagValue = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];

test("the password file: each password DES-encrypted with VNC's fixed key, the full one first", () => {
  expect(vncPasswordFile("password", "password").toString("hex")).toBe("dbd83cfd727a1458dbd83cfd727a1458");
  const file = vncPasswordFile("password", "Viewpw34");
  expect(file.length).toBe(16);
  expect(file.subarray(0, 8).toString("hex")).toBe("dbd83cfd727a1458");
  expect(file.subarray(8)).toEqual(vncPasswordFile("Viewpw34", "x").subarray(0, 8));
});

test("how many desktops a computer runs: its memory after a 2 GiB reserve, 800 MiB each", () => {
  expect(defaultMaxDesktops(7947 * MiB)).toBe(7);
  expect(defaultMaxDesktops(4096 * MiB)).toBe(2);
  expect(defaultMaxDesktops(1024 * MiB)).toBe(1);
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
  expect(prepare.argv.slice(-3, -1)).toEqual([dir, path.join(t.folders, "dev", ".agentes", "home")]);
  expect(prepare.argv.at(-1)).toContain('<property name="ssh-agent" type="empty">');
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

test("system mode: every process as the agent, and the password file root's (readable by the agent's group only)", async () => {
  const root = tempDir("desk-sys-");
  dirs.push(root);
  const home = path.join(root, "home", "ag-01a142cb");
  const runDir = path.join(root, "run", "agentes-desktop");
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
  const t = setup({ user: async () => user, runDir });
  await t.desktops.ensure(dev);
  for (const p of t.fake.procs) expect(p.argv.slice(0, prefix.length)).toEqual(prefix);
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

test("idle: a desktop with no viewer and no use stops after 15 minutes; a viewer or a use keeps it", async () => {
  // Each viewer that comes or goes is told (system mode: the agent's worker learns it).
  const viewers: number[] = [];
  const t = setup({ onViewers: (agentId) => viewers.push(t.desktops.status({ id: agentId }).streams) });
  await t.desktops.ensure(dev);
  const release = t.desktops.hold(dev.id);
  expect(t.desktops.status(dev).streams).toBe(1);
  t.clock.now += DESKTOP_IDLE_MS + 1;
  await t.desktops.sweep();
  expect(t.desktops.status(dev).running).toBe(true);

  release?.();
  release?.();
  expect(t.desktops.status(dev).streams).toBe(0);
  expect(viewers).toEqual([1, 0]);
  t.clock.now += DESKTOP_IDLE_MS - 1;
  await t.desktops.ensure(dev);
  t.clock.now += DESKTOP_IDLE_MS - 1;
  await t.desktops.sweep();
  expect(t.desktops.status(dev).running).toBe(true);

  t.clock.now += 2;
  await t.desktops.sweep();
  expect(t.desktops.status(dev).running).toBe(false);
  const [xvnc] = t.fake.of("Xtigervnc");
  const [session] = t.fake.of("dbus-launch");
  expect(t.fake.kills).toContainEqual([xvnc?.pid ?? 0, "SIGTERM"]);
  expect(t.fake.kills).toContainEqual([session?.pid ?? 0, "SIGTERM"]);
  expect(existsSync(path.join(t.home, "desktop", "01a142cb.json"))).toBe(false);
  expect(t.logs.some((l) => l.includes("nobody used it"))).toBe(true);
  // Stopped on purpose: no restart.
  await new Promise((r) => setTimeout(r, 10));
  expect(t.fake.of("Xtigervnc")).toHaveLength(1);
});

test("idle: the agent's Chrome in use on its desktop keeps the desktop", async () => {
  let chromeInUse = true;
  const t = setup({ inUse: (agentId) => agentId === dev.id && chromeInUse });
  await t.desktops.ensure(dev);
  t.clock.now += DESKTOP_IDLE_MS + 1;
  await t.desktops.sweep();
  expect(t.desktops.status(dev).running).toBe(true);
  chromeInUse = false;
  await t.desktops.sweep();
  expect(t.desktops.status(dev).running).toBe(false);
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
  await next.sweep();
  await waitFor(() => t.fake.of("Xtigervnc").length === 2 && next.status(dev).running);
  next.close();
});

test("limits and failures: the memory cap, Xvnc that doesn't start, a computer without the packages", async () => {
  const t = setup({ maxDesktops: 1 });
  await t.desktops.ensure(dev);
  expect(await errorCode(() => t.desktops.ensure(ops))).toBe("desktop_busy");
  await t.desktops.stop(dev);

  t.fake.failXvnc("(EE) Fatal server error: vncExtInit: Failed to bind socket");
  const failed = await t.desktops.ensure(ops).catch((err: Error) => err.message);
  expect(failed).toContain("Failed to bind socket");
  expect(t.desktops.status(ops).running).toBe(false);
  t.fake.failXvnc(null);
  expect((await t.desktops.ensure(ops)).started).toBe(true);
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
