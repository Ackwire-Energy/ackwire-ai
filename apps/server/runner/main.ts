/**
 * agentes-runner: connects this computer to an agentes.chat organization
 * (ADR 0025). Bundled to one file for Node.js 22+ and Bun:
 *   bun build apps/server/runner/main.ts --target=node --banner '#!/usr/bin/env node' --outfile apps/web/dist/runner/agentes-runner.mjs
 */
import { mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MACHINE_PROTOCOL_VERSION, type MachineOs, type RunnerInfo } from "@agenteschat/adapters/machine-protocol";
import { configPath, connectUrl, expandHome, normalizeServerUrl, readConfig, runnerHome, writeConfig } from "./config";
import { RunnerConnection } from "./connection";
import { RUNNER_VERSION } from "./errors";
import { MCP_TOKEN_FILE, McpBridge, mcpSocketPath, runMcpServer } from "./mcp";
import { agentWorkspace } from "./paths";
import { agentSecrets } from "./secrets";
import { installService, serviceStatus, uninstallService } from "./service";
import { TaskManager } from "./tasks";

const HELP = `agentes-runner ${RUNNER_VERSION}: connects this computer to agentes.chat

Usage:
  agentes-runner pair --server <url> --code <code> [--dir <workspace>] [--no-exec] [--name <name>]
      Trades a pairing code (Settings > Computers) for this computer's token.
      --dir      the folder agents work in (default ~/agentes)
      --no-exec  files and uploads only; agents can't run commands
  agentes-runner start
      Connects and stays connected (reconnects on its own).
  agentes-runner service install|uninstall
      Runs it in the background at login (systemd user unit, launchd agent, or Task Scheduler on Windows).
  agentes-runner update
      Downloads the latest runner from the server and restarts the service (keeps the pairing).
  agentes-runner status
  agentes-runner mcp --task <taskId>
      The agentes MCP server of a mission task (started by Claude Code or Codex, not by people).
  agentes-runner --help | --version

Config: $AGENTES_RUNNER_HOME or ~/.agentes-runner (config.json, mode 600; optional
"maxConcurrentTasks" (default 3) and "taskMaxSeconds" (default 14400) for background tasks).
Background tasks keep running when the runner restarts; their logs are in tasks/.
Commands run as the user that runs the runner; consider a dedicated OS user.`;

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

function machineOs(): MachineOs {
  switch (process.platform) {
    case "linux":
      return "linux";
    case "darwin":
      return "darwin";
    case "win32":
      return "windows";
    default:
      return "other";
  }
}

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["server", "code", "dir", "name", "task"]);

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "-h") flags.set("help", true);
    else if (arg === "-v") flags.set("version", true);
    else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
      if (eq > 0) flags.set(key, arg.slice(eq + 1));
      else if (VALUE_FLAGS.has(key)) {
        const value = argv[i + 1];
        if (value === undefined) throw new Error(`--${key} needs a value`);
        flags.set(key, value);
        i++;
      } else flags.set(key, true);
    } else positional.push(arg);
  }
  return { positional, flags };
}

const flagString = (p: Parsed, key: string) => {
  const v = p.flags.get(key);
  return typeof v === "string" ? v : undefined;
};

