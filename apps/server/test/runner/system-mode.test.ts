import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MACHINE_OPS, type MachineRequest } from "@agenteschat/adapters/machine-protocol";
import {
  configPath,
  DEFAULT_AGENT_UID_RANGE,
  normalizeStored,
  parseUidRange,
  readStoredConfig,
  SYSTEM_RUNNER_HOME,
  writeConfig,
} from "../../runner/config";
import { configFromGrant } from "../../runner/daemon";
import { type HandlerContext, handleRequest, OP_ROUTES } from "../../runner/handlers";
import {
  BROWSER_APT_PACKAGES,
  DESKTOP_APT_PACKAGES,
  DESKTOP_CJK_APT_PACKAGES,
  DESKTOP_DOCK_APT_PACKAGES,
  DESKTOP_LOOK_APT_PACKAGES,
  installScript,
  RUNNER_BUN_SHA256,
  RUNNER_BUN_VERSION,
} from "../../runner/install-script";
import {
  AGENT_SLICE_LIMITS,
  agentSlice,
  agentSliceLimitsPath,
  installSystemService,
  SYSTEM_UNIT_PATH,
  systemdSystemUnit,
} from "../../runner/service";
import { errorCode, removeDirs, tempDir } from "./helpers";

const dirs: string[] = [];
afterEach(() => removeDirs(dirs));

const posix = process.platform !== "win32";
const root = path.resolve(import.meta.dir, "../../../..");

function home() {
  const h = tempDir("system-");
  dirs.push(h);
  return h;
}

const BUN = "/opt/agentes-runner/bin/bun";
const BUNDLE = "/opt/agentes-runner/agentes-runner.mjs";

test("the system unit: root, from boot, a PATH root owns, and tasks outlive a restart", () => {
  expect(SYSTEM_UNIT_PATH).toBe("/etc/systemd/system/agentes-runner.service");
  const unit = systemdSystemUnit({ runtime: BUN, script: BUNDLE, home: SYSTEM_RUNNER_HOME });
  expect(unit).toContain(`ExecStart="${BUN}" "${BUNDLE}" start`);
  expect(unit).toContain('Environment="AGENTES_RUNNER_HOME=/var/lib/agentes-runner"');
  expect(unit).toContain('Environment="PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"');
  expect(unit).toContain("Restart=always");
  expect(unit).toContain("RestartPreventExitStatus=0 2 3");
  expect(unit).toContain("KillMode=process");
  expect(unit).toContain("WantedBy=multi-user.target");
  // No User=: systemd runs a system unit as root.
  expect(unit).not.toContain("User=");
});

test("config: the mode and the agents' uid range are read and checked", () => {
  expect(normalizeStored({ mode: "system", agentUidRange: [21000, 21099] })).toEqual({
    mode: "system",
    agentUidRange: [21000, 21099],
  });
  expect(normalizeStored({ mode: "user" })).toEqual({ mode: "user" });
  for (const bad of [[999, 2000], [20000, 60000], [30000, 20000], [1.5, 2000], [20000], "20000-29999", null]) {
    expect(normalizeStored({ agentUidRange: bad })).toEqual({});
  }
  expect(normalizeStored({ mode: "root" })).toEqual({});

  expect(parseUidRange("20000-29999")).toEqual([20000, 29999]);
  expect(parseUidRange(" 1000-59999 ")).toEqual([1000, 59999]);
  expect(parseUidRange("21000-21000")).toEqual([21000, 21000]);
  for (const bad of ["999-2000", "20000-60000", "30000-20000", "20000", "a-b", "20000-29999-1", "-1-5", ""]) {
    expect(parseUidRange(bad)).toBeNull();
  }
  expect(DEFAULT_AGENT_UID_RANGE).toEqual([20000, 29999]);
});

test("a system home paired again stays a system home", () => {
  const grant = { token: "agm_new", machineId: "m2", name: "box", org: { id: "o1", name: "Acme" } };
  const input = {
    server: "https://agentes.test",
    grant,
    workspace: "/srv/agents",
    tools: { claude: true, codex: true, commands: true },
    desktop: false,
  };
  const next = configFromGrant({ mode: "system", agentUidRange: [21000, 21099], token: "agm_old" }, input);
  expect(next).toMatchObject({ mode: "system", agentUidRange: [21000, 21099], token: "agm_new", machineId: "m2" });
  expect(configFromGrant(null, input).mode).toBeUndefined();
});

