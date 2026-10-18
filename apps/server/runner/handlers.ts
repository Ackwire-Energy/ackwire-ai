import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AgentScope,
  type FileEntry,
  MAX_INLINE_FILE_BYTES,
  type MachineErrorCode,
  type MachineReplies,
  type MachineRequest,
  type RunnerAccess,
  type RunnerFrame,
  type RunnerTools,
} from "@agenteschat/adapters/machine-protocol";
import { realFoldersFor } from "./access";
import type { BrainManager } from "./brain";
import { type CodexBrainEvent, type CodexBrainTurnRequest, handleCodexBrainTurn } from "./brain-codex";
import { RunnerError, toMachineError } from "./errors";
import { runCommand } from "./exec";
import type { McpTaskInfo } from "./mcp";
import { agentWorkspace, isInside, resolveForAgent, resolveInWorkspace } from "./paths";
import { type FetchLike, pushPath } from "./push";
import { agentSecrets, handleSecret } from "./secrets";
import type { TaskManager } from "./tasks";

export const MAX_CONCURRENT_REQUESTS = 8;
export const MAX_LIST_ENTRIES = 5000;

/** Ops that start new work: refused while the owner paused the computer (protocol 9). Reads of status, output and cancel still go. */
export const NEW_WORK_OPS: ReadonlySet<string> = new Set([
  "exec",
  "read",
  "write",
  "list",
  "push",
  "task.start",
  "brain.turn",
]);

type AccessRequestOp = Extract<MachineRequest, { op: "access.request" }>;
type AccessReduceOp = Extract<MachineRequest, { op: "access.reduce" }>;

export interface HandlerContext {
  /** Real path of the workspace folder. */
  workspaceReal: string;
  /** `false`: commands off (`--no-exec`, or `access.tools.commands` off). */
  exec: boolean;
  /** The machine token (authenticates `push` uploads). */
  token: string;
  fetch?: FetchLike;
  /** Where each agent's secrets live (ADR 0027); without it the machine keeps none. */
  secretsDir?: string;
  /** Background tasks (protocol 4); without it the runner refuses `task.*`. */
  tasks?: TaskManager;
  /** Brain turns (protocol 8); without it the runner refuses `brain.turn`. */
  brains?: BrainManager;
  /**
   * Codex brain turns (ADR 0032 block 6): the runner home (threads file,
   * scratch), how Codex starts our MCP server, and the live Codex runs the
   * MCP bridge looks up by run id (`agentes-runner mcp --run <runId>`).
   */
  codex?: {
    runnerHome: string;
    mcp?: { socketPath: string; command: string[] };
    runs: Map<string, McpTaskInfo>;
  };
  /** Protocol 9: whether the owner paused this computer (new work is refused with `paused`). */
  paused?: () => boolean;
  /**
   * Protocol 10: what the machine allows. With it, absolute paths inside the
   * agent's allowed folders are accepted and each tool needs to be on;
   * without it, commands, Claude Code and Codex follow `exec` as before.
   */
  access?: () => RunnerAccess;
  /** Protocol 10: `access.request` and `access.reduce` (the daemon keeps the requests and the config). */
  accessOps?: {
    request(agent: AgentScope, req: AccessRequestOp): Promise<MachineReplies["access.request"]>;
    reduce(req: AccessReduceOp): Promise<MachineReplies["access.reduce"]>;
  };
  /** Set per request (protocol 10): the folders allowed for the request's agent, as real paths. */
  grants?: string[];
}

export interface RequestScope {
  signal: AbortSignal;
  /** Sends an `output` frame (exec with `stream: true`). */
  output: (stream: "stdout" | "stderr", chunk: string) => void;
  /** Sends any frame while the request runs (`brain.event`, `brain.done`). */
  emit?: (frame: RunnerFrame) => void;
}

const clampInt = (n: unknown, min: number, max: number, fallback: number) => {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.floor(n) : fallback;
  return Math.max(min, Math.min(max, v));
};

