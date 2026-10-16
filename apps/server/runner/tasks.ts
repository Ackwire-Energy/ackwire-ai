import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import type { EventEmitter } from "node:events";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type AgentScope,
  type MachineReplies,
  type RunnerFrame,
  type RunnerTask,
  TASK_LIMITS,
  type TaskDone,
  type TaskExecutor,
  type TaskStart,
} from "@agenteschat/adapters/machine-protocol";
import { RunnerError } from "./errors";
import { shellCommand } from "./exec";
import { isInside, resolveInWorkspace } from "./paths";

/**
 * Background tasks (protocol 4, ADR 0029): commands that outlive a request,
 * the socket and the runner itself.
 *
 * - Each task runs under a tiny wrapper (`wrap.mjs`, plain JavaScript run by
 *   this same runtime) started detached in its own process group and
 *   `unref()`ed, so restarting the runner (an update, a crash) leaves it
 *   running. The wrapper starts the command with stdout/stderr going to
 *   `<runner home>/tasks/<taskId>/stdout.log` and `stderr.log`, touches
 *   `alive` every 15 s, enforces `maxSeconds`, stops on `cancel` (a file, so
 *   it works on Windows too, or SIGTERM), and writes `exit.json` (atomically)
 *   when the command ends. A pid alone can't tell "still running" after a
 *   reboot (pids are reused); a fresh `alive` can.
 * - The journal `<runner home>/tasks/journal.json` (written whole, then
 *   renamed) lists every task with its state; `hello` carries it.
 * - A watcher tails the logs: Claude Code's `stream-json` lines become a
 *   human last line and the files it edits; other executors send their last
 *   plain lines. Events are throttled and secrets redacted (ADR 0027).
 * - `task.done` goes once per task and again after each reconnect until the
 *   server acknowledges it (`task.ack`).
 */

export const DEFAULT_MAX_CONCURRENT_TASKS = 3;
export const DEFAULT_TASK_MAX_SECONDS = 4 * 3600;
/** Hard cap on `maxSeconds` (a day). */
export const TASK_MAX_SECONDS_CAP = 24 * 3600;
/** `alive` is touched this often by the wrapper; older than `ALIVE_STALE_MS` means the wrapper is gone. */
export const ALIVE_EVERY_MS = 15_000;
export const ALIVE_STALE_MS = 60_000;
/** Finished, acknowledged tasks (and their logs) are kept this long. */
export const TASK_KEEP_MS = 7 * 24 * 3600_000;
/** The watcher reads the logs this often. */
export const WATCH_MS = 1000;
/** At most one `line` event per task this often; a `progress` heartbeat when nothing else was sent. */
export const EVENT_EVERY_MS = 2000;
export const PROGRESS_EVERY_MS = 30_000;
/** What `task.done` keeps of a plain command's output. */
const TAIL_LINES = 20;
const MAX_LINE_BUFFER = 1024 * 1024;
const CANCEL_GRACE_MS = 10_000;
const TASK_ID = /^[a-zA-Z0-9-]{8,64}$/;
const SESSION_ID = /^[a-zA-Z0-9-]{8,64}$/;

/** The text Claude Code gets when the server resumes a task interrupted by the machine going away. */
export const RESUME_NOTE =
  "You were interrupted (the computer went offline). Check git status in your folder and continue where you stopped.";

interface Entry {
  taskId: string;
  agentId: string;
  agentHandle: string;
  executor: TaskExecutor;
  /** What runs (shown in logs and to the server; prompts go through stdin, never here). */
  command: string;
  /** Absolute. */
  cwd: string;
  /** Relative to the agent's folder. */
  cwdRel: string;
  branch?: string;
  session?: string;
  status: RunnerTask["status"];
  pid?: number;
  startedAt: string;
  endedAt?: string;
  maxSeconds: number;
  lastLine?: string;
  files: string[];
  /** Set by `task.cancel` (a canceled task that vanished is canceled, not interrupted). */
  canceling?: boolean;
  done?: TaskDone;
  /** The server acknowledged `done`. */
  delivered?: boolean;
}

interface Journal {
  tasks: Entry[];
}

interface ExitFile {
  exitCode: number | null;
  signal: string | null;
  reason: "canceled" | "timeout" | null;
  endedAt: string;
  error?: string;
}

