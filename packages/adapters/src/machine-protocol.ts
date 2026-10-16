/**
 * The wire protocol between our server and the runner on a connected
 * computer (ADR 0025). JSON text frames over one WebSocket the runner opens
 * to `/api/machines/connect`. Shared by the server and the runner bundle, so
 * this file imports nothing.
 */

/** Bumped on breaking changes; the server refuses runners older than `MIN_RUNNER_PROTOCOL`. */
export const MACHINE_PROTOCOL_VERSION = 6;
export const MIN_RUNNER_PROTOCOL = 1;
/** From this protocol on, requests carry `agent` and each agent works in its own folder. */
export const AGENT_FOLDERS_PROTOCOL = 2;
/** From this protocol on, the runner keeps secrets for each agent (`op: "secret"`, ADR 0027). */
export const SECRETS_PROTOCOL = 3;
/** From this protocol on, the runner runs background tasks that outlive a request (`task.*`, ADR 0029). */
export const TASKS_PROTOCOL = 4;
/**
 * From this protocol on, a task can belong to a mission: the runner gives the
 * executor the local `agentes` MCP server and relays its calls (`mcp.call` /
 * `mcp.result`, ADR 0029).
 */
export const MISSION_PROTOCOL = 5;
/**
 * From this protocol on, the runner answers `task.output` (the last human
 * lines of a task's log, ADR 0029) and reports pull requests it sees in a
 * task's output (`task.event` `prUrl`). Older runners ignore unknown ops, so
 * the server only asks runners at this protocol or later.
 */
export const TASK_OUTPUT_PROTOCOL = 6;

/** No valid `hello` within this time closes the socket. */
export const HELLO_TIMEOUT_MS = 10_000;
/** The server pings this often; the runner reconnects after two missed pings. */
export const HEARTBEAT_MS = 25_000;
/** Largest text frame either side accepts (a `write` of 5 MB is about 6.7 MB in base64). */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** `read`/`write` bodies (base64 in JSON); larger files go through `push`. */
export const MAX_INLINE_FILE_BYTES = 5 * 1024 * 1024;

export const MACHINE_TOKEN_PREFIX = "agm_";

/** Same as `SecretBox` and `SecretTarget` in `secret-box.ts` (this file imports nothing). */
export interface WireSecretBox {
  v: number;
  epk: string;
  iv: string;
  ct: string;
}
export type WireSecretTarget = { kind: "env" } | { kind: "file"; path: string };

/**
 * Secrets of the request's agent (ADR 0027): `keypair` makes the key for a
 * request (the private key stays on the machine), `deliver` opens the box and
 * stores the value, `discard` drops a request's key, `remove` forgets a secret.
 */
export type SecretRequest =
  | { action: "keypair"; requestId: string }
  | { action: "deliver"; requestId: string; name: string; target: WireSecretTarget; aad: string; box: WireSecretBox }
  | { action: "discard"; requestId: string }
  | { action: "remove"; name: string };

export type MachineOs = "linux" | "darwin" | "windows" | "other";

/** What runs a background task: Claude Code, Codex, or a plain shell command. */
export type TaskExecutor = "claude" | "codex" | "shell";
export const TASK_EXECUTORS: readonly TaskExecutor[] = ["claude", "codex", "shell"];

/**
 * A background task (protocol 4): started detached on the machine, so it
 * survives the runner restarting and the socket dropping; its output goes to
 * files in `<runner home>/tasks/<taskId>/` and its state to the runner's
 * journal. The runner streams `task.event` frames and sends `task.done` once,
 * until the server acknowledges it (`task.ack`).
 */
export interface TaskStart {
  /** Chosen by the server (a UUID). */
  taskId: string;
  executor: TaskExecutor;
  /** `shell`: the command line. */
  command?: string;
  /** `claude` / `codex`: what to do. */
  prompt?: string;
  /** `claude`: the session to continue (one per conversation); the runner resumes it when it exists. */
  session?: string;
  /** `claude`: the server knows this session ran before (a hint; the runner checks on disk). */
  resume?: boolean;
  /** Relative to the agent's folder (default: the folder itself). */
  cwd?: string;
  /** Work in a new git worktree on this new branch (`<agent folder>/.worktrees/<taskId>`), when `cwd` is a git repository. */
  branch?: string;
  /** Killed (the whole process group) after this long; default and cap are the runner's. */
  maxSeconds?: number;
  /**
   * Protocol 5: the task works for a mission. The runner gives the executor
   * the local `agentes` MCP server (bound to this task) and the mission's rules.
   */
  mission?: { id: string; rules?: string };
}