const requireString = (v: unknown, field: string): string => {
  if (typeof v !== "string") throw new RunnerError("bad_request", `${field} must be a string`);
  return v;
};

type Secrets = Awaited<ReturnType<typeof agentSecrets>>;

const TOOL_LABEL: Record<keyof RunnerTools, string> = {
  claude: "Claude Code",
  codex: "Codex",
  commands: "Commands",
};

/** Whether a tool is on: from the machine's access (protocol 10), or `exec` for a runner without it. */
export function toolOn(ctx: Pick<HandlerContext, "access" | "exec">, tool: keyof RunnerTools): boolean {
  return ctx.access ? ctx.access().tools[tool] === true : ctx.exec;
}

function requireTool(ctx: HandlerContext, tool: keyof RunnerTools) {
  if (toolOn(ctx, tool)) return;
  if (!ctx.access) {
    throw new RunnerError(
      "exec_disabled",
      "Commands are turned off on this computer (the runner was paired with --no-exec)",
    );
  }
  const how = `its owner can turn it on in the agentes app (Preferences > Tools) or with agentes-runner tools enable ${tool}`;
  if (tool === "commands") throw new RunnerError("exec_disabled", `Commands are turned off on this computer (${how})`);
  throw new RunnerError("not_allowed", `${TOOL_LABEL[tool]} is turned off on this computer (${how})`);
}

const resolvePath = (ctx: HandlerContext, input: string) => resolveForAgent(ctx.workspaceReal, ctx.grants, input);

async function doExec(
  ctx: HandlerContext,
  req: Extract<MachineRequest, { op: "exec" }>,
  scope: RequestScope,
  secrets: Secrets,
) {
  requireTool(ctx, "commands");
  const command = requireString(req.command, "command");
  let cwd = ctx.workspaceReal;
  if (typeof req.cwd === "string" && req.cwd.trim() !== "") {
    const resolved = await resolvePath(ctx, req.cwd);
    if (!resolved.exists) throw new RunnerError("not_found", `The folder ${req.cwd} doesn't exist`);
    if (!(await stat(resolved.abs)).isDirectory()) throw new RunnerError("bad_request", `${req.cwd} is not a folder`);
    cwd = resolved.abs;
  }
  return runCommand({
    command,
    cwd,
    timeoutSeconds: clampInt(req.timeoutSeconds, 1, 24 * 3600, 60),
    signal: scope.signal,
    onOutput: req.stream === true ? scope.output : undefined,
    ...(secrets ? { env: secrets.env, redact: secrets.redact, redactHold: secrets.hold } : {}),
  });
}

/** A file that holds a secret is only for programs on this machine, never sent out. */
async function refuseSecretFile(ctx: HandlerContext, secrets: Secrets, requested: string) {
  if (!secrets || secrets.files.length === 0) return;
  const target = await resolvePath(ctx, requested);
  for (const file of secrets.files) {
    const held = await resolveInWorkspace(ctx.workspaceReal, file).catch(() => null);
    if (held && (held.abs === target.abs || isInside(target.abs, held.abs))) {
      throw new RunnerError("bad_request", `${requested} holds a secret; it stays on this computer`);
    }
  }
}

async function doRead(
  ctx: HandlerContext,
  req: Extract<MachineRequest, { op: "read" }>,
): Promise<MachineReplies["read"]> {
  const target = await resolvePath(ctx, requireString(req.path, "path"));
  if (!target.exists) return { base64: null, size: 0 };
  const st = await stat(target.abs);
  if (st.isDirectory()) throw new RunnerError("bad_request", `${req.path} is a folder`);
  if (!st.isFile()) throw new RunnerError("bad_request", `${req.path} is not a regular file`);
  const limit = Math.min(
    clampInt(req.maxBytes, 0, MAX_INLINE_FILE_BYTES, MAX_INLINE_FILE_BYTES),
    MAX_INLINE_FILE_BYTES,
  );
  if (st.size > limit) throw new RunnerError("too_large", `The file has ${st.size} bytes (max ${limit})`);
  const data = await readFile(target.abs);
  if (data.byteLength > limit) throw new RunnerError("too_large", `The file is larger than ${limit} bytes`);
  return { base64: data.toString("base64"), size: data.byteLength };
}

