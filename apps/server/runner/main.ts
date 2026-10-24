/**
 * agentes-runner: connects this computer to an agentes.chat organization
 * (ADR 0025). Bundled to one file for Node.js 22+ and Bun:
 *   bun build apps/server/runner/main.ts --target=node --banner '#!/usr/bin/env node' --outfile apps/web/dist/runner/agentes-runner.mjs
 * or compiled to one executable for the desktop app (ADR 0036), no runtime needed:
 *   bun build --compile --target=bun-darwin-arm64 apps/server/runner/main.ts --outfile agentes-runner
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type AgentScope, MACHINE_PROTOCOL_VERSION, type RunnerTools } from "@agenteschat/adapters/machine-protocol";
import {
  addFolder,
  ControlError,
  checkFolder,
  readAgents,
  removeFolder,
  resolveAgentHandle,
  setTool,
  TOOL_NAMES,
} from "./access";
import { AgentUsers, agentGid, systemLauncher } from "./agent-users";
import {
  configPath,
  DEFAULT_AGENT_UID_RANGE,
  effectiveAccess,
  expandHome,
  normalizeServerUrl,
  pairedConfig,
  parseUidRange,
  readConfig,
  readStoredConfig,
  runnerHome,
  type StoredConfig,
  updateConfig,
  writeConfig,
} from "./config";
import { runControl } from "./control";
import { configFromGrant, deviceInfo, prepareWorkspace, previousMachineFor, RunnerDaemon } from "./daemon";
import { DesktopManager } from "./desktop";
import { DesktopSessions, type DesktopSessionsOptions, runnerUser, systemDesktopUser } from "./desktop-session";
import { RUNNER_VERSION } from "./errors";
import { runningCompiled, thisRunner } from "./launch";
import { acquireLock, lockedMessage, pidAlive, readLock } from "./lock";
import { RotatingFile } from "./logfile";
import { adoptLoginPath } from "./login-path";
import { MCP_TOKEN_FILE, mcpSocketPath, runMcpServer } from "./mcp";
import {
  type DeviceGrant,
  devicePair,
  formatUserCode,
  PairingError,
  redeemIssuedCode,
  takeEnrollCode,
} from "./pairing";
import { agentWorkspace } from "./paths";
import { connectVnc, type VncConnection, vncInit } from "./rfb";
import { installService, installSystemService, serviceStatus, uninstallService } from "./service";
import type { DataListener, DataSocket } from "./streams";
import { runTaskWrapper } from "./tasks";
import { runnerTerminalUser, systemTerminalUser, Terminals, type TerminalsOptions } from "./terminal";
import { runWorker } from "./worker";

const HELP = `agentes-runner ${RUNNER_VERSION}: connects this computer to agentes.chat

Usage:
  agentes-runner pair --server <url> [--dir <workspace>] [--name <name>] [--no-exec] [--new]
      Shows a code and a link; confirm it on the site (signed in) and this computer is connected.
      Paired with that server before (even if it was removed there): it comes back as the same
      computer, with its name, permissions and agents, when you may manage it.
      --dir      the folder agents work in (default ~/agentes)
      --no-exec  files and uploads only; agents can't run commands
      --new      connect as a new computer instead
  agentes-runner pair --server <url> --enroll-file <path> [--dir <workspace>] [--name <name>] [--no-exec]
      Connects with a code issued for this computer by whoever provisions it; nobody confirms it.
      The file is removed as soon as it is read.
  agentes-runner start
      Connects and stays connected (reconnects on its own).
  agentes-runner service install|uninstall
      Runs it in the background at login (systemd user unit, launchd agent, or Task Scheduler on Windows).
  agentes-runner service install --system [--agent-uid-range <first-last>] [--no-start]
      Linux, as root: the runner for the whole computer, each agent as its own user
      (uids 20000-29999 unless given). install.sh --system runs it.
  agentes-runner update
      Downloads the latest runner from the server and restarts the service (keeps the pairing).
  agentes-runner status
  agentes-runner folders [list | allow <path> [--agent <handle>]... | remove <path> [--agent <handle>]...]
      Folders agents may use besides their own (an agent's handle, as on the site).
  agentes-runner tools [list | enable <tool> | disable <tool>]
      Turns claude (Claude Code), codex (Codex) or commands on or off on this computer.
  agentes-runner desktop-check --agent <handle>
      Checks an agent's desktop and terminal here (Linux): starts its desktop, logs in to it as the
      person in control and as a watcher (who can't move the pointer), reads it and acts on it the
      way the agent does (with how long each takes), opens a terminal as the agent, then stops what
      it started. Stop the runner first.
  agentes-runner app --home <dir>
      The desktop app's runner (a JSON-lines protocol on stdin/stdout; not for people).
  agentes-runner mcp --task <taskId> | --run <runId>
      The agentes MCP server of a mission task (started by Claude Code or Codex, not by people).
  agentes-runner worker --agent <id> --dir <folder> --home <dir>
      System mode: one agent's work, as that agent's own user (started by the runner, not by people).
  agentes-runner --help | --version

Every command takes --home <dir> (default $AGENTES_RUNNER_HOME or ~/.agentes-runner).
Config: <home>/config.json (mode 600; optional "maxConcurrentTasks" (default 3) and
"taskMaxSeconds" (default 14400) for background tasks; "brainIdleMinutes" (default 10) and
"brainMaxProcesses" (default 3) for agents thinking with Claude Code). Changes apply while it runs.
Background tasks keep running when the runner restarts; their logs are in tasks/.
Commands run as the user that runs the runner; consider a dedicated OS user.`;

const stamp = (line: string) => `${new Date().toISOString()} ${line}`;
const log = (line: string) => console.log(stamp(line));

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
  /** Flags that may repeat (`--agent a --agent b`). */
  lists: Map<string, string[]>;
}