/** A task as the runner's journal has it (in `hello` and `task.status`). */
export interface RunnerTask {
  taskId: string;
  agentId: string;
  /** `interrupted`: the process is gone without an exit (the machine slept, rebooted or killed it). */
  status: "running" | "done" | "interrupted";
  pid?: number;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  seconds?: number;
  lastLine?: string;
  files?: string[];
}

/** `task.done`: how a task ended. Sent once per task, again after a reconnect until acknowledged. */
export interface TaskDone {
  taskId: string;
  /** Null when there is no exit code (killed by a signal, or interrupted). */
  exitCode: number | null;
  signal?: string | null;
  seconds: number;
  /** The executor's final answer (Claude Code's `result`), or the last lines of output; capped. */
  result?: string;
  lastLine?: string;
  files?: string[];
  /** Ended by `task.cancel`. */
  canceled?: boolean;
  /** Killed after `maxSeconds`. */
  timedOut?: boolean;
  /** The process vanished without an exit (the machine went down): it may be resumed. */
  interrupted?: boolean;
  /** Claude Code's session id, when it reported one. */
  session?: string;
}

/** Largest pieces of task frames (characters / entries); the runner cuts, the server cuts again. */
export const TASK_LIMITS = {
  line: 500,
  files: 50,
  filePath: 300,
  result: 8000,
  tasks: 200,
  /** `task.output`: at most this many lines. */
  outputLines: 200,
  prUrl: 500,
} as const;

export interface RunnerInfo {
  /** Protocol 4: the tasks in the runner's journal (running, and finished ones not yet acknowledged). */
  tasks?: RunnerTask[];
  /** The runner's own version (`0.1.0`). */
  version: string;
  protocol: number;
  os: MachineOs;
  arch: string;
  hostname: string;
  /** Absolute path of the workspace on the machine (shown to admins only). */
  workspace: string;
  /** `false` when started with `--no-exec`: files and uploads only. */
  exec: boolean;
}

export interface FileEntry {
  /** Relative to the workspace. */
  path: string;
  isDir: boolean;
  size: number;
}

/**
 * The agent a request is for (protocol 2+). The runner gives each agent its
 * own folder inside the workspace, `<handle>-<first 8 of id>`, and treats it
 * as that request's workspace; a renamed agent keeps its folder (found by id).
 */
export interface AgentScope {
  id: string;
  handle: string;
}

/** What the server asks. Paths are always relative to the workspace (the agent's folder when `agent` is set). */
export type MachineRequest = (
  | {
      op: "exec";
      command: string;
      /** Relative to the workspace (default: the workspace). */
      cwd?: string;
      timeoutSeconds: number;
      /** Send `output` frames while it runs. */
      stream: boolean;
    }
  | { op: "read"; path: string; maxBytes: number }
  | { op: "write"; path: string; base64: string }
  | { op: "list"; path: string; depth: number }
  | ({ op: "secret" } & SecretRequest)
  | ({ op: "task.start" } & TaskStart)
  /** One task, or all of this agent's when `taskId` is omitted. */
  | { op: "task.status"; taskId?: string }
  | { op: "task.cancel"; taskId: string }
  /** Protocol 6: the last `tail` human lines of a task's output (redacted), as the watcher derives them. */
  | { op: "task.output"; taskId: string; tail: number }
  | {
      op: "push";
      path: string;
      /** Absolute URL of our upload endpoint (`PUT`, machine token as bearer). */
      url: string;
      uploadId: string;
      maxBytes: number;
    }
) & { agent?: AgentScope };

export type MachineOp = MachineRequest["op"];

export const MACHINE_OPS: readonly MachineOp[] = [
  "exec",
  "read",
  "write",
  "list",
  "push",
  "secret",
  "task.start",
  "task.status",
  "task.cancel",
  "task.output",
];

/** What each op answers with `ok: true`. */
export interface MachineReplies {
  exec: { exitCode: number; stdout: string; stderr: string; timedOut: boolean; canceled?: { killed: boolean } };
  /** `base64: null`: no such file. */
  read: { base64: string | null; size: number };
  write: { size: number };
  list: { entries: FileEntry[] };
  /** What was sent: the uploaded name (`report.pdf`, or `folder.zip`), bytes and SHA-256 (hex). */
  push: { name: string; size: number; sha256: string; contentType: string };
  /** `keypair`: the public key (raw P-256, base64); `deliver`: the value's size in bytes. */
  secret: { publicKey?: string; size?: number };
  /** `cwd`: where it runs, relative to the agent's folder (`.worktrees/<taskId>` with a branch). */
  "task.start": { taskId: string; pid: number; startedAt: string; cwd: string; branch?: string; command: string };
  "task.status": { tasks: RunnerTask[] };
  /** `false`: it had already ended. */
  "task.cancel": { canceled: boolean };
  /** Oldest first; `truncated`: the log had more than was read. */
  "task.output": { lines: string[]; truncated: boolean };
}