async function doWrite(
  ctx: HandlerContext,
  req: Extract<MachineRequest, { op: "write" }>,
): Promise<MachineReplies["write"]> {
  const base64 = requireString(req.base64, "base64");
  if (Math.floor((base64.length * 3) / 4) > MAX_INLINE_FILE_BYTES + 3) {
    throw new RunnerError("too_large", `Files sent inline are limited to ${MAX_INLINE_FILE_BYTES} bytes`);
  }
  const data = Buffer.from(base64, "base64");
  if (data.byteLength > MAX_INLINE_FILE_BYTES) {
    throw new RunnerError("too_large", `Files sent inline are limited to ${MAX_INLINE_FILE_BYTES} bytes`);
  }
  const first = await resolvePath(ctx, requireString(req.path, "path"));
  if (first.rel === "") throw new RunnerError("bad_request", "Can't write over the workspace folder");
  if (!first.exists) await mkdir(path.dirname(first.abs), { recursive: true });
  // Check again now that the parents exist (nothing raced us outside).
  const target = await resolvePath(ctx, req.path);
  if (target.exists && (await stat(target.abs)).isDirectory()) {
    throw new RunnerError("bad_request", `${req.path} is a folder`);
  }
  await writeFile(target.abs, data);
  return { size: data.byteLength };
}

async function doList(
  ctx: HandlerContext,
  req: Extract<MachineRequest, { op: "list" }>,
): Promise<MachineReplies["list"]> {
  const target = await resolvePath(ctx, typeof req.path === "string" ? req.path : "");
  if (!target.exists) return { entries: [] };
  const root = target.root ?? ctx.workspaceReal;
  const st = await stat(target.abs);
  if (!st.isDirectory()) return { entries: [{ path: target.rel, isDir: false, size: st.size }] };
  const depth = clampInt(req.depth, 1, 5, 1);
  const entries: FileEntry[] = [];
  const walk = async (abs: string, rel: string, level: number) => {
    let items: Dirent[];
    try {
      items = await readdir(abs, { withFileTypes: true });
    } catch {
      return; // unreadable folder: skip it
    }
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const item of items) {
      if (entries.length >= MAX_LIST_ENTRIES) return;
      const childAbs = path.join(abs, item.name);
      const childRel = rel ? `${rel.replace(/\/+$/, "")}/${item.name}` : item.name;
      let isDir = item.isDirectory();
      let size = 0;
      let descend = isDir;
      try {
        if (item.isSymbolicLink()) {
          const real = await realpath(childAbs);
          if (!isInside(root, real)) continue; // leaves the workspace (or the allowed folder)
          const s = await stat(real);
          isDir = s.isDirectory();
          size = isDir ? 0 : s.size;
          descend = false; // never follow links while walking (no loops)
        } else if (!isDir) {
          size = (await lstat(childAbs)).size;
        }
      } catch {
        continue; // dangling link or vanished file
      }
      entries.push({ path: childRel, isDir, size });
      if (descend && level < depth) await walk(childAbs, childRel, level + 1);
    }
  };
  await walk(target.abs, target.rel, 1);
  return { entries };
}

