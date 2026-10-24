import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAccess, type RunnerAccess, type RunnerPause } from "@agenteschat/adapters/machine-protocol";

/** What `pair` writes and `start` reads (`~/.agentes-runner/config.json`, mode 600). */
export interface RunnerConfig {
  /** Our server, e.g. `https://agentes.chat` (no trailing slash). */
  server: string;
  machineId: string;
  name: string;
  /** The machine token (`agm_…`); never printed, never sent to the desktop app. */
  token: string;
  /** Absolute path of the workspace folder. */
  workspace: string;
  /** Commands on (kept equal to `access.tools.commands` once `access` exists). */
  exec: boolean;
  /** Background tasks at once on this computer (default 3). */
  maxConcurrentTasks?: number;
  /** A background task is stopped after this many seconds (default 4 h). */
  taskMaxSeconds?: number;
  /** Brain turns (protocol 8): a Claude Code process with no turn this long is closed (default 10). */
  brainIdleMinutes?: number;
  /** Brain turns: at most this many Claude Code processes kept alive (default 3). */
  brainMaxProcesses?: number;
  /** ADR 0036: a home the desktop app created; `update` and `service install` refuse here. */
  managedBy?: "desktop";
  /** Protocol 9: paused by the owner; `until` null means until resumed. Absent: not paused. */
  paused?: { until: string | null };
  /** Protocol 10: folders and tools allowed on this machine (absent: derived from `exec`). */
  access?: RunnerAccess;
  /** The organization this home belongs to (from the device-code pairing). */
  orgId?: string;
  orgName?: string;
}

/** The file as stored: a home that isn't paired (or was unpaired) keeps only some fields. */
export type StoredConfig = Partial<RunnerConfig>;

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

/** `https://host` → `wss://host/api/machines/connect` (or `/stream`, a desktop's or terminal's data socket). */
export function connectUrl(server: string, socket: "connect" | "stream" = "connect"): string {
  const url = new URL(server);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/machines/${socket}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

const positive = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : undefined);
const text = (v: unknown, max = 500) => (typeof v === "string" && v ? v.slice(0, max) : undefined);

function parsePaused(v: unknown): RunnerConfig["paused"] {
  if (typeof v !== "object" || v === null) return undefined;
  const until = (v as { until?: unknown }).until;
  if (typeof until === "string" && !Number.isNaN(Date.parse(until))) return { until: new Date(until).toISOString() };
  return { until: null };
}

/** The file's fields, checked one by one (unknown or malformed ones are dropped). Null when there is no file. */
export function readStoredConfig(home = runnerHome()): StoredConfig | null {
  const file = configPath(home);
  if (!existsSync(file)) return null;
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (typeof raw !== "object" || raw === null) throw new Error(`${file} is not a JSON object`);
  return normalizeStored(raw);
}

export function normalizeStored(raw: Record<string, unknown>): StoredConfig {
  const access = raw.access === undefined ? undefined : parseAccess(raw.access);
  const paused = parsePaused(raw.paused);
  return {
    ...(text(raw.server) ? { server: text(raw.server) } : {}),
    ...(text(raw.machineId) ? { machineId: text(raw.machineId) } : {}),
    ...(typeof raw.name === "string" ? { name: raw.name.slice(0, 200) } : {}),
    ...(text(raw.token, 4000) ? { token: text(raw.token, 4000) } : {}),
    ...(text(raw.workspace, 4000) ? { workspace: text(raw.workspace, 4000) } : {}),
    ...(typeof raw.exec === "boolean" ? { exec: raw.exec } : {}),
    ...(positive(raw.maxConcurrentTasks) ? { maxConcurrentTasks: positive(raw.maxConcurrentTasks) } : {}),
    ...(positive(raw.taskMaxSeconds) ? { taskMaxSeconds: positive(raw.taskMaxSeconds) } : {}),
    ...(positive(raw.brainIdleMinutes) ? { brainIdleMinutes: positive(raw.brainIdleMinutes) } : {}),
    ...(positive(raw.brainMaxProcesses) ? { brainMaxProcesses: positive(raw.brainMaxProcesses) } : {}),
    ...(raw.managedBy === "desktop" ? { managedBy: "desktop" as const } : {}),
    ...(paused ? { paused } : {}),
    ...(access ? { access } : {}),
    ...(text(raw.orgId, 100) ? { orgId: text(raw.orgId, 100) } : {}),
    ...(text(raw.orgName, 200) ? { orgName: text(raw.orgName, 200) } : {}),
  };
}