/** Error codes the runner reports; the message is for people. */
export type MachineErrorCode =
  | "not_found"
  | "outside_workspace"
  | "exec_disabled"
  | "too_large"
  | "upload_failed"
  /** `task.start` beyond the runner's concurrent tasks (`maxConcurrentTasks`). */
  | "no_slot"
  | "bad_request"
  | "internal";

/** Server → runner. */
export type ServerFrame =
  | { type: "welcome"; machineId: string; name: string; heartbeatMs: number }
  | ({ type: "request"; id: string } & MachineRequest)
  | { type: "cancel"; id: string }
  | { type: "ping"; at: number }
  /** The server stored this task's `task.done`: the runner stops re-sending it. */
  | { type: "task.ack"; taskId: string }
  /** Protocol 5: the answer to an `mcp.call` (the text the executor's tool call returns). */
  | { type: "mcp.result"; callId: string; ok: true; text: string }
  | { type: "mcp.result"; callId: string; ok: false; error: { code: string; message: string } }
  /** The server closes after sending this (bad token, revoked, outdated runner). */
  | { type: "refused"; reason: "invalid_token" | "revoked" | "outdated" | "replaced"; message: string };

/** Runner → server. */
export type RunnerFrame =
  | ({ type: "hello"; token: string } & RunnerInfo)
  | { type: "output"; id: string; stream: "stdout" | "stderr"; chunk: string }
  | { type: "result"; id: string; ok: true; data: unknown }
  | { type: "result"; id: string; ok: false; error: { code: MachineErrorCode; message: string } }
  | { type: "pong"; at: number }
  /** A task's progress: a human last line, files it touched, or elapsed time (throttled). */
  | {
      type: "task.event";
      taskId: string;
      kind: "line" | "files" | "progress";
      line?: string;
      files?: string[];
      seconds?: number;
      /** Protocol 6: a pull request URL seen in the task's output (`gh pr create`, a tool result). */
      prUrl?: string;
    }
  | ({ type: "task.done" } & TaskDone)
  /**
   * Protocol 5: the executor of a mission task called a tool of the local
   * `agentes` MCP server. The server checks the task belongs to this machine
   * and to a mission, runs the tool and answers `mcp.result`.
   */
  | { type: "mcp.call"; callId: string; taskId: string; tool: string; args: Record<string, unknown> };

/** Largest `mcp.call` arguments (JSON characters). */
export const MCP_ARGS_MAX_CHARS = 64 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isString = (v: unknown): v is string => typeof v === "string";
const cut = (v: unknown, max: number) => (isString(v) ? v.slice(0, max) : undefined);
const fileList = (v: unknown) =>
  Array.isArray(v)
    ? v
        .filter(isString)
        .slice(0, TASK_LIMITS.files)
        .map((p) => p.slice(0, TASK_LIMITS.filePath))
    : undefined;
