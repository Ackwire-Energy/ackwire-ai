import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_AGENT_UID_RANGE, pairedConfig, runnerHome, updateConfig } from "./config";
import { thisRunner } from "./launch";

export const SERVICE_NAME = "agentes-runner";
export const LAUNCHD_LABEL = "chat.agentes.runner";
export const WINDOWS_TASK = "agentes-runner";
export const SYSTEM_UNIT_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`;
/** The root service's PATH: only folders root owns, never the installing shell's. */
const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Whether systemd runs this computer (PID 1). */
export const systemdBooted = () => existsSync("/run/systemd/system");

/** System mode: each agent's processes run in its own slice, `agents-<uid>.slice` (inside `agents.slice`). */
const AGENT_SLICE_PREFIX = "agents-";
export const agentSlice = (uid: number) => `${AGENT_SLICE_PREFIX}${uid}.slice`;
/**
 * What every agent's slice may use, as a drop-in for the slice prefix: room
 * for a desktop, a headed Chrome and one coding CLI, and no agent can starve
 * the others or the computer.
 */
export const AGENT_SLICE_LIMITS = "[Slice]\nMemoryMax=1536M\nTasksMax=1024\nCPUQuota=200%\n";
/** The drop-in sits next to the unit (`/etc/systemd/system`). */
export const agentSliceLimitsPath = (unitPath = SYSTEM_UNIT_PATH) =>
  path.join(path.dirname(unitPath), `${AGENT_SLICE_PREFIX}.slice.d`, "limits.conf");

/**
 * How the service starts the runner: this runtime (node or bun) and this
 * script, absolute; or a compiled runner alone (`script` absent, ADR 0036).
 */
export interface Launch {
  runtime: string;
  script?: string;
  home: string;
  /** The PATH services get (default: the installing shell's). */
  path?: string;
}

export function currentLaunch(): Launch {
  const [runtime, script] = thisRunner();
  return { runtime: runtime as string, ...(script ? { script } : {}), home: runnerHome() };
}

/** The command line people can run themselves (shown when no service can be installed). */
const plainCommand = (launch: Launch) => [launch.runtime, ...(launch.script ? [launch.script] : [])].join(" ");

/** systemd's quoting: double quotes, backslash and `$`/`%` escaped. */
function systemdQuote(s: string) {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "$$$$").replace(/%/g, "%%")}"`;
}