test.if(posix)("service install --system refuses without root and off Linux, and writes nothing", () => {
  const h = home();
  const unitPath = path.join(h, "unit.service");
  const lines: string[] = [];
  const io = {
    print: (l: string) => lines.push(l),
    run: () => ({ code: 0, output: "" }),
    launch: { runtime: BUN, script: BUNDLE, home: h },
    unitPath,
    booted: true,
  };
  expect(installSystemService({ ...io, uid: 1000, platform: "linux" })).toBe(1);
  expect(lines.join("\n")).toContain("run it as root");
  expect(installSystemService({ ...io, uid: 0, platform: "darwin" })).toBe(1);
  expect(existsSync(unitPath)).toBe(false);
  expect(existsSync(agentSliceLimitsPath(unitPath))).toBe(false);
  expect(readStoredConfig(h)).toBeNull();
});

test.if(posix)("service install --system: a system home, and it starts only when asked and connected", () => {
  const h = home();
  const unitPath = path.join(h, "systemd", "agentes-runner.service");
  const calls: string[] = [];
  let lines: string[] = [];
  let fail = "";
  const launch = { runtime: BUN, script: BUNDLE, home: h };
  const install = (o: { start?: boolean; agentUidRange?: [number, number]; booted?: boolean } = {}) => {
    calls.length = 0;
    lines = [];
    return installSystemService({
      print: (l) => lines.push(l),
      run: (file, args) => {
        calls.push(`${file} ${args.join(" ")}`);
        return args.join(" ") === fail ? { code: 1, output: "boom" } : { code: 0, output: "" };
      },
      launch,
      uid: 0,
      platform: "linux",
      unitPath,
      booted: o.booted ?? true,
      ...o,
    });
  };

  // install.sh's first step: before pairing, nothing starts.
  expect(install({ start: false, agentUidRange: [21000, 21099] })).toBe(0);
  expect(calls).toEqual(["systemctl daemon-reload"]);
  expect(readFileSync(unitPath, "utf8")).toBe(systemdSystemUnit(launch));
  expect(readStoredConfig(h)).toEqual({ mode: "system", agentUidRange: [21000, 21099] });
  // Every agent's slice (agents-<uid>.slice) gets the same limits, from one drop-in for the prefix.
  expect(agentSlice(21003)).toBe("agents-21003.slice");
  expect(agentSliceLimitsPath(unitPath)).toBe(path.join(h, "systemd", "agents-.slice.d", "limits.conf"));
  expect(agentSliceLimitsPath()).toBe("/etc/systemd/system/agents-.slice.d/limits.conf");
  expect(readFileSync(agentSliceLimitsPath(unitPath), "utf8")).toBe(AGENT_SLICE_LIMITS);
  expect(AGENT_SLICE_LIMITS.split("\n")).toEqual(["[Slice]", "MemoryMax=1536M", "TasksMax=1024", "CPUQuota=200%", ""]);

  // Not connected yet: an unpaired runner would only restart in a loop.
  expect(install()).toBe(0);
  expect(calls).toEqual(["systemctl daemon-reload"]);
  expect(lines.join("\n")).toContain("systemctl enable --now agentes-runner");

  // Connected (the range given at install stays when the installer runs again without it).
  writeConfig(
    {
      ...readStoredConfig(h),
      server: "https://agentes.test",
      machineId: "m1",
      token: "agm_t",
      workspace: h,
      exec: true,
    },
    h,
  );
  expect(install()).toBe(0);
  expect(calls).toEqual([
    "systemctl daemon-reload",
    "systemctl enable agentes-runner",
    "systemctl restart agentes-runner",
  ]);
  expect(readStoredConfig(h)).toMatchObject({ mode: "system", agentUidRange: [21000, 21099], token: "agm_t" });

  fail = "enable agentes-runner";
  expect(install()).toBe(1);
  expect(lines.join("\n")).toContain("boom");
  fail = "";

  // No systemd (a chroot, an image build): the unit is written; starting is up to the person.
  expect(install({ booted: false, start: false })).toBe(0);
  expect(install({ booted: false })).toBe(1);
  expect(calls).toEqual([]);
});

/** `service install --system --no-start` as root, with the unit at `unitPath`. */
const installNoStart = (unitPath: string, runnerHome: string) =>
  installSystemService({
    print: () => {},
    run: () => ({ code: 0, output: "" }),
    launch: { runtime: BUN, script: BUNDLE, home: runnerHome },
    uid: 0,
    platform: "linux",
    unitPath,
    booted: true,
    start: false,
  });

