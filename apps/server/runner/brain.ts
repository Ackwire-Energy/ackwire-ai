import { type ChildProcess, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  type AccountKind,
  type AgentScope,
  BRAIN_LIMITS,
  type BrainEffort,
  type BrainTurnRequest,
  isAccountId,
  isBrainEffort,
  isRunToolToken,
  PERMISSION_PROMPT_TOOL,
  PERMISSION_WAIT_MS,
  type WireBrainEvent,
} from "@agenteschat/adapters/machine-protocol";
import { ACCOUNT_MISSING_MESSAGE } from "./accounts";
import { RunnerError } from "./errors";
import { resolveCommand } from "./executors";
import { claudeMcpConfig, claudePermissionSettings, type McpTaskInfo, missionBranchPrefix, newMcpToken } from "./mcp";
import { isInside, resolveForAgent } from "./paths";
import { claudeSessionExists, claudeSessionFile, type TaskSecrets, WRONG_SESSION_FLAG } from "./tasks";

/**
 * Brain turns (protocol 8, ADR 0032): Claude Code thinks for an agent on
 * this machine, one conversational turn at a time.
 *
 * - Each turn runs `claude -p --input-format stream-json --output-format
 *   stream-json --verbose --include-partial-messages`, with `--resume <session>`
 *   (or `--session-id` for a new one), the agent's model (`--fallback-model
 *   sonnet` under opus), the engine's context appended to the system prompt
 *   from a file (no shell, no quoting: the process is spawned with an argv),
 *   our MCP bridge (`--mcp-config`, `--strict-mcp-config` unless the agent
 *   opted into the owner's own servers) and the missions' command policy
 *   (`--settings`, the permission prompt tool, the deny list).
 * - The turn's prompt goes in as a stream-json user message on stdin. Output
 *   lines become `WireBrainEvent`s: text deltas (batched every ~50 ms), tool
 *   calls with their results (already executed: our tools through the bridge,
 *   Claude Code's own on the machine), plan usage, plan limits, and a final
 *   `done` or `error`.
 * - Block 5: one process per (agent, session) stays alive between turns
 *   (stdin open), closed after `idleMs` without a turn, at most
 *   `maxProcesses` (the least recently used idle one is closed for a new
 *   one; with all busy the turn runs one-shot). A process that dies while
 *   idle is started again (resumed) on the next turn; one that dies mid-turn
 *   is replaced by a one-shot resume of the same turn. Turns of one session
 *   run one at a time (queued).
 * - ADR 0041: a turn with an `account` runs with `CLAUDE_CONFIG_DIR` set to
 *   that account's folder (its sessions live there too; a missing folder is
 *   `account_missing`, never another account), and `effort` is `--effort`.
 *   A change of either starts the process again.
 */

export const BRAIN_IDLE_MS = 10 * 60_000;
export const BRAIN_MAX_PROCESSES = 3;
/** Text deltas are sent at most this often (batched). */
export const DELTA_FLUSH_MS = 50;
/** A one-shot start that fails this fast with "wrong session flag" is retried once with the other flag. */
const FAST_FAIL_MS = 30_000;
const SESSION_ID = /^[a-fA-F0-9-]{36}$/;
const RUN_ID = /^[a-zA-Z0-9-]{8,64}$/;
const MODEL = /^[A-Za-z0-9._:[\]-]{1,100}$/;
const STDERR_KEEP = 4000;

/** The prefix Claude Code gives our bridge's tools; the engine knows them by their own names. */
const OUR_TOOL_PREFIX = "mcp__agentes__";

// ── Stream parsing ───────────────────────────────────────────────────────────

/** Claude Code says the plan's usage is exhausted (a result text, older and newer wordings). */
export const LIMIT_TEXT = /usage limit|hit your limit|limit reached|out of extra usage|rate limit/i;
/** Claude Code can't authenticate (not logged in, a revoked token, a bad key). */
export const AUTH_TEXT = /not logged in|\/login|invalid api key|authentication[_ ]failed|oauth token|credentials/i;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (isObj(b) && b.type === "text" ? str(b.text) : "")).join("\n");
}

const cutInput = (input: unknown): unknown => {
  try {
    const text = JSON.stringify(input ?? {});
    return text.length <= BRAIN_LIMITS.toolText ? input : { truncated: text.slice(0, BRAIN_LIMITS.toolText) };
  } catch {
    return {};
  }
};

const secondsToIso = (v: unknown) => {
  const n = num(v);
  if (n <= 0) return undefined;
  // Seconds (Claude Code's `resetsAt`); a value in milliseconds is taken as is.
  return new Date(n < 1e12 ? n * 1000 : n).toISOString();
};

/** What one line meant for the turn: events to send now, and the turn's end. */
export interface ParsedBrainLine {
  events: WireBrainEvent[];
  final?: WireBrainEvent;
}

