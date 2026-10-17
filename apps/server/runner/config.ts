import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** What `pair` writes and `start` reads (`~/.agentes-runner/config.json`, mode 600). */
export interface RunnerConfig {
  /** Our server, e.g. `https://agentes.chat` (no trailing slash). */
  server: string;
  machineId: string;
  name: string;
  /** The machine token (`agm_…`); never printed. */
  token: string;
  /** Absolute path of the workspace folder. */
  workspace: string;
  exec: boolean;
  /** Background tasks at once on this computer (default 3). */
  maxConcurrentTasks?: number;
  /** A background task is stopped after this many seconds (default 4 h). */
  taskMaxSeconds?: number;
  /** Brain turns (protocol 8): a Claude Code process with no turn this long is closed (default 10). */
  brainIdleMinutes?: number;
  /** Brain turns: at most this many Claude Code processes kept alive (default 3). */
  brainMaxProcesses?: number;
}

/** `AGENTES_RUNNER_HOME`, or `~/.agentes-runner`. */
export function runnerHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENTES_RUNNER_HOME?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".agentes-runner");
}

export function configPath(home = runnerHome()) {
  return path.join(home, "config.json");
}

/** Expands a leading `~` and makes the path absolute. */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

/** `https://host/` → `https://host`; refuses anything that isn't http(s). */
export function normalizeServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Not a valid server URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`The server URL must be http(s): ${raw}`);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** `https://host` → `wss://host/api/machines/connect`. */
export function connectUrl(server: string): string {
  const url = new URL(server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/machines/connect`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function readConfig(home = runnerHome()): RunnerConfig | null {
  const file = configPath(home);
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<RunnerConfig>;
  if (
    typeof raw.server !== "string" ||
    typeof raw.machineId !== "string" ||
    typeof raw.token !== "string" ||
    typeof raw.workspace !== "string"
  ) {
    throw new Error(`${file} is incomplete; pair this computer again`);
  }
  return {
    server: raw.server,
    machineId: raw.machineId,
    name: typeof raw.name === "string" ? raw.name : "",
    token: raw.token,
    workspace: raw.workspace,
    exec: raw.exec !== false,
    ...(positive(raw.maxConcurrentTasks) ? { maxConcurrentTasks: positive(raw.maxConcurrentTasks) } : {}),
    ...(positive(raw.taskMaxSeconds) ? { taskMaxSeconds: positive(raw.taskMaxSeconds) } : {}),
    ...(positive(raw.brainIdleMinutes) ? { brainIdleMinutes: positive(raw.brainIdleMinutes) } : {}),
    ...(positive(raw.brainMaxProcesses) ? { brainMaxProcesses: positive(raw.brainMaxProcesses) } : {}),
  };
}

const positive = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : undefined);

/** Writes the config with mode 600 (folder 700), atomically. */
export function writeConfig(config: RunnerConfig, home = runnerHome()) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    chmodSync(home, 0o700);
  } catch {
    // Windows: modes don't apply
  }
  const file = configPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows
  }
  renameSync(tmp, file);
}