const VALUE_FLAGS = new Set([
  "server",
  "dir",
  "name",
  "task",
  "run",
  "home",
  "agent",
  "code",
  "agent-uid-range",
  "enroll-file",
]);
const LIST_FLAGS = new Set(["agent"]);

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const lists = new Map<string, string[]>();
  const set = (key: string, value: string | true) => {
    flags.set(key, value);
    if (LIST_FLAGS.has(key) && typeof value === "string") lists.set(key, [...(lists.get(key) ?? []), value]);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-h") flags.set("help", true);
    else if (arg === "-v") flags.set("version", true);
    else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      if (eq > 0) set(key, arg.slice(eq + 1));
      else if (VALUE_FLAGS.has(key)) {
        const value = argv[i + 1];
        if (value === undefined) throw new Error(`--${key} needs a value`);
        set(key, value);
        i++;
      } else set(key, true);
    } else positional.push(arg);
  }
  return { positional, flags, lists };
}

const flagString = (p: Parsed, key: string) => {
  const v = p.flags.get(key);
  return typeof v === "string" ? v : undefined;
};

const DESKTOP_MANAGED =
  "This computer's connection is managed by the agentes app. Use the app (it ships the runner and keeps it running).";

function storedOrNull(home = runnerHome()): StoredConfig | null {
  try {
    return readStoredConfig(home);
  } catch {
    return null;
  }
}

/**
 * The device-code connection from a terminal (ADR 0036 §5): prints a code and a link, waits for the site.
 * With `--enroll-file`, redeems a code issued for this computer instead (ADR 0056 §10).
 */