export interface TaskSecrets {
  env: Record<string, string>;
  redact: (text: string) => string;
}

export interface TaskManagerOptions {
  /** `<runner home>/tasks`. */
  root: string;
  workspaceReal: string;
  maxConcurrent?: number;
  defaultMaxSeconds?: number;
  log?: (line: string) => void;
  /** The agent's folder (real path); `handlers.ts` passes `agentWorkspace`. */
  agentFolder: (agent: AgentScope) => Promise<string>;
  /** The agent's secrets: env for the command, redaction for what leaves the machine. */
  secrets?: (agent: AgentScope) => Promise<TaskSecrets | null>;
  /** Tests: shorter intervals. */
  watchMs?: number;
  eventEveryMs?: number;
  /** Tests: the runtime that runs the wrapper (default: this one). */
  runtime?: string;
  /** Tests: where Claude Code keeps its sessions (default `$CLAUDE_CONFIG_DIR` or `~/.claude`). */
  claudeHome?: string;
  /** macOS: keep the machine awake while tasks run (default on darwin). */
  caffeinate?: boolean;
  now?: () => number;
}

/** The wrapper every task runs under (written next to the journal; plain JS for Node and Bun). */
export const WRAPPER_SOURCE = `// agentes-runner task wrapper: runs one task and records how it ended.
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, renameSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
const dir = process.argv[2];
const spec = JSON.parse(readFileSync(path.join(dir, "spec.json"), "utf8"));
const file = (n) => path.join(dir, n);
let reason = null;
let ended = false;
const finish = (data) => {
  if (ended) return;
  ended = true;
  const tmp = file("exit.json.tmp");
  writeFileSync(tmp, JSON.stringify({ ...data, reason, endedAt: new Date().toISOString() }));
  renameSync(tmp, file("exit.json"));
  process.exit(0);
};
const touch = () => {
  const now = new Date();
  try { utimesSync(file("alive"), now, now); } catch { try { writeFileSync(file("alive"), ""); } catch {} }
};
touch();
const beat = setInterval(touch, ${ALIVE_EVERY_MS});
const out = openSync(file("stdout.log"), "a");
const err = openSync(file("stderr.log"), "a");
const input = existsSync(file("stdin.txt")) ? openSync(file("stdin.txt"), "r") : "ignore";
let child;
try {
  child = spawn(spec.file, spec.args, {
    cwd: spec.cwd,
    env: process.env,
    stdio: [input, out, err],
    detached: process.platform !== "win32",
    windowsHide: true,
    windowsVerbatimArguments: spec.verbatim,
  });
} catch (e) {
  finish({ exitCode: 127, signal: null, error: String(e && e.message || e) });
}
writeFileSync(file("child.pid"), String(child.pid ?? ""));
const kill = (signal) => {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {}); } catch {}
    return;
  }
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
};
const stop = (why) => {
  if (reason) return;
  reason = why;
  kill("SIGTERM");
  setTimeout(() => kill("SIGKILL"), 5000).unref();
};
process.on("SIGTERM", () => stop("canceled"));
process.on("SIGINT", () => stop("canceled"));
process.on("SIGHUP", () => {});
if (spec.maxSeconds > 0) setTimeout(() => stop("timeout"), spec.maxSeconds * 1000).unref();
const poll = setInterval(() => { if (existsSync(file("cancel"))) stop("canceled"); }, 1000);
child.on("error", (e) => { clearInterval(beat); clearInterval(poll); finish({ exitCode: 127, signal: null, error: String(e && e.message || e) }); });
// A command stopped by us ends by our signal even when its shell reports none (or exits with 143).
child.on("exit", (code, signal) => { clearInterval(beat); clearInterval(poll); finish(reason && (signal || code === null || code === 143) ? { exitCode: null, signal: signal ?? "SIGTERM" } : { exitCode: code, signal: signal ?? null }); });
`;

const clampInt = (n: unknown, min: number, max: number, fallback: number) => {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.max(min, Math.min(max, v));
};

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it just isn't ours.
    return (err as { code?: string }).code === "EPERM";
  }
}