/**
 * Claude Code's `stream-json` output → `WireBrainEvent`s. One parser per
 * process (the session id persists); `beginTurn` resets what a turn tracks.
 * Only the main conversation counts (`parent_tool_use_id` null): subagents
 * work inside a tool call.
 */
export class ClaudeStreamParser {
  session?: string;
  /**
   * `false` (default): only our bridge's tools become `tool_call` events (the
   * engine records them); Claude Code's own tools (Bash, Edit, Read…) stay on
   * the machine. `true`: those too, by their Claude Code names.
   */
  constructor(private readonly localTools = false) {}

  private tools = new Map<string, { name: string; input: unknown }>();
  private sawDelta = false;
  private limited = false;
  private limitSent = false;
  private resetsAt?: string;
  private authFailed = false;

  beginTurn() {
    this.tools.clear();
    this.sawDelta = false;
    this.limited = false;
    this.limitSent = false;
    this.resetsAt = undefined;
    this.authFailed = false;
  }

  push(raw: string): ParsedBrainLine {
    const text = raw.trim();
    if (!text.startsWith("{")) return { events: [] };
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { events: [] };
    }
    if (typeof ev.session_id === "string" && ev.session_id) this.session = ev.session_id;
    const main = ev.parent_tool_use_id === null || ev.parent_tool_use_id === undefined;
    switch (ev.type) {
      case "system":
        if (ev.subtype === "api_retry" && ev.error === "authentication_failed") this.authFailed = true;
        if (ev.subtype === "api_retry" && ev.error === "rate_limit") this.limited = true;
        return { events: [] };
      case "stream_event": {
        const e = isObj(ev.event) ? ev.event : {};
        const delta = isObj(e.delta) ? e.delta : {};
        if (main && e.type === "content_block_delta" && delta.type === "text_delta" && str(delta.text)) {
          this.sawDelta = true;
          return { events: [{ type: "text_delta", text: str(delta.text) }] };
        }
        return { events: [] };
      }
      case "assistant": {
        if (!main) return { events: [] };
        if (ev.error === "authentication_failed") this.authFailed = true;
        if (ev.error === "rate_limit") this.limited = true;
        const content = isObj(ev.message) && Array.isArray(ev.message.content) ? ev.message.content : [];
        const events: WireBrainEvent[] = [];
        for (const block of content) {
          if (!isObj(block)) continue;
          if (
            block.type === "tool_use" &&
            str(block.id) &&
            str(block.name) &&
            (this.localTools || str(block.name).startsWith(OUR_TOOL_PREFIX))
          ) {
            this.tools.set(str(block.id), { name: str(block.name), input: block.input ?? {} });
          } else if (block.type === "text" && str(block.text) && !this.sawDelta) {
            // No partial messages (an older Claude Code): the whole text block at once.
            events.push({ type: "text_delta", text: str(block.text) });
          }
        }
        this.sawDelta = false;
        return { events };
      }
      case "user": {
        if (!main) return { events: [] };
        const content = isObj(ev.message) && Array.isArray(ev.message.content) ? ev.message.content : [];
        const events: WireBrainEvent[] = [];
        for (const block of content) {
          if (!isObj(block) || block.type !== "tool_result") continue;
          const id = str(block.tool_use_id);
          const call = this.tools.get(id);
          if (!call) continue;
          this.tools.delete(id);
          const name = call.name.startsWith(OUR_TOOL_PREFIX) ? call.name.slice(OUR_TOOL_PREFIX.length) : call.name;
          events.push({
            type: "tool_call",
            id,
            name: name.slice(0, BRAIN_LIMITS.toolName),
            input: cutInput(call.input),
            executed: {
              content: toolResultText(block.content).slice(0, BRAIN_LIMITS.toolText),
              ...(block.is_error === true ? { isError: true } : {}),
            },
          });
        }
        return { events };
      }
      case "rate_limit_event": {
        const info = isObj(ev.rate_limit_info) ? ev.rate_limit_info : {};
        if (info.status !== "rejected") return { events: [] };
        this.limited = true;
        this.resetsAt = secondsToIso(info.resetsAt);
        if (this.limitSent) return { events: [] };
        this.limitSent = true;
        return { events: [{ type: "limit", ...(this.resetsAt ? { resetsAt: this.resetsAt } : {}) }] };
      }
      case "result":
        return this.result(ev);
      default:
        return { events: [] };
    }
  }

  private result(ev: Record<string, unknown>): ParsedBrainLine {
    const events: WireBrainEvent[] = [];
    const usage = isObj(ev.usage) ? ev.usage : {};
    const cacheRead = num(usage.cache_read_input_tokens);
    const cacheWrite = num(usage.cache_creation_input_tokens);
    const input = num(usage.input_tokens) + cacheRead + cacheWrite;
    const output = num(usage.output_tokens);
    const models = isObj(ev.modelUsage) ? Object.keys(ev.modelUsage) : [];
    if (input > 0 || output > 0) {
      events.push({
        type: "usage",
        input,
        output,
        source: "plan",
        ...(models[0] ? { model: models[0] } : {}),
        ...(cacheRead > 0 ? { cacheRead } : {}),
        ...(cacheWrite > 0 ? { cacheWrite } : {}),
      });
    }
    this.tools.clear();
    const session = str(ev.session_id) || this.session;
    const text = str(ev.result) || (Array.isArray(ev.errors) ? ev.errors.map(str).join("\n") : "");
    if (ev.is_error === true || (typeof ev.subtype === "string" && ev.subtype !== "success")) {
      if (this.limited || LIMIT_TEXT.test(text)) {
        const legacy = /\|(\d{10})\b/.exec(text)?.[1];
        const resetsAt = this.resetsAt ?? (legacy ? secondsToIso(Number(legacy)) : undefined);
        if (!this.limitSent) events.push({ type: "limit", ...(resetsAt ? { resetsAt } : {}) });
        this.limitSent = true;
        return {
          events,
          final: {
            type: "error",
            code: "plan_limit",
            message: (text || "The plan's usage limit was reached.").slice(0, BRAIN_LIMITS.message),
            retryable: true,
          },
        };
      }
      if (this.authFailed || AUTH_TEXT.test(text)) {
        return {
          events,
          final: {
            type: "error",
            code: "not_logged_in",
            message: (text || "Claude Code is not logged in on this computer.").slice(0, BRAIN_LIMITS.message),
            retryable: true,
          },
        };
      }
      return {
        events,
        final: {
          type: "error",
          code: "claude_failed",
          message: (text || `Claude Code ended with ${str(ev.subtype) || "an error"}`).slice(0, BRAIN_LIMITS.message),
          retryable: false,
        },
      };
    }
    return {
      events,
      final: {
        type: "done",
        text: text.slice(0, BRAIN_LIMITS.doneText),
        ...(session ? { session: { id: session } } : {}),
      },
    };
  }
}