async function pair(p: Parsed): Promise<number> {
  const usage =
    "Usage: agentes-runner pair --server <url> [--enroll-file <path>] [--dir <workspace>] [--name <name>] [--no-exec] [--new]";
  let enrollCode: string | undefined;
  if (p.flags.has("enroll-file")) {
    // Taken first, so no failure below leaves the code on disk.
    try {
      enrollCode = takeEnrollCode(flagString(p, "enroll-file") ?? "");
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }
  if (p.flags.has("code")) {
    console.error(
      "Pairing codes from the site are gone: run agentes-runner pair --server <url> and confirm the code it shows.",
    );
    return 1;
  }
  const serverRaw = flagString(p, "server");
  if (!serverRaw) {
    console.error(usage);
    return 1;
  }
  const server = normalizeServerUrl(serverRaw);
  const home = runnerHome();
  const prev = storedOrNull(home);
  if (prev?.managedBy === "desktop") {
    console.error(DESKTOP_MANAGED);
    return 1;
  }
  // Created only once the connection worked.
  const workspace = expandHome(flagString(p, "dir") ?? prev?.workspace ?? "~/agentes");
  const exec = !p.flags.has("no-exec");
  const name = flagString(p, "name");
  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.once("SIGINT", onSignal);
  let grant: DeviceGrant;
  try {
    grant = enrollCode
      ? await redeemIssuedCode(server, enrollCode, { signal: ac.signal })
      : await devicePair(
          server,
          deviceInfo(name, p.flags.has("new") ? undefined : previousMachineFor(prev, server)),
          (code) => {
            console.log("");
            console.log(
              `To connect this computer, open this link and confirm the code ${formatUserCode(code.userCode)}:`,
            );
            console.log("");
            console.log(`  ${code.verificationUrl}`);
            console.log("");
            console.log(
              `The code expires in ${Math.max(1, Math.round(code.expiresIn / 60))} minutes. Waiting for the confirmation...`,
            );
          },
          { signal: ac.signal },
        );
  } catch (err) {
    if (err instanceof PairingError) {
      if (err.code === "canceled") console.error("Canceled.");
      else if (enrollCode) console.error(err.message);
      else if (err.code === "denied") console.error("The connection was refused on the site. Nothing changed.");
      else if (err.code === "expired") console.error("The code expired before it was confirmed. Run this again.");
      else console.error(err.message);
      return 1;
    }
    throw err;
  } finally {
    process.off("SIGINT", onSignal);
  }
  const workspaceReal = prepareWorkspace(workspace);
  const next = configFromGrant(prev, {
    server,
    grant,
    workspace: workspaceReal,
    ...(name ? { name } : {}),
    tools: { claude: exec, codex: exec, commands: exec },
    desktop: false,
  });
  writeConfig(next, home);
  console.log("");
  console.log(
    `Connected${grant.org.name ? ` to ${grant.org.name}` : ""} as "${next.name}". Workspace: ${workspaceReal}${exec ? "" : " (commands off)"}`,
  );
  console.log(`Config: ${configPath(home)}`);
  console.log("Next: agentes-runner start (or agentes-runner service install to run it in the background)");
  return 0;
}

async function start(): Promise<number> {
  const home = runnerHome();
  const config = readConfig(home);
  if (!config) {
    console.error(`This computer isn't connected yet (${configPath(home)}). Run: agentes-runner pair --server <url>`);
    return 1;
  }
  if (typeof WebSocket === "undefined") {
    console.error(`This runtime has no WebSocket client (${process.version}); use Node.js 22 or newer, or Bun`);
    return 1;
  }
  const lock = acquireLock(home, "start");
  if (!lock.ok) {
    console.error(lockedMessage(home, lock.holder));
    return serviceSafe(4);
  }
  const daemon = new RunnerDaemon({ home, mode: "start", log, print: (line) => console.log(line) });
  const stop = () => void daemon.stop();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const outcome = await daemon.runStart();
    switch (outcome.reason) {
      case "stopped":
        log("stopped");
        return 0;
      case "replaced":
        log("Another runner connected with this computer's token and took over; this one stops.");
        return 0;
      case "outdated":
        log("This runner is too old for the server. Update it: agentes-runner update");
        return serviceSafe(3);
      default:
        log("Connect this computer again: agentes-runner pair --server <url>");
        return serviceSafe(2);
    }
  } finally {
    await daemon.stop();
    lock.release();
  }
}

/** Under launchd (KeepAlive unless it exits cleanly), a refusal exits 0 so it isn't restarted in a loop. */
function serviceSafe(code: number) {
  return process.env.AGENTES_RUNNER_SERVICE === "launchd" ? 0 : code;
}

/**
 * `agentes-runner app`: the desktop app's child (ADR 0036 §3). stdout is the
 * control protocol only; everything that would be printed goes to the log.
 */