/** Claude Code keeps a session per folder: `<claude home>/projects/<cwd with every non-alphanumeric as ->/<id>.jsonl`. */
export function claudeSessionFile(claudeHome: string, cwd: string, session: string) {
  return path.join(claudeHome, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${session}.jsonl`);
}

/**
 * The command line for an executor. Prompts never go on it (no quoting
 * across shells): the wrapper feeds them through stdin.
 */
export function executorCommand(
  executor: TaskExecutor,
  options: { command?: string; session?: string; resume?: boolean },
): string {
  if (executor === "shell") {
    const command = (options.command ?? "").trim();
    if (!command) throw new RunnerError("bad_request", "A shell task needs a command");
    return command;
  }
  if (executor === "codex") return "codex exec --json --full-auto -";
  const parts = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"];
  if (options.session) parts.push(options.resume ? "--resume" : "--session-id", options.session);
  return parts.join(" ");
}

/** A short human line for one Claude Code tool call ("Editing src/app.ts"). */
function toolLine(name: string, input: Record<string, unknown>, rel: (p: string) => string): string {
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
  switch (name) {
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return `${name === "Write" ? "Writing" : "Editing"} ${rel(str("file_path") || str("notebook_path"))}`;
    case "Read":
      return `Reading ${rel(str("file_path"))}`;
    case "Bash":
      return `Running: ${str("command").replace(/\s+/g, " ").trim()}`;
    case "Grep":
    case "Glob":
      return `Searching ${str("pattern")}`;
    case "Task":
      return `Subtask: ${str("description")}`;
    case "TodoWrite":
      return "Updating its plan";
    case "WebFetch":
    case "WebSearch":
      return `${name === "WebFetch" ? "Fetching" : "Searching the web for"} ${str("url") || str("query")}`;
    default:
      return `Using ${name}`;
  }
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** What one line of output says: a human line, files touched, the final result, the session. */
export interface ParsedLine {
  line?: string;
  files?: string[];
  result?: string;
  session?: string;
}

/** Claude Code `stream-json` (and Codex `--json`, best effort); plain text otherwise. */
export function parseOutputLine(raw: string, executor: TaskExecutor, cwd: string): ParsedLine {
  const text = raw.trim();
  if (!text) return {};
  const rel = (p: string) => {
    if (!p) return "";
    const abs = path.resolve(cwd, p);
    return isInside(cwd, abs) ? path.relative(cwd, abs).split(path.sep).join("/") : p;
  };
  const first = (s: string) => s.trim().split("\n")[0]?.trim() ?? "";
  if (executor !== "shell" && text.startsWith("{")) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { line: text };
    }
    if (executor === "claude") {
      const session = typeof ev.session_id === "string" ? ev.session_id : undefined;
      if (ev.type === "result") {
        const result = typeof ev.result === "string" ? ev.result : "";
        return { result, session, ...(result ? { line: first(result) } : {}) };
      }
      if (ev.type === "assistant") {
        const content = (ev.message as { content?: unknown } | undefined)?.content;
        const out: ParsedLine = { session };
        const files: string[] = [];
        if (Array.isArray(content)) {
          for (const block of content as Record<string, unknown>[]) {
            if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
              out.line = first(block.text);
            } else if (block.type === "tool_use" && typeof block.name === "string") {
              const input = (block.input ?? {}) as Record<string, unknown>;
              out.line = toolLine(block.name, input, rel);
              const p = input.file_path ?? input.notebook_path;
              if (EDIT_TOOLS.has(block.name) && typeof p === "string" && p) files.push(rel(p));
            }
          }
        }
        if (files.length) out.files = files;
        return out;
      }
      return session ? { session } : {};
    }
    // Codex: messages and file changes, whatever the exact event shape.
    const item = (ev.item ?? ev.msg ?? ev) as Record<string, unknown>;
    const message = typeof item.text === "string" ? item.text : typeof item.message === "string" ? item.message : "";
    const changes = Array.isArray(item.changes)
      ? (item.changes as { path?: unknown }[]).flatMap((c) => (typeof c.path === "string" ? [rel(c.path)] : []))
      : [];
    const command = typeof item.command === "string" ? `Running: ${item.command}` : "";
    const out: ParsedLine = {};
    if (message) out.line = first(message);
    else if (command) out.line = command;
    if (changes.length) out.files = changes;
    if (item.type === "agent_message" && message) out.result = message;
    return out;
  }
  return { line: text };
}

/** Reads what a log grew since `offset` (at most 1 MB per call). */
function readFrom(file: string, offset: number): { text: string; next: number } {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    if (size <= offset) return { text: "", next: size < offset ? 0 : offset };
    const length = Math.min(size - offset, 1024 * 1024);
    const buf = Buffer.alloc(length);
    fd = openSync(file, "r");
    const n = readSync(fd, buf, 0, length, offset);
    return { text: buf.subarray(0, n).toString("utf8"), next: offset + n };
  } catch {
    return { text: "", next: offset };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Written whole, then renamed: a crash never leaves half a file. */
function writeJson(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, file);
}

interface Watch {
  timer: ReturnType<typeof setInterval>;
  offsets: { stdout: number; stderr: number };
  partial: { stdout: string; stderr: string };
  tail: string[];
  result?: string;
  lastSentLine?: string;
  lastSentAt: number;
  pendingLine?: string;
  newFiles: string[];
  redact: (text: string) => string;
  missingSince?: number;
  cancelAt?: number;
}

export class TaskManager {
  private journal: Journal = { tasks: [] };
  private readonly watches = new Map<string, Watch>();
  private send: ((frame: RunnerFrame) => void) | null = null;
  private caffeinate: ChildProcess | null = null;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private closed = false;

  constructor(private readonly opts: TaskManagerOptions) {
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  get journalFile() {
    return path.join(this.opts.root, "journal.json");
  }

  private dirOf(taskId: string) {
    if (!TASK_ID.test(taskId)) throw new RunnerError("bad_request", "Invalid task id");
    return path.join(this.opts.root, taskId);
  }

  private save() {
    mkdirSync(this.opts.root, { recursive: true, mode: 0o700 });
    writeJson(this.journalFile, this.journal);
  }

  /** Loads the journal and picks up where the last runner stopped: running tasks are watched again, finished ones reported. */
  async init() {
    mkdirSync(this.opts.root, { recursive: true, mode: 0o700 });
    const loaded = readJson<Journal>(this.journalFile);
    this.journal = { tasks: Array.isArray(loaded?.tasks) ? loaded.tasks.filter((t) => TASK_ID.test(t.taskId)) : [] };
    // Forget what the server has had for a week (and its logs).
    const cutoff = this.now() - TASK_KEEP_MS;
    for (const t of [...this.journal.tasks]) {
      if (t.status !== "running" && t.delivered && t.endedAt && Date.parse(t.endedAt) < cutoff) {
        rmSync(this.dirOf(t.taskId), { recursive: true, force: true });
        this.journal.tasks = this.journal.tasks.filter((x) => x !== t);
      }
    }
    for (const t of this.journal.tasks) {
      if (t.status === "running") await this.watch(t, true);
    }
    this.save();
    this.updateCaffeinate();
  }

  /** For `hello`: every task the server may not know the end of. */
  list(): RunnerTask[] {
    return this.journal.tasks.filter((t) => t.status === "running" || !t.delivered).map((t) => this.info(t));
  }

  private info(t: Entry): RunnerTask {
    const seconds = Math.max(
      0,
      Math.round(((t.endedAt ? Date.parse(t.endedAt) : this.now()) - Date.parse(t.startedAt)) / 1000),
    );
    return {
      taskId: t.taskId,
      agentId: t.agentId,
      status: t.status,
      ...(t.pid ? { pid: t.pid } : {}),
      startedAt: t.startedAt,
      ...(t.endedAt ? { endedAt: t.endedAt } : {}),
      ...(t.done ? { exitCode: t.done.exitCode, signal: t.done.signal ?? null } : {}),
      seconds,
      ...(t.lastLine ? { lastLine: t.lastLine } : {}),
      ...(t.files.length ? { files: t.files.slice(0, TASK_LIMITS.files) } : {}),
    };
  }

  /** A new connection: frames go there, and every `task.done` the server hasn't acknowledged goes again. */
  attach(send: (frame: RunnerFrame) => void) {
    this.send = send;
    for (const t of this.journal.tasks) {
      if (t.done && !t.delivered) this.emit({ type: "task.done", ...t.done });
    }
  }

  detach() {
    this.send = null;
  }

  private emit(frame: RunnerFrame) {
    if (!this.send) return;
    try {
      this.send(frame);
    } catch {
      // the socket went away; `task.done` goes again after the reconnect
    }
  }

  /** The server stored this task's end. */
  ack(taskId: string) {
    const t = this.journal.tasks.find((x) => x.taskId === taskId);
    if (!t || t.delivered) return;
    t.delivered = true;
    this.save();
  }

  get running() {
    return this.journal.tasks.filter((t) => t.status === "running").length;
  }

  async start(agent: AgentScope, req: TaskStart): Promise<MachineReplies["task.start"]> {
    if (this.closed) throw new RunnerError("internal", "The runner is stopping");
    const taskId = String(req.taskId ?? "");
    const dir = this.dirOf(taskId);
    if (this.journal.tasks.some((t) => t.taskId === taskId)) throw new RunnerError("bad_request", "Duplicate task id");
    const max = this.opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_TASKS;
    if (this.running >= max) {
      throw new RunnerError(
        "no_slot",
        `This computer already runs ${max} background tasks (its limit); wait for one to finish or cancel one`,
      );
    }
    const executor: TaskExecutor = req.executor === "claude" || req.executor === "codex" ? req.executor : "shell";
    const session = typeof req.session === "string" && SESSION_ID.test(req.session) ? req.session : undefined;
    const prompt = typeof req.prompt === "string" ? req.prompt : "";
    if (executor !== "shell" && !prompt.trim())
      throw new RunnerError("bad_request", `A ${executor} task needs a prompt`);
    const folder = await this.opts.agentFolder(agent);
    let cwd = folder;
    if (typeof req.cwd === "string" && req.cwd.trim() !== "") {
      const resolved = await resolveInWorkspace(folder, req.cwd);
      if (!resolved.exists) throw new RunnerError("not_found", `The folder ${req.cwd} doesn't exist`);
      if (!statSync(resolved.abs).isDirectory()) throw new RunnerError("bad_request", `${req.cwd} is not a folder`);
      cwd = resolved.abs;
    }
    let branch: string | undefined;
    if (typeof req.branch === "string" && req.branch.trim() !== "") {
      branch = req.branch.trim();
      cwd = createWorktree(cwd, folder, taskId, branch);
    }
    // Claude Code resumes a session that exists in this folder, else starts it with that id.
    let resume = req.resume === true;
    if (executor === "claude" && session) {
      const home = this.opts.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
      if (existsSync(path.join(home, "projects"))) resume = existsSync(claudeSessionFile(home, cwd, session));
    }
    const command = executorCommand(executor, { command: req.command, session, resume });
    const maxSeconds = clampInt(
      req.maxSeconds,
      1,
      TASK_MAX_SECONDS_CAP,
      this.opts.defaultMaxSeconds ?? DEFAULT_TASK_MAX_SECONDS,
    );
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const shell = shellCommand(command);
    writeJson(path.join(dir, "spec.json"), {
      file: shell.file,
      args: shell.args,
      verbatim: shell.verbatim,
      cwd,
      maxSeconds,
    });
    if (executor !== "shell") writeFileSync(path.join(dir, "stdin.txt"), prompt, { mode: 0o600 });
    const wrapper = path.join(this.opts.root, "wrap.mjs");
    writeFileSync(wrapper, WRAPPER_SOURCE, { mode: 0o600 });
    const secrets = (await this.opts.secrets?.(agent)) ?? null;
    let child: ChildProcess;
    try {
      child = spawn(this.opts.runtime ?? process.execPath, [wrapper, dir], {
        cwd: dir,
        // The agent's secrets (ADR 0027) through the environment only, never on disk here.
        env: secrets ? { ...process.env, ...secrets.env } : process.env,
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
    } catch (err) {
      throw new RunnerError("internal", `Couldn't start the task: ${err instanceof Error ? err.message : String(err)}`);
    }
    (child as unknown as EventEmitter).on("error", () => {});
    child.unref();
    const pid = child.pid;
    if (!pid) throw new RunnerError("internal", "Couldn't start the task");
    const rel = path.relative(folder, cwd).split(path.sep).join("/");
    const entry: Entry = {
      taskId,
      agentId: String(agent.id),
      agentHandle: String(agent.handle ?? ""),
      executor,
      command,
      cwd,
      cwdRel: rel,
      ...(branch ? { branch } : {}),
      ...(session ? { session } : {}),
      status: "running",
      pid,
      startedAt: new Date(this.now()).toISOString(),
      maxSeconds,
      files: [],
    };
    this.journal.tasks.push(entry);
    this.save();
    await this.watch(entry, false, secrets?.redact);
    this.updateCaffeinate();
    this.log(`[${entry.agentHandle}] task ${taskId} started: ${command.slice(0, 80)}`);
    return { taskId, pid, startedAt: entry.startedAt, cwd: rel, ...(branch ? { branch } : {}), command };
  }

  status(agent: AgentScope | undefined, taskId?: string): MachineReplies["task.status"] {
    const mine = this.journal.tasks.filter((t) => !agent || t.agentId === agent.id);
    return { tasks: (taskId ? mine.filter((t) => t.taskId === taskId) : mine).map((t) => this.info(t)) };
  }

  cancel(agent: AgentScope | undefined, taskId: string): MachineReplies["task.cancel"] {
    const t = this.journal.tasks.find((x) => x.taskId === taskId && (!agent || x.agentId === agent.id));
    if (!t) throw new RunnerError("not_found", "No such task on this computer");
    if (t.status !== "running") return { canceled: false };
    t.canceling = true;
    this.save();
    const dir = this.dirOf(t.taskId);
    // The wrapper polls this file every second. No SIGTERM to it right away: a wrapper that is still
    // starting has no handler yet and would die without stopping the command or writing `exit.json`.
    // One that ignores the file is killed after the grace (`hardKill`).
    try {
      writeFileSync(path.join(dir, "cancel"), "");
    } catch {}
    const w = this.watches.get(t.taskId);
    if (w) w.cancelAt = this.now();
    return { canceled: true };
  }

  private async watch(t: Entry, resumed: boolean, redact?: (text: string) => string) {
    const dir = this.dirOf(t.taskId);
    const size = (f: string) => {
      try {
        return statSync(path.join(dir, f)).size;
      } catch {
        return 0;
      }
    };
    // After a runner restart only the recent output matters (the last line, the tail).
    const start = (f: string) => (resumed ? Math.max(0, size(f) - 64 * 1024) : 0);
    const clean =
      redact ??
      (await this.opts.secrets?.({ id: t.agentId, handle: t.agentHandle }).catch(() => null))?.redact ??
      ((s: string) => s);
    const w: Watch = {
      timer: setInterval(() => this.tick(t), this.opts.watchMs ?? WATCH_MS),
      offsets: { stdout: start("stdout.log"), stderr: start("stderr.log") },
      partial: { stdout: "", stderr: "" },
      tail: [],
      lastSentAt: 0,
      newFiles: [],
      redact: clean,
    };
    w.timer.unref?.();
    this.watches.set(t.taskId, w);
  }

  /** One look at a running task: new output, then whether it ended. */
  private tick(t: Entry) {
    const w = this.watches.get(t.taskId);
    if (!w || t.status !== "running") return;
    const dir = this.dirOf(t.taskId);
    this.readOutput(t, w, dir);
    const exit = readJson<ExitFile>(path.join(dir, "exit.json"));
    if (exit) return this.finish(t, w, exit);
    const now = this.now();
    let aliveAt = 0;
    try {
      aliveAt = statSync(path.join(dir, "alive")).mtimeMs;
    } catch {}
    const startedAt = Date.parse(t.startedAt);
    // The wrapper writes `alive` as it starts; give it a moment before judging.
    const gone = !pidAlive(t.pid) || (now - startedAt > ALIVE_STALE_MS && now - aliveAt > ALIVE_STALE_MS);
    if (gone) {
      // Wait one more look: `exit.json` may be landing right now.
      if (w.missingSince === undefined) {
        w.missingSince = now;
        return;
      }
      return this.finish(t, w, null);
    }
    w.missingSince = undefined;
    // The wrapper ignores a cancel (or is stuck): kill the command's group and the wrapper.
    if (w.cancelAt !== undefined && now - w.cancelAt > CANCEL_GRACE_MS) this.hardKill(t, dir);
    // Backstop for the wrapper's own limit.
    if (now - startedAt > (t.maxSeconds + 60) * 1000) {
      try {
        writeFileSync(path.join(dir, "cancel"), "");
      } catch {}
      if (w.cancelAt === undefined) w.cancelAt = now;
    }
    this.flushEvents(t, w, false);
  }

  private hardKill(t: Entry, dir: string) {
    let childPid: number | undefined;
    try {
      childPid = Number(readFileSync(path.join(dir, "child.pid"), "utf8").trim()) || undefined;
    } catch {
      // the wrapper never got that far
    }
    if (process.platform === "win32") {
      for (const pid of [childPid, t.pid]) {
        if (!pid) continue;
        try {
          spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } catch {}
      }
      return;
    }
    for (const pid of [childPid ? -childPid : undefined, t.pid]) {
      if (!pid) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }

  private readOutput(t: Entry, w: Watch, dir: string) {
    for (const stream of ["stdout", "stderr"] as const) {
      const { text, next } = readFrom(path.join(dir, `${stream}.log`), w.offsets[stream]);
      w.offsets[stream] = next;
      if (!text) continue;
      let buf = w.partial[stream] + text;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      w.partial[stream] = buf.length > MAX_LINE_BUFFER ? "" : buf;
      for (const raw of lines) this.onLine(t, w, raw, stream);
    }
  }

  private onLine(t: Entry, w: Watch, raw: string, stream: "stdout" | "stderr") {
    // Claude Code's events are on stdout; its stderr (and every other executor's output) is plain text.
    const parsed = parseOutputLine(raw, stream === "stdout" ? t.executor : "shell", t.cwd);
    if (parsed.session && !t.session) t.session = parsed.session;
    if (parsed.result !== undefined) w.result = parsed.result;
    if (parsed.line) {
      const line = w.redact(parsed.line).slice(0, TASK_LIMITS.line);
      w.pendingLine = line;
      t.lastLine = line;
      w.tail.push(line);
      if (w.tail.length > TAIL_LINES) w.tail.shift();
    }
    for (const f of parsed.files ?? []) {
      if (!f || t.files.includes(f) || t.files.length >= TASK_LIMITS.files) continue;
      t.files.push(f);
      w.newFiles.push(f);
    }
  }

  private flushEvents(t: Entry, w: Watch, final: boolean) {
    const now = this.now();
    const seconds = Math.round((now - Date.parse(t.startedAt)) / 1000);
    if (w.newFiles.length > 0) {
      this.emit({ type: "task.event", taskId: t.taskId, kind: "files", files: [...t.files] });
      w.newFiles = [];
      this.save();
    }
    if (final) return;
    if (
      w.pendingLine !== undefined &&
      w.pendingLine !== w.lastSentLine &&
      now - w.lastSentAt >= (this.opts.eventEveryMs ?? EVENT_EVERY_MS)
    ) {
      this.emit({ type: "task.event", taskId: t.taskId, kind: "line", line: w.pendingLine, seconds });
      w.lastSentLine = w.pendingLine;
      w.pendingLine = undefined;
      w.lastSentAt = now;
    } else if (now - w.lastSentAt >= PROGRESS_EVERY_MS) {
      this.emit({ type: "task.event", taskId: t.taskId, kind: "progress", seconds });
      w.lastSentAt = now;
    }
  }

  private finish(t: Entry, w: Watch, exit: ExitFile | null) {
    clearInterval(w.timer);
    this.readOutput(t, w, this.dirOf(t.taskId));
    for (const stream of ["stdout", "stderr"] as const) {
      if (w.partial[stream]) this.onLine(t, w, w.partial[stream], stream);
      w.partial[stream] = "";
    }
    this.flushEvents(t, w, true);
    this.watches.delete(t.taskId);
    const endedAt = exit?.endedAt ?? new Date(this.now()).toISOString();
    const seconds = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(t.startedAt)) / 1000));
    const canceled = exit ? exit.reason === "canceled" : t.canceling === true;
    const interrupted = !exit && !t.canceling;
    // Canceled and the wrapper gone without an exit: make sure nothing of the command is left.
    if (!exit && t.canceling) this.hardKill(t, this.dirOf(t.taskId));
    const result = w.redact(w.result ?? w.tail.join("\n")).slice(0, TASK_LIMITS.result);
    t.status = interrupted ? "interrupted" : "done";
    t.endedAt = endedAt;
    t.done = {
      taskId: t.taskId,
      exitCode: exit ? exit.exitCode : null,
      signal: exit?.signal ?? (canceled && !exit ? "SIGTERM" : null),
      seconds,
      ...(result ? { result } : {}),
      ...(t.lastLine ? { lastLine: t.lastLine } : {}),
      ...(t.files.length ? { files: t.files.slice(0, TASK_LIMITS.files) } : {}),
      ...(canceled ? { canceled: true } : {}),
      ...(exit?.reason === "timeout" ? { timedOut: true } : {}),
      ...(interrupted ? { interrupted: true } : {}),
      ...(t.session ? { session: t.session } : {}),
    };
    t.delivered = false;
    this.save();
    this.updateCaffeinate();
    this.log(
      `[${t.agentHandle}] task ${t.taskId} ${interrupted ? "was interrupted" : canceled ? "was canceled" : `ended (exit ${exit?.exitCode ?? "?"})`}`,
    );
    this.emit({ type: "task.done", ...t.done });
  }

  /** macOS: hold off idle sleep while any task runs (released when the runner exits, `-w`). */
  private updateCaffeinate() {
    const enabled = this.opts.caffeinate ?? process.platform === "darwin";
    if (!enabled) return;
    if (this.running > 0 && !this.caffeinate && !this.closed) {
      try {
        const child = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
        (child as unknown as EventEmitter).on("error", () => {
          this.caffeinate = null;
        });
        (child as unknown as EventEmitter).on("exit", () => {
          if (this.caffeinate === child) this.caffeinate = null;
        });
        child.unref();
        this.caffeinate = child;
      } catch {
        this.caffeinate = null;
      }
    } else if (this.running === 0 && this.caffeinate) {
      try {
        this.caffeinate.kill();
      } catch {}
      this.caffeinate = null;
    }
  }

  /** Whether macOS sleep is held right now (tests). */
  get holdingSleep() {
    return this.caffeinate !== null;
  }

  /** The runner is exiting: stop watching; the tasks themselves go on. */
  close() {
    this.closed = true;
    for (const w of this.watches.values()) clearInterval(w.timer);
    this.watches.clear();
    if (this.caffeinate) {
      try {
        this.caffeinate.kill();
      } catch {}
      this.caffeinate = null;
    }
    this.send = null;
  }
}