// ── Command line ─────────────────────────────────────────────────────────────

export interface ClaudeLaunch {
  session: string;
  /** `--resume` (else `--session-id`). */
  resume: boolean;
  model?: string;
  /** The engine's context, appended to the system prompt. */
  systemFile?: string;
  mcpConfigFile?: string;
  settingsFile?: string;
  /** Only our MCP servers (the owner's own ones are left out). */
  strictMcp: boolean;
  /** Commands off the allow list ask a person through our tool. */
  promptTool: boolean;
  permissionMode: "acceptEdits" | "dontAsk";
  /** Protocol 10: folders allowed for the agent besides its own (`--add-dir` each). */
  addDirs?: string[];
  /** Protocol 13: `--effort` (anything else is left out). */
  effort?: BrainEffort;
  /**
   * D60: which settings files load (`--setting-sources`). "project" leaves out the computer owner's own
   * CLAUDE.md, skills and plugins, which every agent there paid for on every step.
   */
  settingSources?: string;
  /** D60: Claude Code's own tools the agent gets (`--tools`); the rest aren't described on every step. */
  builtinTools?: readonly string[];
}

/**
 * Claude Code's own tools a brain keeps (D60): reading, searching, editing and running code in its folder,
 * and the web. Ours come through MCP. Names Claude Code doesn't know are ignored by it.
 */
export const BRAIN_BUILTIN_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"] as const;

/** Claude Code under opus falls back to sonnet when opus is overloaded or out of the plan. */
export const fallbackModelFor = (model: string | undefined) => (model && /opus/i.test(model) ? "sonnet" : undefined);

/** The argv of a brain turn's Claude Code (spawned without a shell: nothing needs quoting). */
export function claudeBrainArgs(l: ClaudeLaunch): string[] {
  const model = l.model && MODEL.test(l.model) ? l.model : undefined;
  const fallback = fallbackModelFor(model);
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode",
    l.permissionMode,
    ...(model ? ["--model", model] : []),
    ...(fallback ? ["--fallback-model", fallback] : []),
    ...(isBrainEffort(l.effort) ? ["--effort", l.effort] : []),
    ...(l.systemFile ? ["--append-system-prompt-file", l.systemFile] : []),
    ...(l.mcpConfigFile ? ["--mcp-config", l.mcpConfigFile] : []),
    ...(l.strictMcp ? ["--strict-mcp-config"] : []),
    ...(l.settingsFile ? ["--settings", l.settingsFile] : []),
    ...(l.mcpConfigFile ? ["--allowedTools", "mcp__agentes"] : []),
    ...(l.promptTool && l.mcpConfigFile ? ["--permission-prompt-tool", PERMISSION_PROMPT_TOOL] : []),
    ...(l.addDirs ?? []).flatMap((d) => ["--add-dir", d]),
    ...(l.settingSources ? ["--setting-sources", l.settingSources] : []),
    ...(l.builtinTools ? ["--tools", l.builtinTools.join(",")] : []),
    l.resume ? "--resume" : "--session-id",
    l.session,
  ];
}