test.if(posix)(
  "service install --system: systemd's files readable by all under any umask, the home root's alone",
  () => {
    for (const umask of [0o077, 0o022]) {
      const h = home();
      const unitPath = path.join(h, "systemd", "agentes-runner.service");
      const limits = agentSliceLimitsPath(unitPath);
      // As a run under umask 077 left them: PID 1 warned at every read.
      mkdirSync(path.dirname(limits), { recursive: true, mode: 0o700 });
      writeFileSync(unitPath, "", { mode: 0o600 });
      writeFileSync(limits, "", { mode: 0o600 });
      const runnerHome = path.join(h, "runner");
      const before = process.umask(umask);
      try {
        expect(installNoStart(unitPath, runnerHome)).toBe(0);
      } finally {
        process.umask(before);
      }
      const files = [unitPath, path.dirname(limits), limits, runnerHome, configPath(runnerHome)];
      expect(files.map((p) => statSync(p).mode & 0o777)).toEqual([0o644, 0o755, 0o644, 0o700, 0o600]);
    }
  },
);

// A chmod through the link throws EPERM for anyone but root, and as root would change this computer's /dev/null.
test.if(posix && process.getuid?.() !== 0)(
  "service install --system: a unit or drop-in masked (a link to /dev/null) stays masked, /dev/null untouched",
  () => {
    for (const dropIn of [false, true]) {
      const h = home();
      const unitPath = path.join(h, "systemd", "agentes-runner.service");
      const masked = dropIn ? agentSliceLimitsPath(unitPath) : unitPath;
      mkdirSync(path.dirname(masked), { recursive: true });
      symlinkSync("/dev/null", masked);
      expect(installNoStart(unitPath, path.join(h, "runner"))).toBe(0);
      expect(lstatSync(masked).isSymbolicLink()).toBe(true);
    }
  },
);

test("a system-mode runner (root) without workers does no agent work; machine-level ops still answer", async () => {
  const ws = home();
  let system = true;
  const ctx: HandlerContext = { workspaceReal: ws, exec: true, token: "t", systemMode: () => system };
  const scope = { signal: new AbortController().signal, output: () => {} };
  const marker = path.join(ws, "ran");
  const exec = {
    op: "exec",
    command: `touch ${JSON.stringify(marker)}`,
    timeoutSeconds: 10,
    stream: false,
    agent: { id: "a1b2c3d4-0000-4000-8000-000000000001", handle: "ana" },
  } as unknown as MachineRequest;
  expect(await errorCode(() => handleRequest(ctx, exec, scope))).toBe("not_allowed");
  expect(await errorCode(() => handleRequest(ctx, { ...exec, agent: undefined } as MachineRequest, scope))).toBe(
    "not_allowed",
  );
  const read = { op: "read", path: "x", maxBytes: 10 } as unknown as MachineRequest;
  expect(await errorCode(() => handleRequest(ctx, read, scope))).toBe("not_allowed");
  const secret = {
    op: "secret",
    action: "keypair",
    requestId: "req-0001-aaaa",
    agent: exec.agent,
  } as unknown as MachineRequest;
  expect(await errorCode(() => handleRequest(ctx, secret, scope))).toBe("not_allowed");
  expect(existsSync(marker)).toBe(false);
  // Past the system-mode check: this context simply keeps no accounts, access settings, desktops or streams.
  const account = { op: "account", action: "list" } as unknown as MachineRequest;
  expect(await errorCode(() => handleRequest(ctx, account, scope))).toBe("bad_request");
  const reduce = { op: "access.reduce", folders: [] } as unknown as MachineRequest;
  expect(await errorCode(() => handleRequest(ctx, reduce, scope))).toBe("bad_request");
  const desktop = { op: "desktop.session.status", agent: exec.agent } as unknown as MachineRequest;
  expect(await errorCode(() => handleRequest(ctx, desktop, scope))).toBe("desktop_unavailable");
  const stream = {
    op: "stream.open",
    streamId: "s".repeat(43),
    kind: "terminal",
    cols: 80,
    rows: 24,
    agent: exec.agent,
  } as unknown as MachineRequest;
  expect(await errorCode(() => handleRequest(ctx, stream, scope))).toBe("bad_request");
  // Every op has its place. The root process keeps a secret's key and sealed box until the server commits its
  // delivery, the computer's accounts and access settings, and the desktops and streams: a stream's data socket
  // needs the machine token, which no worker holds.
  expect(Object.keys(OP_ROUTES).sort()).toEqual([...MACHINE_OPS].sort());
  expect(MACHINE_OPS.filter((op) => OP_ROUTES[op] === "machine")).toEqual([
    "secret",
    "account",
    "access.request",
    "access.reduce",
    "desktop.session.start",
    "desktop.session.stop",
    "desktop.session.status",
    "stream.open",
  ]);

  if (posix) {
    system = false;
    expect(await errorCode(() => handleRequest(ctx, exec, scope))).toBe("ok");
    expect(existsSync(marker)).toBe(true);
  }
});