/** `Environment=` takes no `$` expansion, only `%` specifiers. */
function systemdEnv(name: string, value: string) {
  return `"${name}=${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

function xmlEscape(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function systemdUnitPath(home = os.homedir()) {
  return path.join(home, ".config", "systemd", "user", `${SERVICE_NAME}.service`);
}

export function launchdPlistPath(home = os.homedir()) {
  return path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/**
 * A systemd unit for the runner. Exit codes 0 (another runner took over), 2
 * (token revoked) and 3 (runner too old) don't restart: retrying can't fix
 * them. `KillMode=process`: stopping or restarting the runner (an update)
 * leaves its background tasks running (ADR 0029); they are in the unit's cgroup.
 */
function unitFile(launch: Launch, o: { description: string; path: string; wantedBy: string }): string {
  return [
    "[Unit]",
    `Description=${o.description}`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `ExecStart=${[launch.runtime, ...(launch.script ? [launch.script] : [])].map(systemdQuote).join(" ")} start`,
    `Environment=${systemdEnv("AGENTES_RUNNER_HOME", launch.home)}`,
    "Environment=AGENTES_RUNNER_SERVICE=systemd",
    `Environment=${systemdEnv("PATH", o.path)}`,
    "Restart=always",
    "RestartSec=5",
    "RestartPreventExitStatus=0 2 3",
    "KillMode=process",
    "",
    "[Install]",
    `WantedBy=${o.wantedBy}`,
    "",
  ].join("\n");
}

/** The user unit, with the install-time PATH (like the launchd plist): tasks find claude, codex, git, node, gh. */
export function systemdUnit(launch: Launch): string {
  return unitFile(launch, {
    description: "agentes.chat runner (connected computer)",
    path: launch.path ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    wantedBy: "default.target",
  });
}

/** System mode's unit (`SYSTEM_UNIT_PATH`): root, for the whole computer, from boot. */
export function systemdSystemUnit(launch: Launch): string {
  return unitFile(launch, {
    description: "agentes.chat runner (each agent as its own user)",
    path: SYSTEM_PATH,
    wantedBy: "multi-user.target",
  });
}

/**
 * The launchd agent. KeepAlive restarts it unless it exits cleanly; under
 * launchd the runner exits 0 when retrying can't help (see main.ts).
 * `AbandonProcessGroup`: background tasks outlive a runner restart.
 */
export function launchdPlist(launch: Launch): string {
  const log = path.join(launch.home, "runner.log");
  const s = (v: string) => `<string>${xmlEscape(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${s(LAUNCHD_LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${[launch.runtime, ...(launch.script ? [launch.script] : []), "start"].map(s).join("\n    ")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTES_RUNNER_HOME</key>
    ${s(launch.home)}
    <key>AGENTES_RUNNER_SERVICE</key>
    ${s("launchd")}
    <key>PATH</key>
    ${s(process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  ${s(log)}
  <key>StandardErrorPath</key>
  ${s(log)}
</dict>
</plist>
`;
}

/** cmd.exe quoting for one argument inside `/TR "…"`. */
export function windowsTaskCommand(launch: Launch): { install: string; run: string; uninstall: string } {
  const tr = `${[launch.runtime, ...(launch.script ? [launch.script] : [])].map((a) => `\\"${a}\\"`).join(" ")} start`;
  return {
    install: `schtasks /Create /TN ${WINDOWS_TASK} /SC ONLOGON /RL LIMITED /F /TR "${tr}"`,
    run: `schtasks /Run /TN ${WINDOWS_TASK}`,
    uninstall: `schtasks /Delete /TN ${WINDOWS_TASK} /F`,
  };
}

interface RunResult {
  code: number;
  output: string;
}

export type RunCommand = (file: string, args: string[]) => RunResult;

export const runSync: RunCommand = (file, args) => {
  const r = spawnSync(file, args, { encoding: "utf8" });
  if (r.error) return { code: 127, output: r.error.message };
  return { code: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};

export function systemdUserAvailable(run: RunCommand = runSync) {
  return process.platform === "linux" && run("systemctl", ["--user", "show-environment"]).code === 0;
}

export interface ServiceIo {
  print: (line: string) => void;
  run?: RunCommand;
  launch?: Launch;
  sleep?: (ms: number) => void;
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Installs and starts the service. Returns the process exit code. */
export function installService(io: ServiceIo): number {
  const run = io.run ?? runSync;
  const launch = io.launch ?? currentLaunch();
  const { print } = io;
  if (process.platform === "linux") {
    if (!systemdUserAvailable(run)) {
      print("systemd (user session) isn't available here. Start the runner yourself, for example in tmux:");
      print(`  ${plainCommand(launch)} start`);
      return 1;
    }
    const file = systemdUnitPath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, systemdUnit(launch));
    for (const args of [
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", SERVICE_NAME],
      ["--user", "restart", SERVICE_NAME],
    ]) {
      const r = run("systemctl", args);
      if (r.code !== 0) {
        print(`systemctl ${args.join(" ")} failed: ${r.output}`);
        return 1;
      }
    }
    print(`Installed ${file} and started it.`);
    print(`Logs: journalctl --user -u ${SERVICE_NAME} -f`);
    print(`To keep it running after you log out: loginctl enable-linger ${os.userInfo().username}`);
    return 0;
  }
  if (process.platform === "darwin") {
    const file = launchdPlistPath();
    mkdirSync(path.dirname(file), { recursive: true });
    mkdirSync(launch.home, { recursive: true, mode: 0o700 });
    const uid = process.getuid?.() ?? os.userInfo().uid;
    const sleep = io.sleep ?? sleepSync;
    const service = `gui/${uid}/${LAUNCHD_LABEL}`;
    // `bootout` returns before the old service is gone; a `bootstrap` right
    // after fails ("Input/output error") and leaves nothing running.
    if (run("launchctl", ["bootout", service]).code === 0) {
      for (let i = 0; i < 50 && run("launchctl", ["print", service]).code === 0; i++) sleep(100);
    }
    writeFileSync(file, launchdPlist(launch));
    let r = run("launchctl", ["bootstrap", `gui/${uid}`, file]);
    for (let i = 0; i < 5 && r.code !== 0; i++) {
      sleep(500);
      r = run("launchctl", ["bootstrap", `gui/${uid}`, file]);
    }
    if (r.code !== 0) {
      const legacy = run("launchctl", ["load", "-w", file]);
      if (legacy.code !== 0) {
        print(`launchctl couldn't load ${file}: ${r.output || legacy.output}`);
        return 1;
      }
    }
    print(`Installed ${file} and started it.`);
    print(`Logs: ${path.join(launch.home, "runner.log")}`);
    return 0;
  }
  if (process.platform === "win32") {
    const cmd = windowsTaskCommand(launch);
    print("On Windows, register the runner with Task Scheduler (run in a Command Prompt):");
    print(`  ${cmd.install}`);
    print(`  ${cmd.run}`);
    print(`To remove it: ${cmd.uninstall}`);
    return 0;
  }
  print(`No service support on ${process.platform}. Run: ${plainCommand(launch)} start`);
  return 1;
}

export interface SystemServiceIo extends ServiceIo {
  /** False (`--no-start`): install or update without starting or restarting anything. */
  start?: boolean;
  /** `--agent-uid-range`; absent keeps the home's range, or the default. */
  agentUidRange?: [number, number];
  uid?: number;
  platform?: NodeJS.Platform;
  unitPath?: string;
  /** Whether systemd runs this computer (default: `/run/systemd/system` exists). */
  booted?: boolean;
}

/**
 * System mode (`install.sh --system`): marks the home as a system home and
 * installs the root unit. It starts only once paired: an unpaired runner
 * would just restart in a loop.
 */
export function installSystemService(io: SystemServiceIo): number {
  const run = io.run ?? runSync;
  const launch = io.launch ?? currentLaunch();
  const { print } = io;
  if ((io.platform ?? process.platform) !== "linux") {
    print("System mode is for Linux.");
    return 1;
  }
  if ((io.uid ?? process.getuid?.()) !== 0) {
    print("System mode installs the runner for the whole computer: run it as root.");
    return 1;
  }
  const stored = updateConfig(
    (c) => ({ ...c, mode: "system", agentUidRange: io.agentUidRange ?? c.agentUidRange ?? DEFAULT_AGENT_UID_RANGE }),
    launch.home,
  );
  const file = io.unitPath ?? SYSTEM_UNIT_PATH;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, systemdSystemUnit(launch));
  const limits = agentSliceLimitsPath(file);
  mkdirSync(path.dirname(limits), { recursive: true });
  writeFileSync(limits, AGENT_SLICE_LIMITS);
  const start = io.start !== false;
  if (!(io.booted ?? systemdBooted())) {
    print(`Installed ${file}, but systemd isn't running here.`);
    if (start) print(`Start the runner yourself: ${plainCommand(launch)} start`);
    return start ? 1 : 0;
  }
  let paired = false;
  try {
    paired = pairedConfig(stored) !== null;
  } catch {
    // incomplete: same as not paired
  }
  const steps = [["daemon-reload"]];
  if (start && paired) steps.push(["enable", SERVICE_NAME], ["restart", SERVICE_NAME]);
  for (const args of steps) {
    const r = run("systemctl", args);
    if (r.code !== 0) {
      print(`systemctl ${args.join(" ")} failed: ${r.output}`);
      return 1;
    }
  }
  if (!start) print(`Installed ${file} (not started).`);
  else if (!paired) {
    print(`Installed ${file}. Connect this computer first (agentes-runner pair --server <url>), then start it:`);
    print(`  systemctl enable --now ${SERVICE_NAME}`);
  } else {
    print(`Installed ${file} and started it.`);
    print(`Logs: journalctl -u ${SERVICE_NAME} -f`);
  }
  return 0;
}

export function uninstallService(io: ServiceIo & { system?: boolean }): number {
  const run = io.run ?? runSync;
  const { print } = io;
  if (io.system) {
    run("systemctl", ["disable", "--now", SERVICE_NAME]);
    if (existsSync(SYSTEM_UNIT_PATH)) rmSync(SYSTEM_UNIT_PATH);
    rmSync(agentSliceLimitsPath(), { force: true });
    run("systemctl", ["daemon-reload"]);
    print(`Removed ${SYSTEM_UNIT_PATH}.`);
    return 0;
  }
  if (process.platform === "linux") {
    const file = systemdUnitPath();
    run("systemctl", ["--user", "disable", "--now", SERVICE_NAME]);
    if (existsSync(file)) rmSync(file);
    run("systemctl", ["--user", "daemon-reload"]);
    print(`Removed ${file}.`);
    return 0;
  }
  if (process.platform === "darwin") {
    const file = launchdPlistPath();
    const uid = process.getuid?.() ?? os.userInfo().uid;
    const r = run("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
    if (r.code !== 0 && existsSync(file)) run("launchctl", ["unload", "-w", file]);
    if (existsSync(file)) rmSync(file);
    print(`Removed ${file}.`);
    return 0;
  }
  if (process.platform === "win32") {
    print(`Run in a Command Prompt: ${windowsTaskCommand(io.launch ?? currentLaunch()).uninstall}`);
    return 0;
  }
  print(`No service support on ${process.platform}.`);
  return 0;
}

/** Where the service is installed, or null. */
export function serviceStatus(run: RunCommand = runSync, system = false): string | null {
  if (system) {
    if (!existsSync(SYSTEM_UNIT_PATH)) return null;
    const active = run("systemctl", ["is-active", SERVICE_NAME]).output || "unknown";
    return `systemd unit ${SYSTEM_UNIT_PATH} (${active})`;
  }
  if (process.platform === "linux") {
    const file = systemdUnitPath();
    if (!existsSync(file)) return null;
    const active = run("systemctl", ["--user", "is-active", SERVICE_NAME]).output || "unknown";
    return `systemd user unit ${file} (${active})`;
  }
  if (process.platform === "darwin") {
    const file = launchdPlistPath();
    return existsSync(file) ? `launchd agent ${file}` : null;
  }
  if (process.platform === "win32") {
    return run("schtasks", ["/Query", "/TN", WINDOWS_TASK]).code === 0 ? `scheduled task ${WINDOWS_TASK}` : null;
  }
  return null;
}
