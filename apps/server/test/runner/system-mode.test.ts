import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { MACHINE_OPS, type MachineRequest } from "@agenteschat/adapters/machine-protocol";
import {
  DEFAULT_AGENT_UID_RANGE,
  normalizeStored,
  parseUidRange,
  readStoredConfig,
  SYSTEM_RUNNER_HOME,
  writeConfig,
} from "../../runner/config";
import { configFromGrant } from "../../runner/daemon";
import { type HandlerContext, handleRequest, SYSTEM_MODE_OPS } from "../../runner/handlers";
import { installScript, RUNNER_BUN_SHA256, RUNNER_BUN_VERSION } from "../../runner/install-script";
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

test("a system-mode runner (root) does no agent work itself; machine-level ops still answer", async () => {
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
  expect(existsSync(marker)).toBe(false);
  // Past the system-mode check: this context simply keeps no accounts or access settings.
  const account = { op: "account", action: "list" } as unknown as MachineRequest;
  expect(await errorCode(() => handleRequest(ctx, account, scope))).toBe("bad_request");
  const reduce = { op: "access.reduce", folders: [] } as unknown as MachineRequest;
  expect(await errorCode(() => handleRequest(ctx, reduce, scope))).toBe("bad_request");
  for (const op of SYSTEM_MODE_OPS) expect(MACHINE_OPS).toContain(op as never);

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
});

test("install.sh --system: the pinned Bun with its SHA-256, packages without recommends, nothing runs until the end", () => {
  const script = installScript("https://agentes.test");
  expect(script).toContain(`BUN_VERSION='${RUNNER_BUN_VERSION}'`);
  for (const [target, sha] of Object.entries(RUNNER_BUN_SHA256)) {
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(script).toContain(`${target}) BUN_SHA256='${sha}' ;;`);
  }
  expect(script).toContain('sha256sum "$WORK/bun.zip"');
  expect(script).toContain("--no-install-recommends");
  expect(script).toContain("elementary-xfce-icon-theme");
  expect(script).toContain("RUNNER_HOME='/var/lib/agentes-runner'");
  expect(script).toContain("LAUNCHER='/usr/local/bin/agentes-runner'");
  expect(script).toContain("service install --system --no-start");
  expect(script.trimEnd().endsWith('main "$@"')).toBe(true);
});

test("one Bun for the repo, its image and system-mode computers (1.3.5 or newer)", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { packageManager: string };
  expect(pkg.packageManager).toBe(`bun@${RUNNER_BUN_VERSION}`);
  expect(readFileSync(path.join(root, "Dockerfile"), "utf8")).toContain(`FROM oven/bun:${RUNNER_BUN_VERSION}\n`);
  expect(readFileSync(path.join(root, "apps/mobile/eas.json"), "utf8")).toContain(`"bun": "${RUNNER_BUN_VERSION}"`);
  const [major = 0, minor = 0, patch = 0] = RUNNER_BUN_VERSION.split(".").map(Number);
  expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(1_003_005);
});