async function app(): Promise<number> {
  const home = runnerHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const logFile = path.join(home, "logs", "runner.log");
  const file = new RotatingFile(logFile);
  const write = (line: string) => {
    try {
      file.append(`${stamp(line)}\n`);
    } catch {
      // a full disk never stops the runner
    }
  };
  // Nothing but protocol lines on stdout, whatever a module prints.
  const toLog = (...args: unknown[]) => write(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  console.log = toLog;
  console.info = toLog;
  console.warn = toLog;
  console.debug = toLog;
  console.error = toLog;
  process.stdout.on("error", () => {});
  const lock = acquireLock(home, "app");
  const ac = new AbortController();
  process.once("SIGTERM", () => ac.abort());
  process.once("SIGINT", () => ac.abort());
  write(`agentes-runner ${RUNNER_VERSION} (app mode, home ${home})`);
  // Opened from Finder: the bare macOS PATH finds neither the coding CLIs nor the person's tools.
  adoptLoginPath(write);
  try {
    return await runControl({
      home,
      input: process.stdin,
      output: process.stdout,
      locked: lock.ok ? null : lock.holder,
      daemon: { log: write, logFile },
      signal: ac.signal,
    });
  } finally {
    if (lock.ok) lock.release();
  }
}

/**
 * `agentes-runner worker` (system mode): stdout is the link to the root
 * runner, so it carries frames only; anything printed goes to stderr, which
 * the root runner logs.
 */
async function worker(p: Parsed): Promise<number> {
  const agentId = flagString(p, "agent");
  const dir = flagString(p, "dir");
  if (!agentId || !dir || !flagString(p, "home")) {
    console.error("Usage: agentes-runner worker --agent <id> --dir <folder> --home <dir>");
    return 1;
  }
  if (process.getuid?.() === 0) {
    console.error("A worker runs as its agent's own user, never as root.");
    return 1;
  }
  const toStderr = (...args: unknown[]) =>
    process.stderr.write(`${args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")}\n`);
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  process.stdout.on("error", () => {});
  return runWorker({
    agentId,
    home: runnerHome(),
    dir: expandHome(dir),
    input: process.stdin,
    output: process.stdout,
    // The root runner's log stamps it.
    log: (line) => toStderr(line),
  });
}

/** Replaces this script with the server's latest bundle; the pairing and the workspace stay. */
async function update(): Promise<number> {
  const stored = storedOrNull();
  if (stored?.managedBy === "desktop") {
    console.error(`${DESKTOP_MANAGED} To update, install the new version of the app.`);
    return 1;
  }
  // A root runner never replaces itself with whatever the server sends.
  if (stored?.mode === "system") {
    console.error(
      `This computer runs the runner for all its agents: update it with the installer, as root (curl -fsSL ${stored.server ?? "<server>"}/api/machines/install.sh | sh -s -- --system).`,
    );
    return 1;
  }
  if (runningCompiled()) {
    console.error(
      "This runner is a single executable: install its new version instead (agentes-runner update replaces the script only).",
    );
    return 1;
  }
  const config = readConfig();
  if (!config) {
    console.error("Not connected yet: run the install command from Settings > Computers.");
    return 1;
  }
  const script = thisRunner()[1] ?? "";
  const url = `${config.server}/runner/agentes-runner.mjs`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Download failed: ${res.status} ${url}`);
    return 1;
  }
  const text = await res.text();
  if (!text.startsWith("#!") || !text.includes("agentes-runner")) {
    console.error(`${url} doesn't look like the runner; nothing changed.`);
    return 1;
  }
  writeFileSync(`${script}.new`, text, { mode: 0o755 });
  renameSync(`${script}.new`, script);
  console.log(`Updated ${script}.`);
  if (!serviceStatus()) {
    console.log("Restart the runner (agentes-runner start) to use it.");
    return 0;
  }
  return installService({ print: (l) => console.log(l) });
}

function status(): number {
  const home = runnerHome();
  const stored = storedOrNull(home);
  const config = readConfig(home);
  const bun = (process.versions as { bun?: string }).bun;
  console.log(
    `agentes-runner ${RUNNER_VERSION} (protocol ${MACHINE_PROTOCOL_VERSION}) on ${bun ? `bun ${bun}` : `${process.release.name} ${process.version}`}${runningCompiled() ? " (compiled)" : ""}`,
  );
  console.log(`Config: ${configPath(home)}`);
  if (!config) console.log("Not connected.");
  if (stored) {
    const { token: _token, ...visible } = stored;
    console.log(JSON.stringify(visible, null, 2));
  }
  const holder = readLock(home);
  console.log(
    holder && pidAlive(holder.pid)
      ? `Running: pid ${holder.pid}${holder.mode ? ` (${holder.mode})` : ""}`
      : "Running: no",
  );
  const service = serviceStatus(undefined, stored?.mode === "system");
  console.log(service ? `Service: ${service}` : "Service: not installed");
  return 0;
}

/** For `folders` and `tools`: the paired config, or a message. */
function pairedOrExit(home: string) {
  const stored = storedOrNull(home);
  const config = stored ? pairedConfig(stored, configPath(home)) : null;
  if (!config || !stored) {
    console.error("This computer isn't connected yet. Run: agentes-runner pair --server <url>");
    return null;
  }
  return { stored, config };
}