const finite = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A journal entry from `hello` or `task.status`; null when malformed. */
export function parseRunnerTask(v: unknown): RunnerTask | null {
  if (!isObject(v) || !isString(v.taskId) || !isString(v.agentId) || !isString(v.startedAt)) return null;
  const status = (["running", "done", "interrupted"] as const).find((s) => s === v.status);
  if (!status) return null;
  const exitCode = v.exitCode === null ? null : finite(v.exitCode);
  return {
    taskId: v.taskId.slice(0, 64),
    agentId: v.agentId.slice(0, 64),
    status,
    ...(finite(v.pid) !== undefined ? { pid: finite(v.pid) } : {}),
    startedAt: v.startedAt.slice(0, 40),
    ...(isString(v.endedAt) ? { endedAt: v.endedAt.slice(0, 40) } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(v.signal === null || isString(v.signal) ? { signal: v.signal === null ? null : v.signal.slice(0, 20) } : {}),
    ...(finite(v.seconds) !== undefined ? { seconds: finite(v.seconds) } : {}),
    ...(isString(v.lastLine) ? { lastLine: v.lastLine.slice(0, TASK_LIMITS.line) } : {}),
    ...(fileList(v.files) ? { files: fileList(v.files) } : {}),
  };
}

/** Parses a runner frame (server side); null when it isn't one. */
export function parseRunnerFrame(raw: string): RunnerFrame | null {
  if (raw.length > MAX_FRAME_BYTES) return null;
  let f: unknown;
  try {
    f = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(f)) return null;
  switch (f.type) {
    case "hello":
      if (!isString(f.token) || !isString(f.version) || typeof f.protocol !== "number") return null;
      return {
        type: "hello",
        token: f.token,
        version: f.version.slice(0, 40),
        protocol: f.protocol,
        os: (["linux", "darwin", "windows"] as const).find((o) => o === f.os) ?? "other",
        arch: isString(f.arch) ? f.arch.slice(0, 40) : "",
        hostname: isString(f.hostname) ? f.hostname.slice(0, 200) : "",
        workspace: isString(f.workspace) ? f.workspace.slice(0, 500) : "",
        exec: f.exec !== false,
        ...(Array.isArray(f.tasks)
          ? {
              tasks: f.tasks
                .slice(0, TASK_LIMITS.tasks)
                .map(parseRunnerTask)
                .filter((t): t is RunnerTask => t !== null),
            }
          : {}),
      };
    case "output":
      if (!isString(f.id) || !isString(f.chunk) || (f.stream !== "stdout" && f.stream !== "stderr")) return null;
      return { type: "output", id: f.id, stream: f.stream, chunk: f.chunk };
    case "result":
      if (!isString(f.id)) return null;
      if (f.ok === true) return { type: "result", id: f.id, ok: true, data: f.data };
      if (f.ok === false && isObject(f.error) && isString(f.error.code) && isString(f.error.message)) {
        return {
          type: "result",
          id: f.id,
          ok: false,
          error: { code: f.error.code as MachineErrorCode, message: f.error.message.slice(0, 2000) },
        };
      }
      return null;
    case "pong":
      return typeof f.at === "number" ? { type: "pong", at: f.at } : null;
    case "task.event": {
      if (!isString(f.taskId) || (f.kind !== "line" && f.kind !== "files" && f.kind !== "progress")) return null;
      const line = cut(f.line, TASK_LIMITS.line);
      const files = fileList(f.files);
      const seconds = finite(f.seconds);
      const prUrl = cut(f.prUrl, TASK_LIMITS.prUrl);
      return {
        type: "task.event",
        taskId: f.taskId.slice(0, 64),
        kind: f.kind,
        ...(line !== undefined ? { line } : {}),
        ...(files ? { files } : {}),
        ...(seconds !== undefined ? { seconds } : {}),
        ...(prUrl && /^https?:\/\/\S+$/i.test(prUrl) ? { prUrl } : {}),
      };
    }
    case "task.done": {
      if (!isString(f.taskId)) return null;
      const exitCode = finite(f.exitCode) ?? null;
      const result = cut(f.result, TASK_LIMITS.result);
      const lastLine = cut(f.lastLine, TASK_LIMITS.line);
      const files = fileList(f.files);
      const session = cut(f.session, 64);
      return {
        type: "task.done",
        taskId: f.taskId.slice(0, 64),
        exitCode,
        signal: isString(f.signal) ? f.signal.slice(0, 20) : null,
        seconds: Math.max(0, Math.round(finite(f.seconds) ?? 0)),
        ...(result !== undefined ? { result } : {}),
        ...(lastLine !== undefined ? { lastLine } : {}),
        ...(files ? { files } : {}),
        ...(f.canceled === true ? { canceled: true } : {}),
        ...(f.timedOut === true ? { timedOut: true } : {}),
        ...(f.interrupted === true ? { interrupted: true } : {}),
        ...(session !== undefined ? { session } : {}),
      };
    }
    case "mcp.call": {
      if (!isString(f.callId) || !isString(f.taskId) || !isString(f.tool)) return null;
      const args = isObject(f.args) && !Array.isArray(f.args) ? f.args : {};
      if (JSON.stringify(args).length > MCP_ARGS_MAX_CHARS) return null;
      return {
        type: "mcp.call",
        callId: f.callId.slice(0, 64),
        taskId: f.taskId.slice(0, 64),
        tool: f.tool.slice(0, 64),
        args,
      };
    }
    default:
      return null;
  }
}

/** Parses a server frame (runner side); null when it isn't one. */
export function parseServerFrame(raw: string): ServerFrame | null {
  if (raw.length > MAX_FRAME_BYTES) return null;
  let f: unknown;
  try {
    f = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(f) || !isString(f.type)) return null;
  if (f.type === "request") {
    if (!isString(f.id) || !isString(f.op)) return null;
    if (!MACHINE_OPS.includes(f.op as MachineOp)) return null;
  }
  if ((f.type === "cancel" || f.type === "request") && !isString(f.id)) return null;
  if (f.type === "task.ack" && !isString(f.taskId)) return null;
  if (f.type === "mcp.result" && !isString(f.callId)) return null;
  if (!["welcome", "request", "cancel", "ping", "refused", "task.ack", "mcp.result"].includes(f.type)) return null;
  return f as ServerFrame;
}

/** A pairing code as people type it: 8 letters/digits, dash optional, any case. */
export function normalizePairingCode(code: string) {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

/**
 * The tools of the local `agentes` MCP server a mission task's executor gets
 * (protocol 5, ADR 0029). The runner lists them (`tools/list`) and relays
 * calls; the server validates and runs them, bound to the task's mission.
 */
export interface MissionMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const PLAN_STATUSES = ["todo", "doing", "waiting_you", "done", "dropped"];

export const MISSION_MCP_TOOLS: readonly MissionMcpTool[] = [
  {
    name: "report",
    description:
      "Tell the people in the mission's thread where things stand: a milestone, what you found, what is next. One short paragraph in their language; no internal details (tool names, logs). Use it at milestones, not for every step. pr_url: a pull request you opened.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", minLength: 1, maxLength: 4000 },
        status: { enum: ["working", "blocked", "done"] },
        pr_url: { type: "string", maxLength: 500 },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "update_plan",
    description:
      "Replace the mission's plan: the whole checklist, every time (keep each item's id stable). Statuses: todo, doing, waiting_you (needs a person), done, dropped. People see each change as one line in the thread.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          minItems: 1,
          maxItems: 60,
          items: {
            type: "object",
            properties: {
              id: { type: "string", minLength: 1, maxLength: 40 },
              title: { type: "string", minLength: 1, maxLength: 200 },
              status: { enum: PLAN_STATUSES },
              note: { type: "string", maxLength: 500 },
            },
            required: ["title", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_decision",
    description:
      "Ask the people a product or technical decision as a card with 2 to 4 options. blocking: true when you can't go on without it (then stop and wait; you are resumed with the answer). blocking: false to go on with your recommendation as a provisional decision they review later.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1, maxLength: 500 },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 4,
          items: { type: "string", minLength: 1, maxLength: 200 },
        },
        recommendation: { type: "string", maxLength: 200 },
        why: { type: "string", maxLength: 1000 },
        impact: { type: "string", maxLength: 500 },
        blocking: { type: "boolean" },
      },
      required: ["question", "options", "blocking"],
      additionalProperties: false,
    },
  },
  {
    name: "request_review",
    description:
      "Ask the people to look at something you can show (screens, a prototype, a PR). paths: files in your folder to attach (uploaded to the Drive). Then stop and wait: you are resumed with their answer (approved, or the changes they want).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        summary: { type: "string", maxLength: 4000 },
        pr_url: { type: "string", maxLength: 500 },
        paths: { type: "array", maxItems: 10, items: { type: "string", minLength: 1, maxLength: 300 } },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "request_approval",
    description:
      "Ask a person to approve a merge, a deploy or a rollback before you do it. Never merge, deploy or roll back without an approval. Then stop and wait: you are resumed with the outcome.",
    inputSchema: {
      type: "object",
      properties: {
        action: { enum: ["merge", "deploy", "rollback"] },
        target: { type: "string", minLength: 1, maxLength: 300 },
        detail: { type: "string", maxLength: 1000 },
      },
      required: ["action", "target"],
      additionalProperties: false,
    },
  },
  {
    name: "upload_artifact",
    description:
      "Send a file (or a folder, as a .zip) from your folder to the team's Drive and get its id. The bytes go straight to the Drive.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, maxLength: 300 },
        title: { type: "string", maxLength: 200 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "get_context",
    description:
      "Search what the organization already knows (conversations, decisions, wiki, documents) that this mission's agent may see. Short results.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 500 } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "start_task",
    description:
      "Main session only: start one plan item as its own background session on a new git branch (it runs in parallel in its own worktree). You are told when it ends. Give it everything it needs in prompt.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120 },
        prompt: { type: "string", minLength: 1, maxLength: 20000 },
        branch: { type: "string", minLength: 1, maxLength: 120 },
      },
      required: ["title", "prompt", "branch"],
      additionalProperties: false,
    },
  },
];

/**
 * The first pull (or merge) request URL in a text: GitHub `…/pull/N`,
 * GitLab `…/-/merge_requests/N`. Shared by the runner (task output) and the
 * server (lines, results, the executor's reports).
 */
export function findPullRequestUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = /https:\/\/(?:github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|[\w.-]+\/(?:[\w.-]+\/)+-\/merge_requests\/\d+)/.exec(
    text,
  );
  return m ? m[0].slice(0, TASK_LIMITS.prUrl) : null;
}