/** One user message on Claude Code's stream-json stdin. */
export const userMessageLine = (prompt: string) =>
  `${JSON.stringify({ type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null, session_id: "" })}\n`;

// ── One process ──────────────────────────────────────────────────────────────

/** A running `claude` with stream-json in and out. */
export class ClaudeProcess {
  readonly child: ChildProcess;
  readonly parser = new ClaudeStreamParser();
  readonly startedAt = Date.now();
  exited = false;
  exitCode: number | null = null;
  stderr = "";
  private lineHandler: ((line: string) => void) | null = null;
  private exitHandlers = new Set<() => void>();

  constructor(command: string[], args: string[], cwd: string, env: NodeJS.ProcessEnv) {
    const [file, ...pre] = command;
    // A full path: the compiled runner would look the bare name up on the PATH it started with.
    this.child = spawn(resolveCommand(file ?? "claude", env.PATH), [...pre, ...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Windows finds `claude.cmd` only through the shell (argv stays plain: files, ids, flags).
      shell: process.platform === "win32" && command.length === 1,
    });
    const events = this.child as unknown as EventEmitter;
    events.on("error", (err: Error) => {
      this.stderr = `${this.stderr}${err.message}\n`.slice(-STDERR_KEEP);
      if ((err as { code?: string }).code === "ENOENT") this.stderr = `ENOENT ${this.stderr}`;
      this.markExit(null);
    });
    events.on("exit", (code: number | null) => this.markExit(code));
    this.child.stdin?.on("error", () => {});
    if (this.child.stdout) {
      const rl = createInterface({ input: this.child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
      (rl as unknown as EventEmitter).on("line", (line: string) => this.lineHandler?.(line));
    }
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_KEEP);
    });
  }

  private markExit(code: number | null) {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    // Lines still buffered in readline arrive first.
    setImmediate(() => {
      for (const h of [...this.exitHandlers]) h();
    });
  }

  onLine(handler: ((line: string) => void) | null) {
    this.lineHandler = handler;
  }

  onExit(handler: () => void): () => void {
    if (this.exited) {
      setImmediate(handler);
      return () => {};
    }
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  write(text: string) {
    try {
      this.child.stdin?.write(text);
    } catch {
      // gone: the exit handler settles the turn
    }
  }

  endInput() {
    try {
      this.child.stdin?.end();
    } catch {}
  }

  kill() {
    if (this.exited) return;
    try {
      this.child.kill("SIGTERM");
    } catch {}
    const t = setTimeout(() => {
      if (!this.exited) {
        try {
          this.child.kill("SIGKILL");
        } catch {}
      }
    }, 3000);
    t.unref?.();
  }

  /** Ends input (Claude Code exits after the last turn) and kills it if it lingers. */
  close() {
    this.endInput();
    const t = setTimeout(() => this.kill(), 5000);
    t.unref?.();
  }
}

/** How a turn on a process ended: its final event, or the process died before one. */
interface TurnOutcome {
  final?: WireBrainEvent;
  died?: boolean;
}

/**
 * Runs one turn on a process: writes the prompt, emits events (text deltas
 * batched every `deltaMs`), resolves on the turn's `result` or the process
 * exiting first. Abort kills the process.
 */
export function runTurnOnProcess(
  proc: ClaudeProcess,
  prompt: string,
  opts: {
    emit: (e: WireBrainEvent) => void;
    signal?: AbortSignal;
    deltaMs?: number;
    redact?: (text: string) => string;
    /** One-shot: stdin closes after the prompt. */
    endInput?: boolean;
  },
): Promise<TurnOutcome> {
  const redact = opts.redact ?? ((s: string) => s);
  const deltaMs = opts.deltaMs ?? DELTA_FLUSH_MS;
  proc.parser.beginTurn();
  return new Promise<TurnOutcome>((resolve) => {
    let buf = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!buf) return;
      const text = redact(buf);
      buf = "";
      opts.emit({ type: "text_delta", text });
    };
    const clean = (e: WireBrainEvent): WireBrainEvent => {
      if (e.type === "tool_call") {
        return {
          ...e,
          ...(e.executed ? { executed: { ...e.executed, content: redact(e.executed.content) } } : {}),
          input: JSON.parse(redact(JSON.stringify(e.input ?? {}))) as unknown,
        };
      }
      if (e.type === "done") return { ...e, text: redact(e.text) };
      if (e.type === "error") return { ...e, message: redact(e.message) };
      return e;
    };
    const finish = (out: TurnOutcome) => {
      if (settled) return;
      settled = true;
      flush();
      proc.onLine(null);
      offExit();
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(out.final ? { ...out, final: clean(out.final) } : out);
    };
    proc.onLine((line) => {
      if (settled) return;
      const parsed = proc.parser.push(line);
      for (const e of parsed.events) {
        if (e.type === "text_delta") {
          buf += e.text;
          if (!timer) timer = setTimeout(flush, deltaMs);
          continue;
        }
        flush();
        opts.emit(clean(e));
      }
      if (parsed.final) finish({ final: parsed.final });
    });
    const offExit = proc.onExit(() => finish({ died: true }));
    function onAbort() {
      proc.kill();
      finish({ final: { type: "error", code: "canceled", message: "The turn was canceled.", retryable: false } });
    }
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    proc.write(userMessageLine(prompt));
    if (opts.endInput) proc.endInput();
  });
}