const runScript = (...args: string[]) =>
  spawnSync("sh", ["-s", "--", ...args], { input: installScript("https://agentes.test"), encoding: "utf8" });

test.if(posix)("install.sh: --system needs root, and its flags go with it", () => {
  if (process.getuid?.() !== 0) {
    const r = runScript("--system", "--desktop", "--no-pair", "--no-start");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("run it as root");
    expect(r.stdout).toBe("");
  }
  for (const [args, message] of [
    [["--no-start"], "go with --system"],
    [["--desktop"], "go with --system"],
    [["--no-pair"], "go with --system"],
    [["--agent-uid-range", "21000-21099"], "go with --system"],
    [["--system", "--agent-uid-range"], "--agent-uid-range needs a value"],
    [["--system", "--no-service"], "use --no-start"],
    [["--system", "--dir", "/srv/agents"], "--dir doesn't go with --system"],
    [["--system", "--no-pair", "--enroll-file", "/run/agentes/enroll-code"], "doesn't go with --no-pair"],
    [["--runner-sha256"], "--runner-sha256 needs a value"],
    [["--runner-sha256", "abc"], "64 lowercase hex digits"],
    [["--runner-sha256", "A".repeat(64)], "64 lowercase hex digits"],
    [["--system", "--host-token-file", "/nonexistent/host-token"], "can't read /nonexistent/host-token"],
    [
      ["--system", "--host-token-file", "/bin/sh", "--enroll-file", "/run/agentes/enroll-code"],
      "doesn't go with --host-token-file",
    ],
    [["--server", "ftp://box"], "--server takes the server's address"],
    [["--server"], "--server needs a value"],
    [["--bogus"], "unknown option: --bogus"],
  ] as const) {
    const r = runScript(...args);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
    expect(r.stdout).toBe("");
  }
  const help = runScript("--help");
  expect(help.status).toBe(0);
  for (const flag of ["--system", "--desktop", "--no-pair", "--no-start", "--agent-uid-range", "20000-29999"]) {
    expect(help.stdout).toContain(flag);
  }
  expect(help.stdout).toContain("--runner-sha256");
  expect(help.stdout).toContain("--host-token-file");
  expect(help.stdout).toContain("--enroll-file");
  // Where this computer reaches the server, when the script's address isn't reachable from here.
  const h = home();
  const elsewhere = spawnSync("sh", ["-s", "--", "--server", "http://127.0.0.1:9/", "--no-service"], {
    input: installScript("https://agentes.test"),
    encoding: "utf8",
    env: { ...process.env, HOME: h, AGENTES_RUNNER_HOME: path.join(h, "runner-home") },
  });
  expect(elsewhere.stdout).toContain("◒  Downloading the runner from http://127.0.0.1:9\n");
});

test.if(posix)("install.sh --runner-sha256: a bundle with another SHA-256 is never installed", () => {
  const h = home();
  const served = path.join(h, "served");
  mkdirSync(path.join(served, "runner"), { recursive: true });
  // Stands in for the runner: `pair` fails, so the installer stops right after installing it.
  const bundle = "process.exit(1);\n";
  writeFileSync(path.join(served, "runner", "agentes-runner.mjs"), bundle);
  const sha = createHash("sha256").update(bundle).digest("hex");
  const runnerHome = path.join(h, "runner-home");
  const install = (pin: string) =>
    spawnSync("sh", ["-s", "--", "--runner-sha256", pin, "--no-service"], {
      input: installScript(`file://${served}`),
      encoding: "utf8",
      // The test's own Bun first: it has Bun.Terminal, so the installer fetches none.
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
        HOME: h,
        AGENTES_RUNNER_HOME: runnerHome,
      },
    });
  const installed = path.join(runnerHome, "agentes-runner.mjs");

  const wrong = install("0".repeat(64));
  expect(wrong.status).toBe(1);
  expect(wrong.stderr).toContain("didn't match --runner-sha256");
  expect(existsSync(installed)).toBe(false);
  expect(existsSync(`${installed}.download`)).toBe(false);

  const right = install(sha);
  expect(right.stderr).toContain("connecting this computer failed");
  expect(readFileSync(installed, "utf8")).toBe(bundle);
});