/** Runs one request; throws RunnerError (or fs errors) on failure. */
export async function handleRequest(ctx: HandlerContext, req: MachineRequest, scope: RequestScope): Promise<unknown> {
  // Protocol 9: paused by the owner. What already runs finishes; status, output and cancel still answer.
  if (NEW_WORK_OPS.has(req.op) && ctx.paused?.()) {
    throw new RunnerError("paused", "The owner paused this computer; nothing new starts here until it is resumed");
  }
  if (req.op === "access.request" || req.op === "access.reduce") return handleAccess(ctx, req);
  // Protocol 10: the folders this agent may use besides its own.
  if (ctx.access && req.agent) ctx = { ...ctx, grants: await realFoldersFor(ctx.access(), String(req.agent.id)) };
  if (req.op === "task.start" || req.op === "task.status" || req.op === "task.cancel" || req.op === "task.output") {
    return handleTask(ctx, req);
  }
  // Each agent works in its own folder: that folder is its workspace.
  if (req.agent) ctx = { ...ctx, workspaceReal: await agentWorkspace(ctx.workspaceReal, req.agent) };
  if (req.op === "secret") {
    if (!ctx.secretsDir) throw new RunnerError("bad_request", "This runner keeps no secrets");
    return handleSecret(ctx.secretsDir, req.agent, ctx.workspaceReal, req);
  }
  const secrets = await agentSecrets(ctx.secretsDir, req.agent);
  switch (req.op) {
    case "brain.turn":
      return doBrainTurn(ctx, req, scope, secrets);
    case "exec":
      return doExec(ctx, req, scope, secrets);
    case "read":
      await refuseSecretFile(ctx, secrets, requireString(req.path, "path"));
      return doRead(ctx, req);
    case "write":
      return doWrite(ctx, req);
    case "list":
      return doList(ctx, req);
    case "push":
      await refuseSecretFile(ctx, secrets, requireString(req.path, "path"));
      return pushPath({
        workspaceReal: ctx.workspaceReal,
        token: ctx.token,
        path: requireString(req.path, "path"),
        url: requireString(req.url, "url"),
        uploadId: requireString(req.uploadId, "uploadId"),
        maxBytes: clampInt(req.maxBytes, 0, Number.MAX_SAFE_INTEGER, 0),
        fetch: ctx.fetch,
        signal: scope.signal,
        resolve: (p) => resolvePath(ctx, p),
      });
    default:
      throw new RunnerError("bad_request", `Unknown op ${(req as { op: string }).op}`);
  }
}

/** Protocol 10: the agent asks for a folder, or the site reduces what the machine allows. */
async function handleAccess(ctx: HandlerContext, req: AccessRequestOp | AccessReduceOp) {
  if (!ctx.accessOps) throw new RunnerError("bad_request", "This runner keeps no access settings");
  if (req.op === "access.request") {
    if (!req.agent) throw new RunnerError("bad_request", "A folder request belongs to an agent");
    return ctx.accessOps.request(req.agent, req);
  }
  return ctx.accessOps.reduce(req);
}

/**
 * `brain.turn` (protocol 8, ADR 0032): streams `brain.event` frames, the
 * final one included, then `brain.done`; the result repeats the final event.
 */
async function doBrainTurn(
  ctx: HandlerContext,
  req: Extract<MachineRequest, { op: "brain.turn" }>,
  scope: RequestScope,
  secrets: Secrets,
): Promise<MachineReplies["brain.turn"]> {
  requireTool(ctx, req.kind === "codex" ? "codex" : "claude");
  if (!req.agent) throw new RunnerError("bad_request", "A brain turn belongs to an agent");
  const runId = requireString(req.runId, "runId");
  if (req.kind === "codex") return doCodexTurn(ctx, req, scope, runId);
  if (!ctx.brains) throw new RunnerError("bad_request", "This runner runs no brain turns");
  const final = await ctx.brains.turn(req, {
    agent: req.agent,
    folder: ctx.workspaceReal,
    secrets: secrets ? { env: secrets.env, redact: secrets.redact } : null,
    signal: scope.signal,
    emit: (event) => scope.emit?.({ type: "brain.event", runId, event }),
    ...(ctx.grants ? { grants: ctx.grants } : {}),
  });
  scope.emit?.({ type: "brain.done", runId });
  return { runId, final };
}

/**
 * The Codex branch of `brain.turn`: `codex exec --json` per turn
 * (`brain-codex.ts`). While it runs, its MCP server (`mcp --run <runId>`,
 * the run's server token in its env) is relayed for the run.
 */