/**
 * The paired config, or null when this home isn't paired (no file, or no
 * token: never paired from the app, or unpaired). Throws when a token is
 * there but the rest is missing.
 */
export function readConfig(home = runnerHome()): RunnerConfig | null {
  const stored = readStoredConfig(home);
  return stored ? pairedConfig(stored, configPath(home)) : null;
}

export function pairedConfig(stored: StoredConfig, file = "config.json"): RunnerConfig | null {
  if (!stored.token) return null;
  if (!stored.server || !stored.machineId || !stored.workspace) {
    throw new Error(`${file} is incomplete; pair this computer again`);
  }
  return {
    ...stored,
    server: stored.server,
    machineId: stored.machineId,
    name: stored.name ?? "",
    token: stored.token,
    workspace: stored.workspace,
    exec: stored.access ? stored.access.tools.commands : stored.exec !== false,
  };
}

/**
 * What the machine allows: the stored `access`, or for a home paired before
 * protocol 10 the old behaviour (commands, Claude Code and Codex follow `exec`).
 */
export function effectiveAccess(config: StoredConfig | null): RunnerAccess {
  if (config?.access) return config.access;
  const on = config ? config.exec !== false : false;
  return { folders: [], tools: { claude: on, codex: on, commands: on } };
}

/** The pause as the protocol says it (an `until` already past counts as not paused). */
export function pauseOf(config: StoredConfig | null, now = Date.now()): RunnerPause {
  const p = config?.paused;
  if (!p) return { paused: false };
  if (p.until && Date.parse(p.until) <= now) return { paused: false };
  return { paused: true, until: p.until };
}

/** What `writeConfig` writes, exactly (the watcher compares it to tell our own writes apart). */
export function serializeConfig(config: StoredConfig) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Writes the config with mode 600 (folder 700), atomically. Returns the written text. */
export function writeConfig(config: StoredConfig, home = runnerHome()): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    chmodSync(home, 0o700);
  } catch {
    // Windows: modes don't apply
  }
  const file = configPath(home);
  const tmp = `${file}.${process.pid}.tmp`;
  const data = serializeConfig(config);
  writeFileSync(tmp, data, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows
  }
  renameSync(tmp, file);
  return data;
}

/** Reads, changes and writes the stored config in one go. Returns the new config. */
export function updateConfig(mutate: (c: StoredConfig) => StoredConfig, home = runnerHome()): StoredConfig {
  const next = mutate(readStoredConfig(home) ?? {});
  writeConfig(next, home);
  return next;
}

export const CONFIG_DEBOUNCE_MS = 200;
export const CONFIG_POLL_MS = 2000;

/**
 * Calls `onChange(text)` when `config.json` changes (written by a terminal
 * command, the app, or a person's editor). Atomic writes replace the file,
 * so the folder is watched (by name), with a debounce, plus a slow poll of
 * the file's size and mtime where fs.watch misses events (network drives,
 * some Linux setups). `text` is null when the file went away. Returns a stop.
 */
export function watchConfig(
  home: string,
  onChange: (text: string | null) => void,
  opts: { debounceMs?: number; pollMs?: number } = {},
): () => void {
  const file = configPath(home);
  const stamp = () => {
    try {
      const st = statSync(file);
      return `${st.size}:${st.mtimeMs}:${st.ino}`;
    } catch {
      return "missing";
    }
  };
  let last = stamp();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const check = () => {
    timer = null;
    if (stopped) return;
    const now = stamp();
    if (now === last) return;
    last = now;
    let data: string | null = null;
    try {
      data = readFileSync(file, "utf8");
    } catch {
      data = null;
    }
    onChange(data);
  };
  const soon = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, opts.debounceMs ?? CONFIG_DEBOUNCE_MS);
    timer.unref?.();
  };
  let watcher: ReturnType<typeof watch> | null = null;
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    watcher = watch(home, { persistent: false }, (_event, name) => {
      if (!name || String(name) === "config.json") soon();
    });
    // A watcher that dies (the folder was removed) falls back to the poll below.
    (watcher as unknown as { on?: (event: "error", fn: () => void) => void }).on?.("error", () => {
      watcher?.close();
      watcher = null;
    });
  } catch {
    watcher = null;
  }
  const poll = setInterval(soon, opts.pollMs ?? CONFIG_POLL_MS);
  poll.unref?.();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    clearInterval(poll);
    watcher?.close();
  };
}