test("install.sh --system: the pinned Bun with its SHA-256, packages without recommends, nothing runs until the end", () => {
  const script = installScript("https://agentes.test");
  expect(script).toContain(`BUN_VERSION='${RUNNER_BUN_VERSION}'`);
  for (const [target, sha] of Object.entries(RUNNER_BUN_SHA256)) {
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(script).toContain(`${target}) BUN_SHA256='${sha}' ;;`);
  }
  expect(script).toContain('sha256 "$WORK/bun.zip"');
  expect(script).toContain('chown 0:0 "$SYSTEM_DIR" "$SYSTEM_DIR/bin" "$RUNNER_HOME"');
  expect(script).toContain("--no-install-recommends");
  expect(script).toContain("elementary-xfce-icon-theme");
  expect(script).toContain("RUNNER_HOME='/var/lib/agentes-runner'");
  expect(script).toContain("LAUNCHER='/usr/local/bin/agentes-runner'");
  expect(script).toContain("service install --system --no-start");
  expect(script.trimEnd().endsWith('main "$@"')).toBe(true);
});

test.if(posix)(
  "install.sh --system: the libraries Chrome for Testing loads, by their t64 names where apt has them; with --desktop the screens' too",
  () => {
    const fake = home();
    const tools = home();
    for (const tool of ["xargs", "sed", "grep", "dirname"])
      symlinkSync(Bun.which(tool) as string, path.join(tools, tool));
    // Root on Linux, as far as the script can tell.
    writeFileSync(path.join(tools, "id"), "#!/bin/sh\necho 0\n", { mode: 0o755 });
    writeFileSync(path.join(tools, "uname"), "#!/bin/sh\necho Linux\n", { mode: 0o755 });
    // apt-get notes its calls (and has none of the packages in $MISSING); apt-cache knows the packages in $KNOWN
    // once apt-get update has fetched the lists.
    writeFileSync(
      path.join(fake, "apt-get"),
      '#!/bin/sh\necho "apt-get $*" >> "$LOG"\ncase "$*" in *update*) : > "$LISTS" ;; esac\nfor p in $MISSING; do case " $* " in *" $p "*) exit 100 ;; esac; done\n',
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(fake, "apt-cache"),
      `#!/bin/sh\n[ -f "$LISTS" ] || exit 100\nshift\nfor p in "$@"; do case " $KNOWN " in *" $p "*) printf 'Package: %s\\nVersion: 1\\n\\n' "$p" ;; esac; done\n`,
      { mode: 0o755 },
    );
    // The installer as run, up to the first folder it makes: from there on it writes to the computer's own folders.
    const step = (desktop: boolean, opts: { known?: string[]; apt?: boolean; missing?: string[] } = {}) => {
      const d = home();
      const r = spawnSync("/bin/sh", ["-s", "--", "--system", ...(desktop ? ["--desktop"] : [])], {
        input: installScript("https://agentes.test").replace(/main "\$@"\n$/, `mkdir() { exit 0; }\nmain "$@"\n`),
        encoding: "utf8",
        env: {
          PATH: opts.apt === false ? tools : `${fake}:${tools}`,
          LOG: path.join(d, "log"),
          LISTS: path.join(d, "lists"),
          KNOWN: (opts.known ?? []).join(" "),
          MISSING: (opts.missing ?? []).join(" "),
        },
      });
      const log = path.join(d, "log");
      return {
        status: r.status,
        out: `${r.stdout}${r.stderr}`,
        calls: existsSync(log) ? readFileSync(log, "utf8") : "",
      };
    };
    const update = "apt-get -qq -o DPkg::Lock::Timeout=600 update\n";
    const install = (packages: readonly string[]) =>
      `apt-get -qq -o DPkg::Lock::Timeout=600 install -y --no-install-recommends ${packages.join(" ")}\n`;

    // --system alone, on Debian 12 or Ubuntu 22.04: the names as they are.
    // Without a terminal: the title, then each wait once and its line, whole.
    const head = "agentes.chat connect this computer\n";
    let r = step(false);
    expect(r.status).toBe(0);
    expect(r.out).toBe(
      `${head}◒  Installing the packages for the agents' browser\n◇  The packages for the agents' browser\n`,
    );
    expect(r.calls).toBe(update + install(BROWSER_APT_PACKAGES));
    // What a computer with the desktops' packages still lacks: they bring every other library Chrome links.
    expect(BROWSER_APT_PACKAGES).toEqual(expect.arrayContaining(["libnss3", "libnspr4", "libasound2"]));

    // Debian 13, Ubuntu 24.04: the renamed ones by their new names (Ubuntu's apt won't pick libasound2t64 itself).
    const renamed = ["libasound2", "libatk-bridge2.0-0", "libatk1.0-0", "libatspi2.0-0", "libcups2", "libglib2.0-0"];
    const t64 = BROWSER_APT_PACKAGES.map((p) => (renamed.includes(p) ? `${p}t64` : p));
    r = step(false, { known: t64 });
    expect(r.calls).toBe(update + install(t64));
    expect(r.calls).toContain(" libasound2t64 ");

    // With --desktop: one install with the screens' packages too.
    r = step(true, { known: t64 });
    const screens =
      "◒  Installing the packages for the agents' browser and screens\n◇  The packages for the agents' browser and screens\n";
    expect(r.out).toBe(`${head}${screens}`);
    // Then the screens' theme, their CJK fonts and their dock, each in its own call where apt has it: a failure
    // only says so.
    const look = install(DESKTOP_LOOK_APT_PACKAGES);
    const cjk = install(DESKTOP_CJK_APT_PACKAGES);
    const dock = install(DESKTOP_DOCK_APT_PACKAGES);
    expect(DESKTOP_CJK_APT_PACKAGES).toEqual(["fonts-noto-cjk"]);
    expect(DESKTOP_DOCK_APT_PACKAGES).toEqual(["xfce4-docklike-plugin"]);
    expect(r.calls).toBe(update + install([...t64, ...DESKTOP_APT_PACKAGES]) + look + cjk + dock);
    // No Orchis (Ubuntu 22.04): the fonts and the dock are still asked for, each on its own.
    r = step(true, { known: t64, missing: ["orchis-gtk-theme"] });
    expect(r.status).toBe(0);
    expect(r.out).toContain(
      "▲  The agents' screens keep the stock theme: apt has no orchis-gtk-theme librsvg2-common here\n",
    );
    expect(r.calls.endsWith(look + cjk + dock)).toBe(true);
    r = step(true, { known: t64, missing: ["fonts-noto-cjk"] });
    expect(r.status).toBe(0);
    expect(r.out).toContain(
      "▲  The agents' screens show Chinese, Japanese and Korean text as boxes: apt has no fonts-noto-cjk here\n",
    );
    expect(r.calls.endsWith(cjk + dock)).toBe(true);
    // Debian 12, Ubuntu 24.04: the theme and the fonts, and the panel's own dock.
    r = step(true, { known: t64, missing: ["xfce4-docklike-plugin"] });
    expect(r.status).toBe(0);
    expect(r.out).toBe(
      `${head}${screens}▲  The agents' screens keep the panel's own dock: apt has no xfce4-docklike-plugin here\n`,
    );

    // No apt: what to install, by name.
    r = step(true, { apt: false });
    expect(r.status).toBe(0);
    expect(r.calls).toBe("");
    expect(r.out).toBe(
      `${head}▲  For the agents' browser and screens, install these packages (Debian names) with this computer's package manager: ${[...BROWSER_APT_PACKAGES, ...DESKTOP_APT_PACKAGES].join(" ")}\n`,
    );
  },
);

test("one Bun for the repo, its image and system-mode computers (1.3.5 or newer)", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { packageManager: string };
  expect(pkg.packageManager).toBe(`bun@${RUNNER_BUN_VERSION}`);
  expect(readFileSync(path.join(root, "Dockerfile"), "utf8")).toContain(`FROM oven/bun:${RUNNER_BUN_VERSION}\n`);
  expect(readFileSync(path.join(root, "apps/mobile/eas.json"), "utf8")).toContain(`"bun": "${RUNNER_BUN_VERSION}"`);
  const [major = 0, minor = 0, patch = 0] = RUNNER_BUN_VERSION.split(".").map(Number);
  expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(1_003_005);
});