function saveAccess(home: string, access: ReturnType<typeof effectiveAccess>) {
  updateConfig((c) => ({ ...c, access, exec: access.tools.commands }), home);
}

/** What `--agent <handle>` says when no agent by that handle uses this computer. */
const unknownAgent = (given: string, agents: ReturnType<typeof readAgents>) =>
  `No agent @${given.replace(/^@/, "")} uses this computer.${agents.length ? ` Known: ${agents.map((x) => `@${x.handle}`).join(", ")}` : " (The list comes from the server: start the runner once.)"}`;

/** `agentes-runner folders …`: the same config the app edits (a running runner applies it at once). */
function folders(p: Parsed): number {
  const home = runnerHome();
  const paired = pairedOrExit(home);
  if (!paired) return 1;
  const [, sub = "list", target] = p.positional;
  const access = effectiveAccess(paired.stored);
  const agents = readAgents(home);
  const nameOf = (id: string) => {
    const a = agents.find((x) => x.id === id);
    return a ? `${a.name} (@${a.handle})` : id;
  };
  const handles = p.lists.get("agent") ?? [];
  const ids: string[] = [];
  for (const h of handles) {
    const a = resolveAgentHandle(agents, h);
    if (!a) {
      console.error(unknownAgent(h, agents));
      return 1;
    }
    ids.push(a.id);
  }
  try {
    switch (sub) {
      case "list": {
        if (access.folders.length === 0) console.log("No folders allowed besides each agent's own folder.");
        for (const f of access.folders) {
          console.log(`${f.path}\n    ${f.agents.length ? f.agents.map(nameOf).join(", ") : "no agent uses it yet"}`);
        }
        return 0;
      }
      case "allow": {
        if (!target) {
          console.error("Usage: agentes-runner folders allow <path> [--agent <handle>]...");
          return 1;
        }
        const real = checkFolder(target, { runnerHome: home, workspace: paired.config.workspace });
        saveAccess(home, addFolder(access, real, ids));
        console.log(
          ids.length
            ? `Allowed ${real} for ${ids.map(nameOf).join(", ")}.`
            : `Allowed ${real}; no agent uses it yet (add --agent <handle>).`,
        );
        return 0;
      }
      case "remove": {
        if (!target) {
          console.error("Usage: agentes-runner folders remove <path> [--agent <handle>]...");
          return 1;
        }
        const abs = expandHome(target);
        const found = access.folders.find((f) => f.path === abs || f.path === target || f.path === safeReal(abs));
        if (!found) {
          console.error(`${target} is not an allowed folder (see agentes-runner folders list).`);
          return 1;
        }
        let next = access;
        if (ids.length) for (const id of ids) next = removeFolder(next, found.path, id);
        else next = removeFolder(next, found.path);
        saveAccess(home, next);
        console.log(ids.length ? `Removed ${found.path} for ${ids.map(nameOf).join(", ")}.` : `Removed ${found.path}.`);
        return 0;
      }
      default:
        console.error(
          "Usage: agentes-runner folders [list | allow <path> [--agent <handle>]... | remove <path> [--agent <handle>]...]",
        );
        return 1;
    }
  } catch (err) {
    if (err instanceof ControlError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
}

function safeReal(p: string) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** `agentes-runner tools …`. */
function tools(p: Parsed): number {
  const home = runnerHome();
  const paired = pairedOrExit(home);
  if (!paired) return 1;
  const [, sub = "list", tool] = p.positional;
  const access = effectiveAccess(paired.stored);
  const label: Record<keyof RunnerTools, string> = {
    claude: "Claude Code",
    codex: "Codex",
    commands: "Commands",
    browser: "Browser",
    desktop: "Desktops (each agent's own screen, watched and controlled from the app)",
    terminal: "Terminal (a shell as the agent, opened from the app)",
  };
  if (sub === "list") {
    for (const t of TOOL_NAMES) console.log(`${t.padEnd(9)} ${access.tools[t] ? "on " : "off"}  ${label[t]}`);
    return 0;
  }
  if ((sub === "enable" || sub === "disable") && tool && (TOOL_NAMES as readonly string[]).includes(tool)) {
    const t = tool as keyof RunnerTools;
    saveAccess(home, setTool(access, t, sub === "enable"));
    console.log(`${label[t]} ${sub === "enable" ? "on" : "off"}.`);
    return 0;
  }
  console.error(
    `Usage: agentes-runner tools [list | enable <tool> | disable <tool>] (tools: ${TOOL_NAMES.join(", ")})`,
  );
  return 1;
}

/**
 * `agentes-runner desktop-check --agent <handle>` (ADR 0058): the agent's
 * desktop and terminal on this computer, through the runner's own code, as
 * the user the runner would run them as (in system mode the agent's own). It
 * holds the runner's lock: it starts and stops the agent's desktop itself.
 */
async function desktopCheck(p: Parsed): Promise<number> {
  const home = runnerHome();
  const handle = flagString(p, "agent");
  if (!handle) {
    console.error("Usage: agentes-runner desktop-check --agent <handle>");
    return 1;
  }
  const agents = readAgents(home);
  const agent = resolveAgentHandle(agents, handle);
  const stored = storedOrNull(home);
  const workspace = stored?.workspace;
  if (!agent || !workspace) {
    console.error(unknownAgent(handle, agents));
    return 1;
  }
  const lock = acquireLock(home, "desktop-check");
  if (!lock.ok) {
    console.error(lockedMessage(home, lock.holder));
    return 1;
  }
  try {
    if (stored?.mode === "system") {
      const u = new AgentUsers({ home, range: stored.agentUidRange ?? DEFAULT_AGENT_UID_RANGE }).ensure(agent);
      const launcher = systemLauncher(u);
      const desktop = await checkDesktop(home, agent, {
        user: async () => systemDesktopUser(launcher, { uid: u.uid, gid: agentGid(u.user) }),
        agentUsers: true,
      });
      const terminal = await checkTerminal(agent, {
        user: async () => systemTerminalUser(launcher, agent),
        agentUsers: true,
      });
      return desktop && terminal ? 0 : 1;
    }
    const folder = await agentWorkspace(prepareWorkspace(workspace), agent);
    const desktop = await checkDesktop(home, agent, { user: async (a) => runnerUser(home, folder, a) });
    const terminal = await checkTerminal(agent, { user: async () => runnerTerminalUser(folder) });
    return desktop && terminal ? 0 : 1;
  } finally {
    lock.release();
  }
}

const since = (t0: number) => `${Math.round(performance.now() - t0)} ms`;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Its desktop starts (or runs), both logins work, and a watcher's pointer is ignored; a desktop it started stops. */
async function checkDesktop(
  home: string,
  agent: AgentScope,
  as: Pick<DesktopSessionsOptions, "user" | "agentUsers">,
): Promise<boolean> {
  const desktops = new DesktopSessions({ home, log: (line) => console.log(`     ${line}`), ...as });
  desktops.restore();
  const info = desktops.info();
  if (!info.available) {
    console.log(`FAIL desktop: ${info.reason}`);
    return false;
  }
  const opened: VncConnection[] = [];
  let started = false;
  try {
    const t0 = performance.now();
    const reply = await desktops.ensure(agent);
    started = reply.started;
    console.log(
      `ok   desktop: ${started ? "started" : "running already"} on :${reply.display} (${reply.width}×${reply.height}) in ${since(t0)}`,
    );
    const session = desktops.session(agent.id);
    if (!session) throw new Error("the desktop has no session");
    const login = async (what: string, password: string) => {
      const t = performance.now();
      const vnc = await connectVnc(session.socket, password);
      opened.push(vnc);
      const init = await vncInit(vnc);
      console.log(`ok   ${what}: logged in in ${since(t)}, ${init.width}×${init.height} "${init.name}"`);
      return vnc;
    };
    const control = await login("control (the full password)", session.passwords.full);
    const watch = await login("watch (the view-only password)", session.passwords.view);
    // RFB PointerEvent: type 5, no buttons, x and y.
    const point = async (vnc: VncConnection, x: number, y: number) => {
      vnc.socket.write(Uint8Array.of(5, 0, x >> 8, x & 255, y >> 8, y & 255));
      await sleep(300);
      const found = spawnSync("xdotool", ["getmouselocation"], {
        env: { ...process.env, DISPLAY: `:${session.display}`, XAUTHORITY: session.xauthority },
        encoding: "utf8",
      });
      const m = /x:(\d+) y:(\d+)/.exec(found.stdout ?? "");
      return m ? `${m[1]},${m[2]}` : null;
    };
    const moved = await point(control, 100, 120);
    if (moved === null) console.log("--   view-only: not checked (install xdotool to check it)");
    else if (moved !== "100,120") throw new Error(`the person in control moved the pointer to ${moved}, not 100,120`);
    else {
      const after = await point(watch, 640, 400);
      if (after !== "100,120") throw new Error(`a watcher moved the pointer (to ${after})`);
      console.log("ok   view-only: a watcher's pointer is ignored, the controller's moves it");
    }
    return await checkDesktopUse(desktops, agent);
  } catch (err) {
    console.log(`FAIL desktop: ${errorText(err)}`);
    return false;
  } finally {
    for (const vnc of opened) vnc.socket.destroy();
    if (started) {
      await desktops.stop(agent);
      console.log("ok   desktop: stopped");
    }
    desktops.close();
  }
}

/**
 * Desktop use on that desktop through the runner's own code (ADR 0060), with how long each part takes: a
 * look, an action that settles and looks again, a screenshot and a close-up, the apps. It runs as this
 * command's user, the person at this computer; whether agents may use their desktops here is said first.
 */
async function checkDesktopUse(desktops: DesktopSessions, agent: AgentScope): Promise<boolean> {
  const forAgents = new DesktopManager({ desktops, log: () => undefined }).info();
  console.log(
    forAgents.available
      ? "ok   desktop use: agents can use their desktops here"
      : `--   desktop use: agents can't use their desktops here: ${forAgents.reason}`,
  );
  const uid = process.getuid?.() ?? null;
  const use = new DesktopManager({
    desktops,
    log: (line) => console.log(`     ${line}`),
    // The person at this computer drives the desktop this check started, as its own user.
    uids: () => (uid === null ? null : { runner: -1, agents: new Map([[agent.id, uid]]) }),
  });
  try {
    let t0 = performance.now();
    const first = await use.look(agent);
    const elements = Object.keys(first.refs);
    console.log(
      `ok   desktop use: a look in ${since(t0)} with the helper starting (${first.snapshot.split("\n").length} lines, ${elements.length} elements, ${first.address})`,
    );
    t0 = performance.now();
    await use.look(agent);
    console.log(`ok   desktop use: a look in ${since(t0)}`);
    const ref = elements[0];
    if (ref) {
      t0 = performance.now();
      const acted = await use.act(agent, { kind: "hover", at: { ref } }, true, { folder: process.cwd() });
      console.log(
        `ok   desktop use: a hover on ${ref} (${first.refs[ref]?.role}), settled${acted.settled === false ? " at the cap" : ""} and looked at, in ${since(t0)}`,
      );
    } else console.log("--   desktop use: nothing on the screen to act on");
    t0 = performance.now();
    const shot = await use.capture(agent, null);
    console.log(
      `ok   desktop use: a screenshot in ${since(t0)} (${shot.width}×${shot.height}, ${Math.round((shot.data.length * 3) / 4 / 1024)} KB, ${shot.marks.length} elements marked)`,
    );
    t0 = performance.now();
    const close = await use.capture(agent, { x: 400, y: 250, width: 480, height: 300 });
    console.log(`ok   desktop use: a close-up in ${since(t0)} (${close.width}×${close.height})`);
    const { apps } = await use.apps(agent);
    console.log(
      `ok   desktop use: ${apps.length} apps to start (${apps
        .slice(0, 5)
        .map((a) => a.name)
        .join(", ")})`,
    );
    return true;
  } catch (err) {
    console.log(`FAIL desktop use: ${errorText(err)}`);
    return false;
  } finally {
    use.stopAll();
  }
}

/** A terminal opens as the agent's OS user in its folder, at its size, and ends with its shell. */
async function checkTerminal(agent: AgentScope, as: Pick<TerminalsOptions, "user" | "agentUsers">): Promise<boolean> {
  const terminals = new Terminals({ log: () => undefined, ...as });
  const info = terminals.info();
  if (!info.available) {
    console.log(`FAIL terminal: ${info.reason}`);
    return false;
  }
  const decoder = new TextDecoder();
  let output = "";
  let firstAt = 0;
  const peer: { on?: DataListener; closed?: () => void } = {};
  const closed = new Promise<void>((resolve) => {
    peer.closed = resolve;
  });
  // The data socket's place, here on the computer: the shell's bytes come to this check.
  const local: DataSocket = {
    bufferedAmount: 0,
    send: (data) => {
      if (typeof data === "string") return;
      firstAt ||= performance.now();
      output += decoder.decode(data, { stream: true });
    },
    close: () => peer.closed?.(),
    listen: (on) => {
      peer.on = on;
    },
  };
  try {
    const t0 = performance.now();
    await terminals.open(agent, { cols: 80, rows: 24 }, async () => local);
    // Quoted apart, so the echo of the typed line never matches.
    peer.on?.bytes(new TextEncoder().encode('echo "CHECK""=$(id -un)=$(tput cols)=$PWD"; exit\n'));
    await Promise.race([closed, sleep(10_000)]);
    const m = /CHECK=([^=\r\n]+)=(\d+)=([^\r\n]*)/.exec(output);
    if (!m) throw new Error(`no answer from the shell: ${JSON.stringify(output.slice(-300))}`);
    console.log(
      `ok   terminal: a shell as ${m[1]} in ${m[3]}, ${m[2]} columns, first output in ${Math.round(firstAt - t0)} ms`,
    );
    return true;
  } catch (err) {
    console.log(`FAIL terminal: ${errorText(err)}`);
    return false;
  } finally {
    terminals.closeAll();
  }
}

async function main(argv: string[]): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  // One home per organization (the desktop app passes its own); child processes inherit it.
  const home = flagString(p, "home");
  if (home) process.env.AGENTES_RUNNER_HOME = expandHome(home);
  const [command, sub] = p.positional;
  if (p.flags.has("version")) {
    console.log(RUNNER_VERSION);
    return 0;
  }
  if (p.flags.has("help") || !command || command === "help") {
    console.log(HELP);
    return command || p.flags.has("help") ? 0 : 1;
  }
  switch (command) {
    case "pair":
      return pair(p);
    case "start":
      return start();
    case "app":
      return app();
    case "status":
      return status();
    case "folders":
      return folders(p);
    case "tools":
      return tools(p);
    case "desktop-check":
      return desktopCheck(p);
    case "mcp": {
      // `--task <taskId>`: a mission task's or a Claude Code brain process's server.
      // `--run <runId>`: a Codex brain turn's (its token only in the env).
      const runId = flagString(p, "run");
      const taskId = runId ?? flagString(p, "task");
      if (!taskId || !/^[a-zA-Z0-9-]{8,64}$/.test(taskId)) {
        console.error("Usage: agentes-runner mcp --task <taskId> | --run <runId>");
        return 1;
      }
      return runMcpServer({
        taskId,
        socketPath: process.env.AGENTES_MCP_SOCKET || mcpSocketPath(runnerHome()),
        token: process.env.AGENTES_MCP_TOKEN || null,
        ...(runId ? {} : { tokenFile: path.join(runnerHome(), "tasks", taskId, MCP_TOKEN_FILE) }),
      });
    }
    case "worker":
      return worker(p);
    case "task-wrapper": {
      // A compiled runner's background task wrapper (tasks.ts); it exits on its own when the task ends.
      if (!sub) return 1;
      runTaskWrapper(path.resolve(sub));
      return new Promise<number>(() => {});
    }
    case "update":
      return update();
    case "service": {
      const stored = storedOrNull();
      const system = p.flags.has("system") || stored?.mode === "system";
      if (sub === "install") {
        if (stored?.managedBy === "desktop") {
          console.error(DESKTOP_MANAGED);
          return 1;
        }
        if (!system) return installService({ print: (l) => console.log(l) });
        const range = flagString(p, "agent-uid-range");
        const agentUidRange = range === undefined ? undefined : parseUidRange(range);
        if (agentUidRange === null) {
          console.error(
            "--agent-uid-range takes two uids between 1000 and 59999, the first not above the second, like 20000-29999",
          );
          return 1;
        }
        return installSystemService({
          print: (l) => console.log(l),
          start: !p.flags.has("no-start"),
          ...(agentUidRange ? { agentUidRange } : {}),
        });
      }
      if (sub === "uninstall") return uninstallService({ print: (l) => console.log(l), system });
      console.error("Usage: agentes-runner service install|uninstall");
      return 1;
    }
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      return 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(`(home: ${runnerHome()})`);
    process.exit(1);
  },
);