// ── The manager ──────────────────────────────────────────────────────────────

export interface BrainManagerOptions {
  /** `<runner home>/brains`: per-process files (system prompt, MCP config, settings), mode 600. */
  root: string;
  /** How to start Claude Code (tests: a fake script). Default `["claude"]`. */
  claudeCommand?: string[];
  /** Where Claude Code keeps sessions (default `$CLAUDE_CONFIG_DIR` or `~/.claude`). */
  claudeHome?: string;
  /** Protocol 13: the accounts' folders (ADR 0041); without it a turn with an account is `account_missing`. */
  accounts?: { accountDir(kind: AccountKind, id: string): string | null };
  /** The local MCP bridge (where the daemon listens and how to start `agentes-runner mcp`). */
  mcp?: { socketPath: string; command: string[] };
  idleMs?: number;
  maxProcesses?: number;
  deltaMs?: number;
  log?: (line: string) => void;
}

interface Live {
  key: string;
  id: string;
  proc: ClaudeProcess;
  /** Launch settings: a turn asking for others restarts the process (resumed). */
  sig: string;
  /** What `ran` remembers for it: the session, in its account. */
  ranKey: string;
  busy: boolean;
  lastUsed: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  persistent: boolean;
}

/** What the bridge needs for one process's MCP server: its local token, and the run it works for now. */
interface BridgeEntry {
  token: string;
  cwd: string;
  folder: string;
  runId: string | null;
  runToken: string | null;
  redact?: (text: string) => string;
}

export interface BrainTurnContext {
  agent: AgentScope;
  /** The agent's folder (real path). */
  folder: string;
  secrets?: TaskSecrets | null;
  emit: (e: WireBrainEvent) => void;
  signal?: AbortSignal;
  /** Protocol 10: folders allowed for the agent besides its own (real paths): `cwd` may be inside one, `--add-dir` each. */
  grants?: string[];
  /** Set by the manager (ADR 0041): the turn's account folder, its Claude Code home. */
  accountHome?: string;
}

/** A session is remembered per account: the same id in another account's folder is another session. */
const ranKeyOf = (req: BrainTurnRequest, session: string) =>
  typeof req.account === "string" && req.account ? `${req.account}:${session}` : session;

/**
 * A conversation that moves to another folder (the agent's folder, then its
 * checkout `repos/owner/name` once cloned) keeps its Claude Code session:
 * Claude Code resumes only from the folder's own project, so the newest copy
 * of the session is copied there first. Best effort.
 */
export function carryClaudeSession(claudeHome: string, cwd: string, session: string) {
  const projects = path.join(claudeHome, "projects");
  const target = claudeSessionFile(claudeHome, cwd, session);
  let newest: { file: string; mtime: number } | null = null;
  try {
    for (const dir of readdirSync(projects)) {
      const file = path.join(projects, dir, `${session}.jsonl`);
      try {
        const mtime = statSync(file).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { file, mtime };
      } catch {
        // not in this project
      }
    }
    if (!newest || newest.file === target) return;
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(newest.file, target);
  } catch {
    // no projects folder, or unreadable: Claude Code decides as before
  }
}

const errorEvent = (code: string, message: string, retryable: boolean): WireBrainEvent => ({
  type: "error",
  code,
  message: message.slice(0, BRAIN_LIMITS.message),
  retryable,
});