/** A branch name git accepts, or a clear refusal. */
function checkBranch(cwd: string, branch: string) {
  if (branch.length > 200 || branch.startsWith("-"))
    throw new RunnerError("bad_request", `Invalid branch name ${branch}`);
  const r = spawnSync("git", ["check-ref-format", "--branch", branch], { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new RunnerError("bad_request", `Invalid branch name ${branch}`);
}

/**
 * `git worktree add -b <branch> <agent folder>/.worktrees/<taskId>` from the
 * repository at `cwd`; `.worktrees/` is excluded locally so it never shows as
 * untracked. Returns the new worktree's path.
 */
export function createWorktree(cwd: string, folder: string, taskId: string, branch: string): string {
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8", windowsHide: true });
  if (inside.error) throw new RunnerError("bad_request", "git is not installed on this computer");
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    throw new RunnerError("bad_request", "A branch needs a git repository: the task's folder isn't one");
  }
  checkBranch(cwd, branch);
  const target = path.join(folder, ".worktrees", taskId);
  mkdirSync(path.dirname(target), { recursive: true });
  const add = spawnSync("git", ["worktree", "add", "-b", branch, target], { cwd, encoding: "utf8", windowsHide: true });
  if (add.status !== 0) {
    throw new RunnerError("bad_request", `git worktree add failed: ${(add.stderr || add.stdout).trim().slice(0, 500)}`);
  }
  const gitDir = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8", windowsHide: true });
  if (gitDir.status === 0) {
    const exclude = path.join(path.resolve(cwd, gitDir.stdout.trim()), "info", "exclude");
    try {
      const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
      if (!current.split("\n").includes(".worktrees/")) {
        mkdirSync(path.dirname(exclude), { recursive: true });
        writeFileSync(exclude, `${current}${current && !current.endsWith("\n") ? "\n" : ""}.worktrees/\n`);
      }
    } catch {
      // only cosmetic
    }
  }
  return target;
}