async function doCodexTurn(
  ctx: HandlerContext,
  req: Extract<MachineRequest, { op: "brain.turn" }>,
  scope: RequestScope,
  runId: string,
): Promise<MachineReplies["brain.turn"]> {
  const codex = ctx.codex;
  if (!codex) throw new RunnerError("bad_request", "This runner runs no Codex brain turns");
  let final: CodexBrainEvent = { type: "error", code: "codex_failed", message: "Codex ended without an answer." };
  let ended = false;
  const token = req.mcp?.token;
  if (req.agent && typeof token === "string" && token) {
    const folder = await agentWorkspace(ctx.workspaceReal, req.agent);
    codex.runs.set(runId, {
      token,
      missionId: "",
      running: true,
      cwd: folder,
      folder,
      runId,
      serverToken: token,
    });
  }
  try {
    await handleCodexBrainTurn(
      {
        workspaceReal: ctx.workspaceReal,
        exec: toolOn(ctx, "codex"),
        runnerHome: codex.runnerHome,
        ...(ctx.secretsDir ? { secretsDir: ctx.secretsDir } : {}),
        ...(codex.mcp ? { mcp: codex.mcp } : {}),
        ...(ctx.grants ? { grants: ctx.grants } : {}),
      },
      req as unknown as CodexBrainTurnRequest,
      {
        signal: scope.signal,
        emit: (event) => {
          if (ended) return;
          if (event.type === "done" || event.type === "error") {
            final = event;
            ended = true;
          }
          scope.emit?.({ type: "brain.event", runId, event });
        },
      },
    );
  } finally {
    codex.runs.delete(runId);
  }
  scope.emit?.({ type: "brain.done", runId });
  return { runId, final };
}

/** Background tasks: the manager finds each agent's folder itself (and keeps it for the task's life). */
function handleTask(
  ctx: HandlerContext,
  req: Extract<MachineRequest, { op: "task.start" | "task.status" | "task.cancel" | "task.output" }>,
) {
  const tasks = ctx.tasks;
  if (!tasks) throw new RunnerError("bad_request", "This runner runs no background tasks");
  switch (req.op) {
    case "task.start":
      requireTool(ctx, req.executor === "claude" ? "claude" : req.executor === "codex" ? "codex" : "commands");
      if (!req.agent) throw new RunnerError("bad_request", "A task belongs to an agent");
      return tasks.start(req.agent, req, ctx.grants ? { grants: ctx.grants } : undefined);
    case "task.status":
      return tasks.status(req.agent, typeof req.taskId === "string" ? req.taskId : undefined);
    case "task.cancel":
      return tasks.cancel(req.agent, requireString(req.taskId, "taskId"));
    case "task.output":
      return tasks.output(req.agent, requireString(req.taskId, "taskId"), Number(req.tail));
  }
}

/** One log line per request: the op and the path or the head of the command, never file contents. */
export function describeRequest(req: MachineRequest): string {
  const who = req.agent ? `[${String(req.agent.handle ?? "")}] ` : "";
  return who + describeOp(req);
}

function describeOp(req: MachineRequest): string {
  switch (req.op) {
    case "exec": {
      const head = String(req.command ?? "")
        .replace(/\s+/g, " ")
        .trim();
      return `exec ${head.length > 80 ? `${head.slice(0, 80)}…` : head}${req.cwd ? ` (in ${req.cwd})` : ""}`;
    }
    case "read":
    case "write":
    case "list":
    case "push":
      return `${req.op} ${String(req.path ?? "") || "."}`;
    case "secret":
      // Never the value: the action and the name or request.
      return `secret ${req.action} ${"name" in req ? req.name : req.requestId}`;
    case "task.start":
      return `task.start ${String(req.taskId ?? "")} (${String(req.executor ?? "")})`;
    case "task.status":
      return `task.status ${String(req.taskId ?? "all")}`;
    case "task.cancel":
      return `task.cancel ${String(req.taskId ?? "")}`;
    case "task.output":
      return `task.output ${String(req.taskId ?? "")}`;
    case "brain.turn":
      return `brain.turn ${String(req.runId ?? "")} (${String(req.kind ?? "")}${req.model ? `, ${String(req.model)}` : ""})`;
    case "access.request":
      return `access.request ${String(req.path ?? "")}`;
    case "access.reduce":
      return `access.reduce${req.removeFolder ? ` folder ${String(req.removeFolder.path ?? "")}` : ""}${req.disableTool ? ` tool ${String(req.disableTool)}` : ""}`;
    default:
      return String((req as { op: unknown }).op);
  }
}