function prepareWorkspace(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

async function pair(p: Parsed): Promise<number> {
  const serverRaw = flagString(p, "server");
  const code = flagString(p, "code");
  if (!serverRaw || !code) {
    console.error(
      "Usage: agentes-runner pair --server <url> --code <code> [--dir <workspace>] [--no-exec] [--name <name>]",
    );
    return 1;
  }
  const server = normalizeServerUrl(serverRaw);
  // Created only once the pairing worked.
  const workspace = expandHome(flagString(p, "dir") ?? "~/agentes");
  const exec = !p.flags.has("no-exec");
  const name = flagString(p, "name");
  const body = {
    code,
    ...(name ? { name } : {}),
    hostname: os.hostname(),
    os: machineOs(),
    arch: os.arch(),
    version: RUNNER_VERSION,
    protocol: MACHINE_PROTOCOL_VERSION,
    workspace,
    exec,
  };
  let res: Response;
  try {
    res = await fetch(`${server}/api/machines/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    console.error(`Couldn't reach ${server}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  if (!res.ok) {
    const message = (json as { error?: { message?: unknown } } | null)?.error?.message;
    console.error(typeof message === "string" ? message : `Pairing failed (HTTP ${res.status})`);
    return 1;
  }
  const data = json as { machineId?: unknown; name?: unknown; token?: unknown } | null;
  if (!data || typeof data.machineId !== "string" || typeof data.token !== "string") {
    console.error("The server's answer to pairing was not understood");
    return 1;
  }
  const machineName = typeof data.name === "string" ? data.name : (name ?? os.hostname());
  const workspaceReal = prepareWorkspace(workspace);
  writeConfig({
    server,
    machineId: data.machineId,
    name: machineName,
    token: data.token,
    workspace: workspaceReal,
    exec,
  });
  console.log(`Paired as "${machineName}". Workspace: ${workspaceReal}${exec ? "" : " (commands off)"}`);
  console.log(`Config: ${configPath()}`);
  console.log("Next: agentes-runner start (or agentes-runner service install to run it in the background)");
  return 0;
}

async function start(): Promise<number> {
  const config = readConfig();
  if (!config) {
    console.error(
      `This computer isn't paired yet (${configPath()} not found). Run: agentes-runner pair --server <url> --code <code>`,
    );
    return 1;
  }
  if (typeof WebSocket === "undefined") {
    console.error(`This runtime has no WebSocket client (${process.version}); use Node.js 22 or newer, or Bun`);
    return 1;
  }
  const workspaceReal = prepareWorkspace(config.workspace);
  const info: RunnerInfo = {
    version: RUNNER_VERSION,
    protocol: MACHINE_PROTOCOL_VERSION,
    os: machineOs(),
    arch: os.arch(),
    hostname: os.hostname(),
    workspace: workspaceReal,
    exec: config.exec,
  };
  const secretsDir = path.join(runnerHome(), "secrets");
  const socketPath = mcpSocketPath(runnerHome());
  // How an executor starts our MCP server: this runtime running this very script.
  const script = realpathSync(process.argv[1] ?? "");
  // Background tasks outlive this process: their journal is picked up again here.
  const tasks = new TaskManager({
    mcp: { socketPath, command: [process.execPath, script] },
    root: path.join(runnerHome(), "tasks"),
    workspaceReal,
    maxConcurrent: config.maxConcurrentTasks,
    defaultMaxSeconds: config.taskMaxSeconds,
    log,
    agentFolder: (agent) => agentWorkspace(workspaceReal, agent),
    secrets: (agent) => agentSecrets(secretsDir, agent),
  });
  await tasks.init();
  // The local endpoint of mission tasks' MCP servers (protocol 5).
  const mcp = new McpBridge({ socketPath, task: (taskId) => tasks.mcpTask(taskId), log });
  await mcp
    .listen()
    .catch((err: unknown) => log(`mission tools unavailable: ${err instanceof Error ? err.message : String(err)}`));
  const connection = new RunnerConnection({
    mcp,
    url: connectUrl(config.server),
    token: config.token,
    info,
    context: { workspaceReal, exec: config.exec, token: config.token, secretsDir, tasks },
    log,
  });
  const stop = () => {
    tasks.close();
    void mcp.close();
    connection.stop();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  log(
    `agentes-runner ${RUNNER_VERSION}: connecting to ${config.server} (workspace ${workspaceReal}${config.exec ? "" : ", commands off"})`,
  );
  const outcome = await connection.run();
  switch (outcome.reason) {
    case "stopped":
      log("stopped");
      return 0;
    case "replaced":
      log(outcome.message);
      log("Another runner connected with this computer's token and took over; this one stops.");
      return 0;
    case "outdated":
      log(outcome.message);
      log("This runner is too old for the server. Update it: agentes-runner update");
      return serviceSafe(3);
    default:
      log(outcome.message);
      log("Pair this computer again: agentes-runner pair --server <url> --code <code>");
      return serviceSafe(2);
  }
}

/** Under launchd (KeepAlive unless it exits cleanly), a refusal exits 0 so it isn't restarted in a loop. */
function serviceSafe(code: number) {
  return process.env.AGENTES_RUNNER_SERVICE === "launchd" ? 0 : code;
}

/** Replaces this script with the server's latest bundle; the pairing and the workspace stay. */
async function update(): Promise<number> {
  const config = readConfig();
  if (!config) {
    console.error("Not paired yet: run the install command from Settings > Computers.");
    return 1;
  }
  const script = realpathSync(process.argv[1] ?? "");
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
  const config = readConfig();
  console.log(
    `agentes-runner ${RUNNER_VERSION} (protocol ${MACHINE_PROTOCOL_VERSION}) on ${process.release.name} ${process.version}`,
  );
  console.log(`Config: ${configPath()}`);
  if (!config) console.log("Not paired.");
  else {
    const { token: _token, ...visible } = config;
    console.log(JSON.stringify(visible, null, 2));
  }
  const service = serviceStatus();
  console.log(service ? `Service: ${service}` : "Service: not installed");
  return 0;
}

async function main(argv: string[]): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
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
    case "status":
      return status();
    case "mcp": {
      const taskId = flagString(p, "task");
      if (!taskId || !/^[a-zA-Z0-9-]{8,64}$/.test(taskId)) {
        console.error("Usage: agentes-runner mcp --task <taskId>");
        return 1;
      }
      return runMcpServer({
        taskId,
        socketPath: process.env.AGENTES_MCP_SOCKET || mcpSocketPath(runnerHome()),
        token: process.env.AGENTES_MCP_TOKEN || null,
        tokenFile: path.join(runnerHome(), "tasks", taskId, MCP_TOKEN_FILE),
      });
    }
    case "update":
      return update();
    case "service":
      if (sub === "install") return installService({ print: (l) => console.log(l) });
      if (sub === "uninstall") return uninstallService({ print: (l) => console.log(l) });
      console.error("Usage: agentes-runner service install|uninstall");
      return 1;
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