export class BrainManager {
  private readonly live = new Map<string, Live>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly bridge = new Map<string, BridgeEntry>();
  /** Sessions that answered here (`ranKeyOf`): resumed next time even where Claude Code's folder can't be looked at. */
  private readonly ran = new Set<string>();
  private closed = false;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: BrainManagerOptions) {
    this.log = opts.log ?? (() => {});
  }

  /** New limits from the config: idle time for processes started from now on, the process cap at once. */
  setLimits(limits: { idleMs?: number; maxProcesses?: number }) {
    if (limits.idleMs !== undefined) this.opts.idleMs = limits.idleMs;
    if (limits.maxProcesses !== undefined) this.opts.maxProcesses = limits.maxProcesses;
  }

  /** Persistent processes alive now (tests, status). */
  get size() {
    return [...this.live.values()].filter((l) => l.persistent && !l.proc.exited).length;
  }

  /** The live process of a session, if any (tests). */
  process(agentId: string, session: string): ClaudeProcess | undefined {
    return this.live.get(`${agentId}:${session}`)?.proc;
  }

  /**
   * For the MCP bridge: the token of a brain process's MCP server, the run it
   * works for now (its calls are relayed for that run) and whether a turn runs.
   */
  mcpTask(id: string): McpTaskInfo | null {
    const b = this.bridge.get(id);
    if (!b) return null;
    return {
      token: b.token,
      missionId: "",
      running: b.runId !== null,
      // Between turns the process lives on, but nothing is relayed (never with an ended run's token).
      ...(b.runId === null ? { idle: true } : {}),
      cwd: b.cwd,
      folder: b.folder,
      ...(b.runId ? { runId: b.runId } : {}),
      // The run's server-issued bridge token (ADR 0032): the server maps each call to the run.
      ...(b.runToken && isRunToolToken(b.runToken) ? { serverToken: b.runToken } : {}),
      ...(b.redact ? { redact: b.redact } : {}),
    };
  }

  /** One turn; resolves with its final event (also emitted). Turns of one session queue. */
  async turn(req: BrainTurnRequest, ctx: BrainTurnContext): Promise<WireBrainEvent> {
    const final = await this.turnInner(req, ctx).catch((err: unknown) =>
      err instanceof RunnerError
        ? errorEvent(err.code === "not_found" ? "bad_request" : err.code, err.message, false)
        : errorEvent("internal", err instanceof Error ? err.message : String(err), false),
    );
    ctx.emit(final);
    return final;
  }

  private async turnInner(req: BrainTurnRequest, ctx: BrainTurnContext): Promise<WireBrainEvent> {
    if (this.closed) return errorEvent("runner_stopping", "The runner is stopping.", true);
    if (req.kind !== "claude_code") {
      return errorEvent("unsupported", `This runner has no ${String(req.kind)} brain.`, true);
    }
    if (typeof req.runId !== "string" || !RUN_ID.test(req.runId))
      throw new RunnerError("bad_request", "Invalid run id");
    const session = typeof req.session?.id === "string" ? req.session.id : "";
    if (!SESSION_ID.test(session)) throw new RunnerError("bad_request", "The session must be a UUID");
    if (typeof req.prompt !== "string" || !req.prompt.trim()) throw new RunnerError("bad_request", "Empty prompt");
    let cwd = ctx.folder;
    if (typeof req.cwd === "string" && req.cwd.trim() !== "") {
      const resolved = await resolveForAgent(ctx.folder, ctx.grants, req.cwd);
      if (!resolved.exists) throw new RunnerError("not_found", `The folder ${req.cwd} doesn't exist`);
      if (!statSync(resolved.abs).isDirectory()) throw new RunnerError("bad_request", `${req.cwd} is not a folder`);
      cwd = resolved.abs;
    }
    // ADR 0041: the account's folder or nothing (never the machine's own sign-in instead).
    const account: unknown = req.account;
    if (account !== undefined && account !== null && account !== "") {
      if (!isAccountId(account)) throw new RunnerError("bad_request", "Invalid account id");
      const home = this.opts.accounts?.accountDir("claude_code", account);
      if (!home) return errorEvent("account_missing", ACCOUNT_MISSING_MESSAGE.claude_code, false);
      ctx = { ...ctx, accountHome: home };
    }
    const key = `${ctx.agent.id}:${session}`;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => this.runTurn(key, session, cwd, req, ctx));
    this.chains.set(key, run);
    try {
      return await run;
    } finally {
      if (this.chains.get(key) === run) this.chains.delete(key);
    }
  }

  private signature(cwd: string, req: BrainTurnRequest, ctx: BrainTurnContext) {
    return JSON.stringify({
      cwd,
      model: req.model ?? null,
      personal: req.personalMcp === true,
      perm: req.permissions ?? null,
      // Folders allowed or removed on the machine: the process restarts (resumed) with the new `--add-dir`s.
      dirs: ctx.grants ?? [],
      // Another account or effort: a new process (in the other account, a new session).
      account: ctx.accountHome ? (req.account ?? null) : null,
      effort: isBrainEffort(req.effort) ? req.effort : null,
    });
  }

  private async runTurn(
    key: string,
    session: string,
    cwd: string,
    req: BrainTurnRequest,
    ctx: BrainTurnContext,
  ): Promise<WireBrainEvent> {
    if (ctx.signal?.aborted) return errorEvent("canceled", "The turn was canceled.", false);
    const sig = this.signature(cwd, req, ctx);
    let live = this.live.get(key);
    if (live && (live.proc.exited || live.sig !== sig)) {
      this.drop(live);
      live = undefined;
    }
    const keepAlive = req.keepAlive !== false;
    if (!live && keepAlive) {
      if (this.size >= (this.opts.maxProcesses ?? BRAIN_MAX_PROCESSES)) this.evictIdle();
      if (this.size < (this.opts.maxProcesses ?? BRAIN_MAX_PROCESSES)) {
        live = this.spawn(key, session, cwd, req, ctx, sig, true, this.resumeFor(cwd, session, req, ctx));
      }
    }
    if (live) {
      const out = await this.onLive(live, req, ctx);
      if (out.final) return out.final;
      // Died mid-turn: the same turn again, one-shot, resuming the session.
      this.log(`[${ctx.agent.handle}] brain process for ${session.slice(0, 8)} died mid-turn; resuming one-shot`);
      if (live.proc.stderr.startsWith("ENOENT")) return this.cliMissing();
      return this.oneShot(key, session, cwd, req, ctx, sig, this.resumeFor(cwd, session, req, ctx, true), true);
    }
    return this.oneShot(key, session, cwd, req, ctx, sig, this.resumeFor(cwd, session, req, ctx), true);
  }

  private resumeFor(cwd: string, session: string, req: BrainTurnRequest, ctx: BrainTurnContext, ranBefore = false) {
    const home =
      ctx.accountHome ?? this.opts.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
    carryClaudeSession(home, cwd, session);
    const found = claudeSessionExists(home, cwd, session);
    if (found !== null) return found;
    const ran = ranBefore || this.ran.has(ranKeyOf(req, session));
    // An account folder with no sessions yet: the conversation's earlier ones live in another home.
    return ctx.accountHome ? ran : ran || req.session?.resume === true;
  }

  private cliMissing() {
    return errorEvent("cli_missing", "Claude Code (claude) is not installed on this computer's PATH.", true);
  }

  private async onLive(live: Live, req: BrainTurnRequest, ctx: BrainTurnContext): Promise<TurnOutcome> {
    live.busy = true;
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
    const bridge = this.bridge.get(live.id);
    if (bridge) {
      bridge.runId = req.runId;
      bridge.runToken = typeof req.mcp?.token === "string" ? req.mcp.token : null;
    }
    try {
      const out = await runTurnOnProcess(live.proc, req.prompt, {
        emit: ctx.emit,
        signal: ctx.signal,
        deltaMs: this.opts.deltaMs,
        redact: ctx.secrets?.redact,
        endInput: !live.persistent,
      });
      if (out.final?.type === "done") this.ran.add(live.ranKey);
      if (out.died || (out.final?.type === "error" && out.final.code === "canceled")) this.drop(live);
      return out;
    } finally {
      live.busy = false;
      live.lastUsed = Date.now();
      if (bridge) {
        bridge.runId = null;
        bridge.runToken = null;
      }
      if (live.persistent && this.live.get(live.key) === live) this.armIdle(live);
    }
  }

  private async oneShot(
    key: string,
    session: string,
    cwd: string,
    req: BrainTurnRequest,
    ctx: BrainTurnContext,
    sig: string,
    resume: boolean,
    mayRetryFlag: boolean,
  ): Promise<WireBrainEvent> {
    const live = this.spawn(key, session, cwd, req, ctx, sig, false, resume);
    const out = await this.onLive(live, req, ctx);
    this.drop(live);
    if (out.final) return out.final;
    if (live.proc.stderr.startsWith("ENOENT")) return this.cliMissing();
    const fast = Date.now() - live.proc.startedAt <= FAST_FAIL_MS;
    if (mayRetryFlag && fast && WRONG_SESSION_FLAG.test(live.proc.stderr)) {
      return this.oneShot(key, session, cwd, req, ctx, sig, !resume, false);
    }
    const tail = live.proc.stderr.trim().split("\n").slice(-3).join(" ").trim();
    if (/not logged in|\/login/i.test(tail)) {
      return errorEvent("not_logged_in", tail || "Claude Code is not logged in on this computer.", true);
    }
    return errorEvent(
      "claude_failed",
      `Claude Code ended without an answer (exit ${live.proc.exitCode ?? "?"})${tail ? `: ${ctx.secrets?.redact ? ctx.secrets.redact(tail) : tail}` : ""}`,
      false,
    );
  }

  private spawn(
    key: string,
    session: string,
    cwd: string,
    req: BrainTurnRequest,
    ctx: BrainTurnContext,
    sig: string,
    persistent: boolean,
    resume: boolean,
  ): Live {
    const id = crypto.randomUUID();
    const dir = path.join(this.opts.root, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const systemFile = path.join(dir, "system.txt");
    writeFileSync(systemFile, typeof req.system === "string" ? req.system : "", { mode: 0o600 });
    const mode = req.permissions?.mode === "plan" ? "plan" : "work";
    let mcpConfigFile: string | undefined;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(ctx.secrets?.env ?? {}),
      // ADR 0041: the account's folder is this process's Claude Code home.
      ...(ctx.accountHome ? { CLAUDE_CONFIG_DIR: ctx.accountHome } : {}),
    };
    if (this.opts.mcp) {
      const token = newMcpToken();
      mcpConfigFile = path.join(dir, "mcp.json");
      writeFileSync(
        mcpConfigFile,
        JSON.stringify(
          claudeMcpConfig({
            command: this.opts.mcp.command,
            taskId: id,
            socketPath: this.opts.mcp.socketPath,
            token,
            cwd,
            folders: [...new Set([cwd, ctx.folder])],
            // D60: our tools always loaded (no ToolSearch call before each one; the list is short since D65).
            alwaysLoad: true,
          }),
        ),
        { mode: 0o600 },
      );
      this.bridge.set(id, {
        token,
        cwd,
        folder: ctx.folder,
        runId: null,
        runToken: null,
        ...(ctx.secrets?.redact ? { redact: ctx.secrets.redact } : {}),
      });
      // A permission prompt waits for a person (up to PERMISSION_WAIT_MS): our tool call may take that long.
      env.MCP_TOOL_TIMEOUT = String(PERMISSION_WAIT_MS + 5 * 60_000);
    }
    const settingsFile = path.join(dir, "settings.json");
    const allow = Array.isArray(req.permissions?.allow)
      ? req.permissions.allow.filter((r): r is string => typeof r === "string")
      : [];
    writeFileSync(
      settingsFile,
      JSON.stringify(
        claudePermissionSettings(mode, missionBranchPrefix(ctx.agent.id, req.permissions?.branchPrefix), allow),
      ),
      { mode: 0o600 },
    );
    // Starting in one of its checkouts (`repos/owner/name`), the agent keeps its whole folder (its other checkouts).
    const addDirs = [
      ...(cwd !== ctx.folder ? [ctx.folder] : []),
      ...(ctx.grants ?? []).filter((g) => !isInside(g, cwd)),
    ];
    const args = claudeBrainArgs({
      session,
      resume,
      ...(typeof req.model === "string" ? { model: req.model } : {}),
      systemFile,
      ...(mcpConfigFile ? { mcpConfigFile } : {}),
      settingsFile,
      strictMcp: req.personalMcp !== true,
      promptTool: mode === "work",
      permissionMode: mode === "plan" ? "dontAsk" : "acceptEdits",
      ...(addDirs.length ? { addDirs } : {}),
      ...(isBrainEffort(req.effort) ? { effort: req.effort } : {}),
      // D60: with the owner's own MCP servers the owner's settings stay, and so does every tool of Claude Code.
      ...(req.personalMcp !== true ? { settingSources: "project", builtinTools: BRAIN_BUILTIN_TOOLS } : {}),
    });
    const proc = new ClaudeProcess(this.opts.claudeCommand ?? ["claude"], args, cwd, env);
    const live: Live = {
      key,
      id,
      proc,
      sig,
      ranKey: ranKeyOf(req, session),
      busy: false,
      lastUsed: Date.now(),
      idleTimer: null,
      persistent,
    };
    if (persistent) this.live.set(key, live);
    // Crashed while idle: forgotten; the next turn starts it again (resumed).
    proc.onExit(() => {
      if (!live.busy) this.drop(live);
    });
    this.log(
      `[${ctx.agent.handle}] brain ${persistent ? "process" : "one-shot"} for ${session.slice(0, 8)} (${resume ? "resume" : "new"})`,
    );
    return live;
  }

  private armIdle(live: Live) {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = setTimeout(() => {
      if (!live.busy) {
        this.log(`brain process ${live.key.split(":")[1]?.slice(0, 8) ?? ""} idle; closing`);
        this.drop(live);
      }
    }, this.opts.idleMs ?? BRAIN_IDLE_MS);
    live.idleTimer.unref?.();
  }

  /** Closes the least recently used idle process, if any. */
  private evictIdle() {
    let lru: Live | undefined;
    for (const l of this.live.values()) {
      if (l.busy || !l.persistent) continue;
      if (!lru || l.lastUsed < lru.lastUsed) lru = l;
    }
    if (lru) this.drop(lru);
  }

  private drop(live: Live) {
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
    if (this.live.get(live.key) === live) this.live.delete(live.key);
    if (!live.proc.exited) live.proc.close();
    this.bridge.delete(live.id);
    const dir = path.join(this.opts.root, live.id);
    // The process may still read its files while it exits.
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    if (live.proc.exited) cleanup();
    else live.proc.onExit(cleanup);
  }

  /** The runner is exiting: every process is closed. */
  close() {
    this.closed = true;
    for (const l of [...this.live.values()]) this.drop(l);
  }
}