/** How a request ended, for an observer. */
export type RequestOutcome =
  | { ok: true; data: unknown }
  | { ok: false; error: { code: MachineErrorCode; message: string } };

/** Sees every request start and end (the desktop app's jobs and the activity log). */
export interface RequestObserver {
  started(id: string, req: MachineRequest): void;
  finished(id: string, req: MachineRequest, outcome: RequestOutcome): void;
}

/**
 * Runs the requests of one connection concurrently (at most 8), sends their
 * `result` frames, and aborts them on `cancel` or when the connection ends.
 */
export class RequestRunner {
  private readonly inflight = new Map<string, AbortController>();
  private closed = false;

  constructor(
    private readonly ctx: HandlerContext,
    private readonly send: (frame: RunnerFrame) => void,
    private readonly log: (line: string) => void = () => {},
    private readonly handler: typeof handleRequest = handleRequest,
    private readonly maxConcurrent = MAX_CONCURRENT_REQUESTS,
    private readonly observer?: RequestObserver,
  ) {}

  get size() {
    return this.inflight.size;
  }

  /** Starts a request; resolves when its result was sent (tests await it). */
  start(id: string, req: MachineRequest): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.inflight.has(id)) {
      this.reply(id, { ok: false, error: { code: "bad_request", message: "Duplicate request id" } });
      return Promise.resolve();
    }
    if (this.inflight.size >= this.maxConcurrent) {
      this.reply(id, { ok: false, error: { code: "internal", message: "busy" } });
      return Promise.resolve();
    }
    const controller = new AbortController();
    this.inflight.set(id, controller);
    this.log(describeRequest(req));
    this.observe(() => this.observer?.started(id, req));
    const scope: RequestScope = {
      signal: controller.signal,
      output: (stream, chunk) => {
        if (!this.closed && chunk) this.send({ type: "output", id, stream, chunk });
      },
      emit: (frame) => {
        if (this.closed) return;
        try {
          this.send(frame);
        } catch {
          // socket gone
        }
      },
    };
    return this.handler(this.ctx, req, scope)
      .then((data): RequestOutcome => {
        if (controller.signal.aborted && req.op !== "exec") {
          return { ok: false, error: { code: "internal", message: "Canceled" } };
        }
        return { ok: true, data };
      })
      .catch((err: unknown): RequestOutcome => {
        const error = toMachineError(err);
        if (error.code === "internal" && error.message !== "Canceled") this.log(`${req.op} failed: ${error.message}`);
        return { ok: false, error };
      })
      .then((outcome) => {
        this.observe(() => this.observer?.finished(id, req, outcome));
        this.reply(id, outcome);
      })
      .finally(() => {
        this.inflight.delete(id);
      });
  }

  private observe(fn: () => void) {
    try {
      fn();
    } catch {
      // an observer never breaks a request
    }
  }

  cancel(id: string) {
    this.inflight.get(id)?.abort();
  }

  /** The connection ended: stop everything, send nothing more. */
  close() {
    this.closed = true;
    for (const c of this.inflight.values()) c.abort();
  }

  private reply(id: string, r: RequestOutcome) {
    if (this.closed) return;
    try {
      this.send(
        r.ok ? { type: "result", id, ok: true, data: r.data } : { type: "result", id, ok: false, error: r.error },
      );
    } catch {
      // socket gone
    }
  }
}
