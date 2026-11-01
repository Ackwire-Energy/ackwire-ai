import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
  type BrainSteerReply,
  type BrainSteerRequest,
  type BrainTurnRequest,
  isAccountId,
  isBrainEffort,
  isContextTokens,
  isRunToolToken,
  OWN_USAGE_ID,
  PERMISSION_PROMPT_TOOL,
  PERMISSION_WAIT_MS,
  type WireBrainEvent,
} from "@agenteschat/adapters/machine-protocol";
import { claudeCodeModel, type PlanId, planOf } from "@agenteschat/providers/plans";
import {
  ACCOUNT_MISSING_MESSAGE,
  ACCOUNT_SIGNED_OUT,
  type AccountGrant,
  accountEnv,
  accountSettingsEnv,
  accountSignIn,
  handToken,
  TOKEN_FD_ENV,
  TOKEN_STDIO,
  withSignIn,
  yieldRoute,
} from "./accounts";
import { ownBranches } from "./command-gate";
import { RunnerError } from "./errors";
import { resolveCommand } from "./executors";
import { claudeMcpConfig, claudePermissionSettings, type McpTaskInfo, missionBranchPrefix, newMcpToken } from "./mcp";
import { isInside, resolveForAgent } from "./paths";
import { resetIso } from "./plan-usage";
import type { Spawn } from "./scope-gate";
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
 *   opted into the owner's own servers) and the turn's permission profile
 *   (`brainProfileLaunch`: `--settings`, the permission prompt tool, the deny
 *   list; a `plan` turn reads only, ADR 0053 §3). A background turn
 *   (`keepAlive: false`) leaves no process behind.
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
 *   A change of either starts the process again. Where requests go is pinned
 *   in the runner's own `--settings` (`accountSettingsEnv`), which outranks
 *   the project's settings the agent can write. A key account (protocol 20)
 *   thinks through its plan's endpoint: its key in the process env (never in
 *   a file the CLI reads, and redacted from everything sent), its model
 *   aliases mapped to the plan's models, no fallback model. `--model` is the
 *   agent's alias, or one of the plan's models by id (`claudeCodeModel`).
 * - Protocol 15 (live steering): `steer` writes messages into the turn in
 *   progress as stream-json user lines (each with its `uuid`); Claude Code
 *   reads them at its next tool boundary (`priority: "next"`; "now" for an
 *   urgent one where the CLI can move the running tool to the background).
 *   Support is what the CLI's `system/init` `capabilities` say, not its
 *   version (`steerSupport`). A message is read when its `command_lifecycle`
 *   says `started` (`steer_read` at once); the result's `user_message_uuids`
 *   confirm the same (deduplicated). One it hadn't read when the turn ended
 *   starts the CLI's next turn: this request waits for that turn too and the
 *   answers join, so nothing runs unheard.
 * - Work moved to the background mid-turn (an urgent message) goes on after
 *   the turn's `result`, and when it ends Claude Code starts another turn by
 *   itself: the request stays open for it (bounded) and the answers join.
 *   Past the bound the request ends and the process is left draining.
 * - A turn the CLI runs by itself while no request listens (a background task
 *   of the agent's own that ended later, or moved work past the bound): its
 *   output goes nowhere. The next request waits for that turn's `result`
 *   (`STRAY_TURN_WAIT_MS`) and then uses the same process, so the agent's
 *   other background jobs (a dev server, a watcher) live on. Only a turn stuck
 *   past that wait has its process killed (the next one resumes the session).
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

/**
 * What Claude Code says it can do (`system/init` `capabilities`), as probed on
 * 2026-10-23 (`scripts/probe-claude-steer.ts`; 2.1.175, 2.1.220, 2.1.258,
 * 2.1.259, 2.1.309). Every one of them read a line sent mid-turn at the next
 * tool boundary, but only with `msg_lifecycle_v1` (from 2.1.220; 2.1.175 has
 * no `capabilities` at all) does each line with our `uuid` report
 * `command_lifecycle` `queued` → `started` (the model picked it up: the read)
 * → `completed`. Without it nothing says what was read: not steerable.
 */
export const STEER_CAPABILITY = "msg_lifecycle_v1";
/**
 * `priority: "now"` with a human origin moves the running tool to the
 * background at once and reads the message within a moment (2.1.309). Without
 * it an urgent message is `unsupported` (the engine stops and restarts the turn).
 */
export const STEER_NOW_CAPABILITY = "interrupt_send_now_v1";
/** A result came while steered messages were still queued: how long the CLI's next turn (which reads them) may take to start. */
export const STEER_FOLLOW_UP_MS = 30_000;
/**
 * A result came while work this turn moved to the background still runs: how
 * long the request waits for it to end (and for the turn the CLI then starts
 * by itself). Past it the request ends with what it has and the process is
 * left draining: nothing is killed (the moved work may be a server that never
 * ends); a turn the CLI later runs for it by itself is waited for by the next
 * request (`STRAY_TURN_WAIT_MS`). 10 min: the run shows "working" meanwhile.
 */
export const STEER_BACKGROUND_WAIT_MS = 10 * 60_000;
/**
 * A request found the process in a turn of its own (or one due): how long it
 * waits for that turn's `result` before killing the process and resuming fresh.
 */
export const STRAY_TURN_WAIT_MS = 60_000;
/**
 * Work moved to the background still runs and no turn of its own has begun: how long a request
 * waits for one before going on, on the same process. Never a kill: the work may be a server that
 * never ends (a dev server an urgent message moved aside), and killing the process would kill it.
 */
export const OWN_TURN_DUE_WAIT_MS = 5_000;

/** The `capabilities` of a `system/init` line (none: an older CLI). */
export const claudeCapabilities = (ev: Record<string, unknown>): string[] =>
  Array.isArray(ev.capabilities) ? ev.capabilities.filter((c): c is string => typeof c === "string").slice(0, 100) : [];

/** What a Claude Code with these capabilities takes mid-turn: messages at all (`next`), and urgent ones (`now`). */
export const steerSupport = (capabilities: readonly string[] | undefined) => {
  const next = capabilities?.includes(STEER_CAPABILITY) === true;
  return { next, now: next && capabilities?.includes(STEER_NOW_CAPABILITY) === true };
};

/** The prefix Claude Code gives our bridge's tools; the engine knows them by their own names. */
const OUR_TOOL_PREFIX = "mcp__agentes__";

// ── Stream parsing ───────────────────────────────────────────────────────────

/**
 * Claude Code says the plan's usage is exhausted (a result text, older and newer wordings: "You've hit your
 * session limit", "…weekly limit", "…Opus limit", "…Sonnet limit", "monthly spend limit").
 */
export const LIMIT_TEXT =
  /usage limit|hit your (?:[\w-]+ )?limit|limit reached|out of extra usage|spend limit|rate limit/i;
/** The server throttling everyone, which it says is no plan limit. */
export const NOT_LIMIT_TEXT = /not your usage limit/i;
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

/** The user messages (our `uuid`s) a reply or result says the turn read: the list, else the single field (older CLIs). */
const readUuids = (ev: Record<string, unknown>): string[] => {
  if (Array.isArray(ev.user_message_uuids))
    return ev.user_message_uuids.filter((u): u is string => typeof u === "string");
  return typeof ev.user_message_uuid === "string" ? [ev.user_message_uuid] : [];
};

/** What one line meant for the turn: events to send now, and the turn's end. */
export interface ParsedBrainLine {
  events: WireBrainEvent[];
  final?: WireBrainEvent;
  /** On a result: how many human messages still wait in the CLI's queue (`queued_turn_count`; absent: unknown). */
  queued?: number;
  task?: ParsedTask;
  /** `system` `init`: a turn starts. */
  turnStart?: boolean;
  /** A `rate_limit_event`'s `rate_limit_info` (plan usage, protocol 19), whatever its status. */
  rateLimit?: Record<string, unknown>;
  /** Tool results went back to the model (a tool boundary: queued messages and task notices are read there). */
  boundary?: boolean;
  /** The endpoint refused the sign-in or key, and the CLI is retrying (`api_retry`, 401). */
  authRetry?: boolean;
}

/** A task of Claude Code's (`system/task_*`: a Bash command, a subagent…). */
export interface ParsedTask {
  id: string;
  /** `task_started`. */
  started?: boolean;
  /** Runs in the background (started so, or moved there: `task_updated` `is_backgrounded`). */
  backgrounded?: boolean;
  /** Over (`task_notification`, or `task_updated` with a final status). */
  ended?: boolean;
}

const TASK_OVER = new Set(["completed", "failed", "killed", "stopped", "cancelled", "canceled", "error"]);

/** `system/task_started`, `task_updated`, `task_notification` → what changed for the task. */
function taskOf(ev: Record<string, unknown>): ParsedTask | undefined {
  const id = str(ev.task_id);
  if (!id) return undefined;
  if (ev.subtype === "task_started") return { id, started: true, backgrounded: ev.is_backgrounded === true };
  if (ev.subtype === "task_notification") return { id, ended: true };
  if (ev.subtype === "task_updated") {
    const patch = isObj(ev.patch) ? ev.patch : {};
    if (typeof patch.status === "string" && TASK_OVER.has(patch.status)) return { id, ended: true };
    if (patch.is_backgrounded === true) return { id, backgrounded: true };
  }
  return undefined;
}

/**
 * Claude Code's `stream-json` output → `WireBrainEvent`s. One parser per
 * process (the session id persists); `beginTurn` resets what a turn tracks.
 * Only the main conversation counts (`parent_tool_use_id` null): subagents
 * work inside a tool call. Claude Code's own tools (Bash, WebSearch, Read…)
 * become executed `tool_call` events too, by their Claude Code names: the
 * engine keeps them as what the turn tried (`transcript.harnessTried`).
 */
export class ClaudeStreamParser {
  session?: string;

  private tools = new Map<string, { name: string; input: unknown }>();
  private sawDelta = false;
  /** The API message whose text streamed (`message_start`): Claude Code says it in one `assistant` per block. */
  private streamedMessage: string | null = null;
  private limited = false;
  /** A `rate_limit_event` said `rejected`: the plan itself refused, whatever the result's text. */
  private rejected = false;
  private limitSent = false;
  /** The turn used a tool (ours or Claude Code's own): a cut now loses work the API couldn't see. */
  private worked = false;
  private resetsAt?: string;
  private authFailed = false;

  beginTurn() {
    this.tools.clear();
    this.sawDelta = false;
    this.streamedMessage = null;
    this.limited = false;
    this.rejected = false;
    this.limitSent = false;
    this.worked = false;
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
      case "system": {
        if (ev.subtype === "api_retry" && (ev.error === "authentication_failed" || ev.error_status === 401)) {
          this.authFailed = true;
          return { events: [], authRetry: true };
        }
        if (ev.subtype === "api_retry" && ev.error === "rate_limit") this.limited = true;
        // Claude Code says `init` as each turn starts (also one it starts by itself).
        if (ev.subtype === "init") return { events: [], turnStart: true };
        const task = taskOf(ev);
        return task ? { events: [], task } : { events: [] };
      }
      case "command_lifecycle":
        // The model picked one of our lines up (msg_lifecycle_v1): the moment it's read.
        return ev.state === "started" && str(ev.command_uuid)
          ? { events: [{ type: "steer_read", uuids: [str(ev.command_uuid)] }] }
          : { events: [] };
      case "stream_event": {
        const e = isObj(ev.event) ? ev.event : {};
        const delta = isObj(e.delta) ? e.delta : {};
        if (main && e.type === "message_start")
          this.streamedMessage = isObj(e.message) ? str(e.message.id) || null : null;
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
        const messageId = isObj(ev.message) ? str(ev.message.id) : "";
        const streamed = this.sawDelta || (messageId !== "" && messageId === this.streamedMessage);
        const events: WireBrainEvent[] = [];
        // A turn's first reply names the messages that started it (a steered one the CLI read after a result).
        const read = readUuids(ev);
        if (read.length) events.push({ type: "steer_read", uuids: read });
        for (const block of content) {
          if (!isObj(block)) continue;
          if (block.type === "tool_use") this.worked = true;
          if (block.type === "tool_use" && str(block.id) && str(block.name)) {
            this.tools.set(str(block.id), { name: str(block.name), input: block.input ?? {} });
          } else if (block.type === "text" && str(block.text) && !streamed) {
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
        let boundary = false;
        for (const block of content) {
          if (!isObj(block) || block.type !== "tool_result") continue;
          boundary = true;
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
        return boundary ? { events, boundary } : { events };
      }
      case "rate_limit_event": {
        const info = isObj(ev.rate_limit_info) ? ev.rate_limit_info : {};
        if (info.status !== "rejected") return { events: [], rateLimit: info };
        this.limited = true;
        this.rejected = true;
        this.resetsAt = resetIso(info.resetsAt);
        if (this.limitSent) return { events: [], rateLimit: info };
        this.limitSent = true;
        return { events: [{ type: "limit", ...(this.resetsAt ? { resetsAt: this.resetsAt } : {}) }], rateLimit: info };
      }
      case "result":
        return this.result(ev);
      default:
        return { events: [] };
    }
  }

  private result(ev: Record<string, unknown>): ParsedBrainLine {
    const parsed = this.resultInner(ev);
    const read = readUuids(ev);
    if (read.length) parsed.events.unshift({ type: "steer_read", uuids: read });
    if (typeof ev.queued_turn_count === "number") parsed.queued = ev.queued_turn_count;
    return parsed;
  }

  private resultInner(ev: Record<string, unknown>): ParsedBrainLine {
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
      if (this.rejected || ((this.limited || LIMIT_TEXT.test(text)) && !NOT_LIMIT_TEXT.test(text))) {
        const legacy = /\|(\d{10})\b/.exec(text)?.[1];
        const resetsAt = this.resetsAt ?? (legacy ? resetIso(Number(legacy)) : undefined);
        if (!this.limitSent) events.push({ type: "limit", ...(resetsAt ? { resetsAt } : {}) });
        this.limitSent = true;
        return {
          events,
          final: {
            type: "error",
            code: "plan_limit",
            message: (text || "The plan's usage limit was reached.").slice(0, BRAIN_LIMITS.message),
            retryable: true,
            worked: this.worked,
          },
          // Known only from its words (no `rate_limit_event` said so): the stored usage says limited too.
          ...(this.rejected ? {} : { rateLimit: { status: "rejected" } }),
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
  permissionMode: "acceptEdits" | "dontAsk" | "default";
  /** Protocol 10: folders allowed for the agent besides its own (`--add-dir` each). */
  addDirs?: string[];
  /** Protocol 13: `--effort` (anything else is left out). */
  effort?: BrainEffort;
  /**
   * Which settings files load (`--setting-sources`). "project" leaves out the computer owner's own
   * CLAUDE.md, skills and plugins, which every agent there paid for on every step; "" (a plan turn) loads
   * none, so a folder's own settings can't allow it anything.
   */
  settingSources?: string;
  /** Claude Code's own tools the agent gets (`--tools`); the rest aren't described on every step. */
  builtinTools?: readonly string[];
  /** No `--fallback-model` (a plan's aliases may all be one model). */
  noFallback?: boolean;
}

/**
 * Claude Code's own tools a brain keeps: reading, searching, editing and running code in its folder,
 * and the web. Ours come through MCP. Names Claude Code doesn't know are ignored by it.
 */
export const BRAIN_BUILTIN_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "WebFetch", "WebSearch"] as const;
/** A plan turn's own tools (ADR 0053 §3, 0109): reading, the web and a shell our prompt tool keeps read-only; no edits. */
export const PLAN_BUILTIN_TOOLS = ["Bash", "Read", "Glob", "Grep", "WebFetch", "WebSearch"] as const;

/**
 * How a brain turn's Claude Code starts for its permission profile (ADR 0053 §3).
 * `work`: edits accepted in its folders, every command through our prompt tool
 * (plain reads at once, the rest by the server's rules or a person), and with
 * the owner's own MCP servers (`personalMcp`) the owner's settings and tools too.
 * `plan` (a mission before Start or while a write item runs): our MCP tools only,
 * no settings files of the folder or the owner, no edits (the web stays), and every
 * command answered on the computer by `localVerdict` (reads only, never secrets);
 * nothing is ever asked of a person.
 */
export function brainProfileLaunch(
  mode: "plan" | "work",
  personalMcp: boolean,
): Pick<ClaudeLaunch, "strictMcp" | "promptTool" | "permissionMode" | "settingSources" | "builtinTools"> {
  if (mode === "plan") {
    return {
      strictMcp: true,
      promptTool: true,
      permissionMode: "default",
      settingSources: "",
      builtinTools: PLAN_BUILTIN_TOOLS,
    };
  }
  return {
    strictMcp: !personalMcp,
    promptTool: true,
    permissionMode: "acceptEdits",
    // With the owner's own MCP servers the owner's settings stay, and so does every tool of Claude Code.
    ...(personalMcp ? {} : { settingSources: "project", builtinTools: BRAIN_BUILTIN_TOOLS }),
  };
}

/** Claude Code under opus falls back to sonnet when opus is overloaded or out of the plan. */
export const fallbackModelFor = (model: string | undefined) => (model && /opus/i.test(model) ? "sonnet" : undefined);

/** The argv of a brain turn's Claude Code (spawned without a shell: nothing needs quoting). */
export function claudeBrainArgs(l: ClaudeLaunch): string[] {
  const model = l.model && MODEL.test(l.model) ? l.model : undefined;
  const fallback = l.noFallback ? undefined : fallbackModelFor(model);
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
    ...(l.settingSources !== undefined ? ["--setting-sources", l.settingSources] : []),
    ...(l.builtinTools ? ["--tools", l.builtinTools.join(",")] : []),
    l.resume ? "--resume" : "--session-id",
    l.session,
  ];
}

/**
 * One user message on Claude Code's stream-json stdin. Steered ones carry
 * their `uuid` (the result lists it once read), a `priority` and the human
 * origin (a person wrote it).
 */
export const userMessageLine = (
  prompt: string,
  steer?: { uuid: string; priority: "now" | "next" | "later"; origin?: { kind: "human" } },
) =>
  `${JSON.stringify({
    type: "user",
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
    session_id: "",
    ...(steer ? { uuid: steer.uuid, priority: steer.priority, ...(steer.origin ? { origin: steer.origin } : {}) } : {}),
  })}\n`;

/** A message for a turn in progress (`brain.steer`). */
export type SteerMessage = BrainSteerRequest["messages"][number];

// ── One process ──────────────────────────────────────────────────────────────

/** A running `claude` with stream-json in and out. */
export class ClaudeProcess {
  readonly child: ChildProcess;
  readonly parser = new ClaudeStreamParser();
  readonly startedAt = Date.now();
  exited = false;
  exitCode: number | null = null;
  stderr = "";
  /** Claude Code said `system` `init` (its version, when it has one, is known from then on). */
  initSeen = false;
  /** Claude Code's version, from its `system` `init` line (absent: not said yet, or an old CLI). Logs only. */
  cliVersion?: string;
  /** What it can do (`system` `init` `capabilities`): live steering is decided by these (`steerSupport`). */
  capabilities: string[] = [];
  /**
   * Claude Code started a turn by itself while no request listened (a background
   * task that ended after its turn): its output goes nowhere, and until its
   * `result` a request here would read that turn's output as its own, so the
   * manager waits for it (`waitOwnTurn`).
   */
  strayTurn = false;
  /** Draining: work moved to the background outlived its request; the turn the CLI runs for it is still due. */
  ownTurnDue = false;
  /** Turns the CLI ran by itself and finished while no request listened (tests, logs). */
  ownTurns = 0;
  private ownTurnWaiters = new Set<() => void>();
  /** The turn in progress on this process (set by `runTurnOnProcess`): messages for it mid-turn. */
  turn: { steer(messages: SteerMessage[]): BrainSteerReply } | null = null;
  private lineHandler: ((line: string) => void) | null = null;
  private exitHandlers = new Set<() => void>();

  constructor(
    command: string[],
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    start: Spawn = spawn,
    /** A token root handed over, on its own descriptor (`TOKEN_FD_ENV`). */
    token?: string,
  ) {
    const [file, ...pre] = command;
    // A full path: the compiled runner would look the bare name up on the PATH it started with.
    this.child = start(resolveCommand(file ?? "claude", env.PATH), [...pre, ...args], {
      cwd,
      env: token ? { ...env, ...TOKEN_FD_ENV } : env,
      stdio: token ? [...TOKEN_STDIO] : ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Windows finds `claude.cmd` only through the shell (argv stays plain: files, ids, flags).
      shell: process.platform === "win32" && command.length === 1,
    });
    if (token) handToken(this.child, token);
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
      (rl as unknown as EventEmitter).on("line", (line: string) => {
        // Read whether a turn listens or not (the CLI may say it before the first turn's prompt).
        if (line.includes('"init"')) this.noteInit(line);
        if (this.lineHandler) this.lineHandler(line);
        else this.noteIdle(line);
      });
    }
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_KEEP);
    });
  }

  private noteInit(line: string) {
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      if (ev.type !== "system" || ev.subtype !== "init") return;
      this.initSeen = true;
      if (typeof ev.claude_code_version === "string") this.cliVersion = ev.claude_code_version.slice(0, 40);
      this.capabilities = claudeCapabilities(ev);
    } catch {
      // not a JSON line
    }
  }

  /** A line no request listens to: a turn the CLI started by itself begins (or ends). */
  private noteIdle(line: string) {
    // Leftovers of the last turn (`command_lifecycle` completed, task summaries) say nothing.
    if (!/"type":\s*"(result|assistant|stream_event)"|"subtype":\s*"(init|task_notification)"/.test(line)) return;
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      if (ev.type !== "result") {
        this.strayTurn = true;
        return;
      }
      // That turn is over (its output discarded): the process is clean again.
      this.strayTurn = false;
      this.ownTurnDue = false;
      this.ownTurns++;
      this.wakeOwnTurnWaiters();
    } catch {
      // not a JSON line
    }
  }

  /** In a turn of its own, or one is due: a request here waits first (`awaitOwnTurn`). */
  get onItsOwn() {
    return !this.exited && (this.strayTurn || this.ownTurnDue);
  }

  /** Resolves true once no turn of its own runs or is due; false when `ms` pass first (or it exits). */
  waitOwnTurn(ms: number): Promise<boolean> {
    if (!this.onItsOwn) return Promise.resolve(!this.exited);
    return new Promise<boolean>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.ownTurnWaiters.delete(done);
        resolve(!this.onItsOwn && !this.exited);
      };
      const timer = setTimeout(done, ms);
      this.ownTurnWaiters.add(done);
    });
  }

  private wakeOwnTurnWaiters() {
    for (const w of [...this.ownTurnWaiters]) w();
  }

  private markExit(code: number | null) {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    // Lines still buffered in readline arrive first.
    setImmediate(() => {
      this.wakeOwnTurnWaiters();
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
  /** Steered messages (`uuid`s) the turn never said it read: the CLI would run them unheard, so the process goes. */
  unread?: string[];
  /** Ended while work it moved to the background still ran: the CLI answers it on its own later (draining). */
  draining?: boolean;
}

/**
 * Runs one turn on a process: writes the prompt, emits events (text deltas
 * batched every `deltaMs`), resolves on the turn's `result` or the process
 * exiting first. Abort kills the process.
 *
 * The request goes on past a `result` (answers joined) while the CLI is sure
 * to run another turn for it: steered messages still queued, work moved to the
 * background still running (Claude Code answers it in a turn of its own when it
 * ends, up to `backgroundWaitMs`), or a background task that ended after the
 * model's last look (its notice starts the next turn).
 */
export function runTurnOnProcess(
  proc: ClaudeProcess,
  prompt: string,
  opts: {
    emit: (e: WireBrainEvent) => void;
    signal?: AbortSignal;
    deltaMs?: number;
    redact?: (text: string) => string;
    /** Streamed text holds back this many characters (the longest secret − 1): a value split between batches never leaves in pieces. */
    redactHold?: number;
    /** One-shot: stdin closes after the prompt. */
    endInput?: boolean;
    /** How long the CLI's next turn may take to start when it still has steered messages (`STEER_FOLLOW_UP_MS`). */
    followUpMs?: number;
    /** How long work moved to the background may run on after a result (`STEER_BACKGROUND_WAIT_MS`). */
    backgroundWaitMs?: number;
    /** Each `rate_limit_event` of the turn (`rate_limit_info`). */
    onRateLimit?: (info: Record<string, unknown>) => void;
    /**
     * A credential that never refreshes (a coding plan's key, a Claude token): refused once is refused (Claude
     * Code would retry for minutes), so the turn ends at once as `not_logged_in`, with these words.
     */
    refused?: string;
  },
): Promise<TurnOutcome> {
  const redact = opts.redact ?? ((s: string) => s);
  const deltaMs = opts.deltaMs ?? DELTA_FLUSH_MS;
  const followUpMs = opts.followUpMs ?? STEER_FOLLOW_UP_MS;
  proc.parser.beginTurn();
  const hold = opts.redact ? Math.max(0, opts.redactHold ?? 0) : 0;
  return new Promise<TurnOutcome>((resolve) => {
    let buf = "";
    /** Redacted text kept back from the last batch (`hold`). */
    let tail = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    /** Steered messages written to this turn and not yet said read. */
    const outstanding = new Set<string>();
    /** Answers of results that came while steered messages were still queued: they lead the final one. */
    const held: string[] = [];
    let followUp: ReturnType<typeof setTimeout> | null = null;
    /** The last result the turn went on from (its answer is in `held`). */
    let heldFinal: WireBrainEvent | null = null;
    const joinText = (texts: string[]) => texts.filter(Boolean).join("\n\n").slice(0, BRAIN_LIMITS.doneText);
    /** A final answer led by the held ones. */
    const joined = (final: WireBrainEvent): WireBrainEvent =>
      final.type === "done" && held.length ? { ...final, text: joinText([...held, final.text]) } : final;
    /** No next turn came (or the process went): the result it went on from ends the turn, with the held answers. */
    const heldEnd = (final: WireBrainEvent): WireBrainEvent =>
      final.type === "done" ? { ...final, text: joinText(held) } : final;
    /** Waiting for work moved to the background to end (not reset by lines: it may print nothing for long). */
    let backgroundWait: ReturnType<typeof setTimeout> | null = null;
    /** This request's tasks in the foreground (one that moves to the background later was "moved"). */
    const foreground = new Set<string>();
    /** Its tasks running in the background → moved there mid-turn (else started there by the model). */
    const background = new Map<string, boolean>();
    /** Background tasks that ended since the model last looked (a tool boundary, a turn start): their notice starts a turn. */
    let unheard = 0;
    /** Past a result, nothing of the next turn seen yet. */
    let between = false;
    const movedRunning = () => [...background.values()].some(Boolean);
    const noteTask = (t: ParsedTask) => {
      if (t.ended) {
        foreground.delete(t.id);
        if (background.delete(t.id)) unheard++;
      } else if (t.backgrounded) {
        // Moved (it ran in the foreground, or began before this request) or started there.
        background.set(t.id, foreground.delete(t.id) || !t.started);
      } else if (t.started) foreground.add(t.id);
    };
    const version = () => proc.cliVersion ?? "(version unknown)";
    proc.turn = {
      steer: (messages) => {
        if (settled) return { status: "no_turn" };
        // Stdin closes after a one-shot's prompt: nothing more can go in.
        if (opts.endInput) return { status: "unsupported", reason: "one-shot process" };
        // Not started yet (what it can do unknown): the messages wait for the turn's end, as before.
        if (!proc.initSeen) return { status: "no_turn", reason: "Claude Code is still starting" };
        const support = steerSupport(proc.capabilities);
        if (!support.next) {
          return { status: "unsupported", reason: `Claude Code ${version()} reads messages only between turns` };
        }
        // Urgent where the CLI can't move work aside: the engine stops the turn and starts it again instead.
        if (messages.some((m) => m.urgent) && !support.now) {
          return { status: "unsupported", reason: `Claude Code ${version()} can't take an urgent message mid-turn` };
        }
        for (const m of messages) {
          const priority = m.urgent ? "now" : "next";
          proc.write(userMessageLine(m.text, { uuid: m.uuid, priority, origin: { kind: "human" } }));
          outstanding.add(m.uuid);
        }
        return { status: "accepted", accepted: messages.map((m) => m.uuid) };
      },
    };
    /** Sends the text so far; a batch (`whole` false) keeps back its last `hold` characters for the next one. */
    const flush = (whole = true) => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (!buf && !(whole && tail)) return;
      // Redacted before cutting: the tail kept for next time can't split a value that was caught.
      const out = redact(tail + buf);
      buf = "";
      const cut = whole ? out.length : Math.max(0, out.length - hold);
      tail = out.slice(cut);
      if (cut > 0) opts.emit({ type: "text_delta", text: out.slice(0, cut) });
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
      if (followUp) clearTimeout(followUp);
      if (backgroundWait) clearTimeout(backgroundWait);
      proc.turn = null;
      if (outstanding.size) out = { ...out, unread: [...outstanding] };
      flush();
      proc.onLine(null);
      offExit();
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(out.final ? { ...out, final: clean(out.final) } : out);
    };
    proc.onLine((line) => {
      if (settled) return;
      if (followUp) clearTimeout(followUp);
      followUp = null;
      const parsed = proc.parser.push(line);
      if (parsed.authRetry && opts.refused) {
        proc.kill();
        finish({ final: { type: "error", code: "not_logged_in", message: opts.refused, retryable: true } });
        return;
      }
      // The next turn began: it reads the notices that came before it.
      if (between && (parsed.turnStart || parsed.events.length > 0)) {
        between = false;
        unheard = 0;
      }
      if (parsed.boundary) unheard = 0;
      if (parsed.task) noteTask(parsed.task);
      if (parsed.rateLimit) opts.onRateLimit?.(parsed.rateLimit);
      // Past a result, the work moved aside is over: Claude Code answers it in a turn of its own, about to start.
      if (backgroundWait && !movedRunning()) {
        clearTimeout(backgroundWait);
        backgroundWait = null;
        const end = heldFinal;
        if (end) followUp = setTimeout(() => finish({ final: heldEnd(end) }), followUpMs);
      }
      for (const e of parsed.events) {
        if (e.type === "steer_read") {
          // Only ours (the list may name messages this turn never sent).
          const ours = e.uuids.filter((u) => outstanding.delete(u));
          if (ours.length) {
            flush();
            opts.emit({ type: "steer_read", uuids: ours });
          }
          continue;
        }
        if (e.type === "text_delta") {
          buf += e.text;
          if (!timer) timer = setTimeout(() => flush(false), deltaMs);
          continue;
        }
        flush();
        opts.emit(clean(e));
      }
      const final = parsed.final;
      if (!final) return;
      // The CLI runs another turn for this request: steered messages still queued (the turn ended before
      // a tool boundary), work moved to the background still running, or a background task's notice the
      // model never saw. This request goes on until that turn's result and the answers join. A plan
      // limit or a failed login ends it (the next turn would fail the same way).
      const goesOn = final.type === "done" || (final.type === "error" && final.code === "claude_failed");
      const queuedMessages = outstanding.size > 0 && parsed.queued !== 0;
      const work = movedRunning();
      const notice = unheard > 0;
      unheard = 0;
      if (goesOn && !proc.exited && (queuedMessages || work || notice)) {
        if (final.type === "done" && final.text) held.push(final.text);
        heldFinal = final;
        between = true;
        proc.parser.beginTurn();
        if (work) {
          // Bounded: past it the request ends with what it has; the process drains (answers that work later, unheard).
          backgroundWait ??= setTimeout(
            () => finish({ final: heldEnd(final), draining: true }),
            opts.backgroundWaitMs ?? STEER_BACKGROUND_WAIT_MS,
          );
        } else followUp = setTimeout(() => finish({ final: heldEnd(final) }), followUpMs);
        return;
      }
      finish({ final: joined(final) });
    });
    // Gone after a result it went on from: that result ends the turn (running it again would redo its tools).
    const offExit = proc.onExit(() => finish(heldFinal ? { final: heldEnd(heldFinal) } : { died: true }));
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
  /**
   * Protocol 13: the accounts' folders (ADR 0041); without it a turn with an account is `account_missing`.
   * Protocol 19: what each turn's `rate_limit_event` says, for its account (or `OWN_USAGE_ID`).
   */
  accounts?: {
    accountDir(kind: AccountKind, id: string): string | null;
    /** System mode, in a worker (protocol 29): this agent's own folder for an account root keeps (`AccountGrant`). */
    agentHome?(kind: AccountKind, id: string): string | null;
    noteRateLimit?(key: string, info: unknown): void;
  };
  /** The local MCP bridge (where the daemon listens and how to start `agentes-runner mcp`). */
  mcp?: { socketPath: string; command: string[] };
  /** The runner's home (its accounts among it): turns never read it. */
  runnerHome?: string;
  /** How Claude Code starts (a worker under systemd: in the agent's AI CLIs slice, `scope-gate.ts`). */
  spawn?: Spawn;
  idleMs?: number;
  maxProcesses?: number;
  deltaMs?: number;
  /** Tests: `STEER_FOLLOW_UP_MS`. */
  steerFollowUpMs?: number;
  /** Tests: `STEER_BACKGROUND_WAIT_MS`. */
  steerBackgroundWaitMs?: number;
  /** Tests: `STRAY_TURN_WAIT_MS`. */
  strayWaitMs?: number;
  /** Tests: `OWN_TURN_DUE_WAIT_MS`. */
  dueWaitMs?: number;
  log?: (line: string) => void;
}

interface Live {
  key: string;
  id: string;
  proc: ClaudeProcess;
  /** The account folder it signs in with; null: the computer's own sign-in. */
  account: string | null;
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
  /** Set by the manager (protocol 20): that folder's coding plan and key. */
  planKey?: { provider: PlanId; key: string };
  /** System mode, in a worker (protocol 29): what root handed this turn for its account. */
  grant?: AccountGrant;
  /** Set by the manager from `grant`: the account's Claude token, in the CLI's env only. */
  oauthToken?: string;
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

/** What a turn says when its account's token is refused. */
export const TOKEN_REFUSED = "Claude refused this account's sign-in. Sign in again in AI accounts.";

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
  /** The process each run's turn is on now (live steering finds it by run). */
  private readonly running = new Map<string, Live>();
  /** Sessions that answered here (`ranKeyOf`): resumed next time even where Claude Code's folder can't be looked at. */
  private readonly ran = new Set<string>();
  private closed = false;
  /** The account its agent thinks with, as root last said (`keepAccount`); undefined: not said. */
  private keep: string | null | undefined;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: BrainManagerOptions) {
    this.log = opts.log ?? (() => {});
  }

  /**
   * System mode, in a worker: the account its agent thinks with now (null: none), as root says on each change.
   * A process on any other account closes, a busy one once its turn ends, so no process of this agent's user
   * keeps a sign-in the agent left or one that was removed.
   */
  keepAccount(account: string | null) {
    this.keep = account;
    for (const l of [...this.live.values()]) if (!l.busy && this.left(l)) this.drop(l);
  }

  /** On an account its agent no longer thinks with (the computer's own sign-in is none). */
  private left(l: Live) {
    return this.keep !== undefined && l.account !== null && l.account !== this.keep;
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

  /** Whether a process of that sign-in is open: a turn, or the one kept after it (`null`: the computer's own). */
  holds(account: string | null): boolean {
    const open = (l: Live) => l.account === account && !l.proc.exited;
    return [...this.live.values()].some(open) || [...this.running.values()].some(open);
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

  /**
   * Protocol 15: messages for the turn of `runId` in progress, on the agent's
   * process for that session (another agent's turn is never reached).
   */
  steer(agentId: string, req: BrainSteerRequest): BrainSteerReply {
    const live = this.running.get(req.runId);
    if (!live || live.key !== `${agentId}:${req.session}` || live.proc.exited) return { status: "no_turn" };
    return live.proc.turn?.steer(req.messages) ?? { status: "no_turn" };
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
    // ADR 0041: the account's folder or nothing (never the machine's own sign-in instead). One root keeps
    // (protocol 29) thinks in this agent's own folder for it, with what root handed over.
    const account: unknown = req.account;
    if (account !== undefined && account !== null && account !== "") {
      if (!isAccountId(account)) throw new RunnerError("bad_request", "Invalid account id");
      const signIn = await accountSignIn(this.opts.accounts, "claude_code", account, ctx.grant);
      if (signIn === "signed_out") return errorEvent("not_logged_in", ACCOUNT_SIGNED_OUT, true);
      if (signIn === "missing") return errorEvent("account_missing", ACCOUNT_MISSING_MESSAGE.claude_code, false);
      ctx = {
        ...ctx,
        accountHome: signIn.home,
        ...(signIn.planKey ? { planKey: signIn.planKey } : {}),
        ...(signIn.token ? { oauthToken: signIn.token } : {}),
        secrets: withSignIn(ctx.secrets, signIn),
      };
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
    const secret = ctx.planKey?.key ?? ctx.oauthToken;
    return JSON.stringify({
      cwd,
      model: req.model ?? null,
      personal: req.personalMcp === true,
      perm: req.permissions ?? null,
      // Folders allowed or removed on the machine: the process restarts (resumed) with the new `--add-dir`s.
      dirs: ctx.grants ?? [],
      // Another account or effort: a new process (in the other account, a new session); a new key or token too.
      account: ctx.accountHome ? (req.account ?? null) : null,
      key: secret ? createHash("sha256").update(secret).digest("hex").slice(0, 16) : null,
      effort: isBrainEffort(req.effort) ? req.effort : null,
      // Another context limit: a new process (resumed), started with it.
      context: isContextTokens(req.contextTokens) ? req.contextTokens : null,
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
    // A route on this sign-in stops first: two processes on one sign-in race on its refresh token. Kept right
    // before the process starts, since a route may begin during any await before it.
    await yieldRoute("claude_code", ctx.accountHome);
    const sig = this.signature(cwd, req, ctx);
    let live = this.live.get(key);
    // A turn Claude Code runs by itself there (or one due): its output would read as this turn's. Wait for
    // its end (output discarded) and keep the process, with the agent's background jobs; kill only a stuck one.
    if (live && live.sig === sig && live.proc.onItsOwn) live = await this.awaitOwnTurn(live, session, ctx);
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
      // A background turn (a routine's run): nothing stays alive for it afterwards, not even a process it found.
      if (!keepAlive) this.drop(live);
      if (out.final) return out.final;
      // Died mid-turn: the same turn again, one-shot, resuming the session.
      this.log(`[${ctx.agent.handle}] brain process for ${session.slice(0, 8)} died mid-turn; resuming one-shot`);
      if (live.proc.stderr.startsWith("ENOENT")) return this.cliMissing();
      return this.oneShot(key, session, cwd, req, ctx, sig, this.resumeFor(cwd, session, req, ctx, true), true);
    }
    return this.oneShot(key, session, cwd, req, ctx, sig, this.resumeFor(cwd, session, req, ctx), true);
  }

  /**
   * Waits for the process's own turn before a request uses it. A turn in flight: up to
   * `STRAY_TURN_WAIT_MS`, then the process is killed (undefined; the session resumes in a new one).
   * Only work still running (`ownTurnDue`), no turn begun: up to `OWN_TURN_DUE_WAIT_MS`, then the
   * request goes on on the same process, nothing killed.
   */
  private async awaitOwnTurn(live: Live, session: string, ctx: BrainTurnContext): Promise<Live | undefined> {
    const who = `[${ctx.agent.handle}] brain process for ${session.slice(0, 8)}`;
    const strayMs = this.opts.strayWaitMs ?? STRAY_TURN_WAIT_MS;
    // Busy meanwhile: neither evicted nor closed as idle.
    live.busy = true;
    if (live.idleTimer) clearTimeout(live.idleTimer);
    live.idleTimer = null;
    try {
      if (!live.proc.strayTurn) {
        this.log(`${who} has work moved to the background still running; waiting briefly for its turn`);
        if (await live.proc.waitOwnTurn(this.opts.dueWaitMs ?? OWN_TURN_DUE_WAIT_MS)) return live;
        // No turn began: the work goes on (maybe for good); so does the conversation, on this process.
        if (!live.proc.strayTurn && !live.proc.exited) {
          this.log(`${who}: no turn for the moved work yet; going on without it (nothing killed)`);
          live.proc.ownTurnDue = false;
          return live;
        }
      }
      this.log(`${who} is in a turn of its own; waiting for it`);
      if (await live.proc.waitOwnTurn(strayMs)) return live;
      if (!live.proc.exited) {
        this.log(
          `${who} still in a turn of its own after ${Math.round(strayMs / 1000)} s; killing it (the session resumes in a new one)`,
        );
        live.proc.kill();
      }
      this.drop(live);
      return undefined;
    } finally {
      live.busy = false;
    }
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
    this.running.set(req.runId, live);
    // Usage goes to the account the turn thinks with, or to the computer's own sign-in.
    const usageKey = ctx.accountHome && typeof req.account === "string" ? req.account : OWN_USAGE_ID.claude_code;
    try {
      const out = await runTurnOnProcess(live.proc, req.prompt, {
        emit: ctx.emit,
        signal: ctx.signal,
        deltaMs: this.opts.deltaMs,
        redact: ctx.secrets?.redact,
        redactHold: ctx.secrets?.hold,
        endInput: !live.persistent,
        onRateLimit: (info) => this.opts.accounts?.noteRateLimit?.(usageKey, info),
        ...(ctx.planKey
          ? { refused: "The plan refused its key. Paste a new key in AI accounts." }
          : ctx.oauthToken
            ? { refused: TOKEN_REFUSED }
            : {}),
        ...(this.opts.steerFollowUpMs !== undefined ? { followUpMs: this.opts.steerFollowUpMs } : {}),
        ...(this.opts.steerBackgroundWaitMs !== undefined ? { backgroundWaitMs: this.opts.steerBackgroundWaitMs } : {}),
      });
      if (out.final?.type === "done") this.ran.add(live.ranKey);
      const short = live.key.split(":")[1]?.slice(0, 8) ?? "";
      // A steered message it never read would start a turn nobody listens to: the process goes (the
      // engine sends that message again with its next turn, on a resumed process; never read twice).
      if (out.unread?.length && !out.died) {
        this.log(
          `brain process ${short} (Claude Code ${live.proc.cliVersion ?? "?"}) ended a turn with unread messages; closing`,
        );
        live.proc.kill();
        this.drop(live);
      } else if (out.died || (out.final?.type === "error" && out.final.code === "canceled")) this.drop(live);
      else if (out.draining) {
        // Work moved aside still runs: the CLI answers it on its own later (unheard); the next request waits for that.
        this.log(`brain process ${short} ended a turn with background work still running; draining`);
        live.proc.ownTurnDue = true;
      }
      return out;
    } finally {
      if (this.running.get(req.runId) === live) this.running.delete(req.runId);
      live.busy = false;
      live.lastUsed = Date.now();
      if (bridge) {
        bridge.runId = null;
        bridge.runToken = null;
      }
      if (live.persistent && this.live.get(live.key) === live) {
        if (this.left(live)) this.drop(live);
        else this.armIdle(live);
      }
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
    const base: NodeJS.ProcessEnv = { ...process.env, ...(ctx.secrets?.env ?? {}) };
    // ADR 0041: the account's folder is this process's Claude Code home, and nothing else signs it in.
    const env = ctx.accountHome ? accountEnv("claude_code", ctx.accountHome, base) : base;
    const plan = ctx.planKey ? planOf(ctx.planKey.provider) : undefined;
    if (plan && ctx.planKey) env[plan.claudeCode.tokenEnv] = ctx.planKey.key;
    // Protocol 28: the agent's context limit; Claude Code compacts the conversation there instead of at its window.
    if (isContextTokens(req.contextTokens)) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(req.contextTokens);
    const model = plan ? claudeCodeModel(plan, req.model) : typeof req.model === "string" ? req.model : undefined;
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
            // Our tools always loaded (no ToolSearch call before each one; the list is short since ADR 0043).
            alwaysLoad: true,
            // A plan turn's prompts are answered on the computer (reads only), never asked of anyone.
            profile: mode,
            ...(this.opts.runnerHome ? { runnerHome: this.opts.runnerHome } : {}),
            // Its own branches: a push there needs nobody (ADR 0053 §3).
            branches: ownBranches(ctx.agent, missionBranchPrefix(ctx.agent.id, req.permissions?.branchPrefix)),
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
      JSON.stringify({
        ...claudePermissionSettings(
          mode,
          allow,
          undefined,
          // Every command reaches our prompt tool: plain reads pass there at once, secrets never.
          { promptReads: true, ...(this.opts.runnerHome ? { runnerHome: this.opts.runnerHome } : {}) },
        ),
        // With the owner's own settings loaded (`personalMcp`), theirs decide the computer's own sign-in.
        ...(ctx.accountHome
          ? { env: accountSettingsEnv(plan, model) }
          : req.personalMcp === true
            ? {}
            : { env: accountSettingsEnv(undefined, model, process.env, true) }),
      }),
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
      ...(model ? { model } : {}),
      ...(plan ? { noFallback: true } : {}),
      systemFile,
      ...(mcpConfigFile ? { mcpConfigFile } : {}),
      settingsFile,
      ...brainProfileLaunch(mode, req.personalMcp === true),
      ...(addDirs.length ? { addDirs } : {}),
      ...(isBrainEffort(req.effort) ? { effort: req.effort } : {}),
    });
    const proc = new ClaudeProcess(
      this.opts.claudeCommand ?? ["claude"],
      args,
      cwd,
      env,
      this.opts.spawn,
      ctx.oauthToken,
    );
    const live: Live = {
      key,
      id,
      proc,
      account: ctx.accountHome && typeof req.account === "string" ? req.account : null,
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
