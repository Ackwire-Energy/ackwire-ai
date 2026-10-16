import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type FileEntry,
  MAX_INLINE_FILE_BYTES,
  type MachineErrorCode,
  type MachineReplies,
  type MachineRequest,
  type RunnerFrame,
} from "@agenteschat/adapters/machine-protocol";
import { RunnerError, toMachineError } from "./errors";
import { runCommand } from "./exec";
import { agentWorkspace, isInside, resolveInWorkspace } from "./paths";
import { type FetchLike, pushPath } from "./push";
import { agentSecrets, handleSecret } from "./secrets";
import type { TaskManager } from "./tasks";

export const MAX_CONCURRENT_REQUESTS = 8;
export const MAX_LIST_ENTRIES = 5000;

export interface HandlerContext {
  /** Real path of the workspace folder. */
  workspaceReal: string;
  /** `false`: started with `--no-exec`. */
  exec: boolean;
  /** The machine token (authenticates `push` uploads). */
  token: string;
  fetch?: FetchLike;
  /** Where each agent's secrets live (ADR 0027); without it the machine keeps none. */
  secretsDir?: string;
  /** Background tasks (protocol 4); without it the runner refuses `task.*`. */
  tasks?: TaskManager;
}

export interface RequestScope {
  signal: AbortSignal;
  /** Sends an `output` frame (exec with `stream: true`). */
  output: (stream: "stdout" | "stderr", chunk: string) => void;
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

async function doExec(
  ctx: HandlerContext,
  req: Extract<MachineRequest, { op: "exec" }>,
  scope: RequestScope,
  secrets: Secrets,
) {
  if (!ctx.exec) {
    throw new RunnerError(
      "exec_disabled",
      "Commands are turned off on this computer (the runner was paired with --no-exec)",
    );
  }
  const command = requireString(req.command, "command");
  let cwd = ctx.workspaceReal;
  if (typeof req.cwd === "string" && req.cwd.trim() !== "") {
    const resolved = await resolveInWorkspace(ctx.workspaceReal, req.cwd);
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
  const target = await resolveInWorkspace(ctx.workspaceReal, requested);
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
  const target = await resolveInWorkspace(ctx.workspaceReal, requireString(req.path, "path"));
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
  const first = await resolveInWorkspace(ctx.workspaceReal, requireString(req.path, "path"));
  if (first.rel === "") throw new RunnerError("bad_request", "Can't write over the workspace folder");
  if (!first.exists) await mkdir(path.dirname(first.abs), { recursive: true });
  // Check again now that the parents exist (nothing raced us outside).
  const target = await resolveInWorkspace(ctx.workspaceReal, req.path);
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
  const target = await resolveInWorkspace(ctx.workspaceReal, typeof req.path === "string" ? req.path : "");
  if (!target.exists) return { entries: [] };
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
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      let isDir = item.isDirectory();
      let size = 0;
      let descend = isDir;
      try {
        if (item.isSymbolicLink()) {
          const real = await realpath(childAbs);
          if (!isInside(ctx.workspaceReal, real)) continue; // leaves the workspace
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
      });
    default:
      throw new RunnerError("bad_request", `Unknown op ${(req as { op: string }).op}`);
  }
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
      if (!ctx.exec) {
        throw new RunnerError(
          "exec_disabled",
          "Commands are turned off on this computer (the runner was paired with --no-exec)",
        );
      }
      if (!req.agent) throw new RunnerError("bad_request", "A task belongs to an agent");
      return tasks.start(req.agent, req);
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
    default:
      return String((req as { op: unknown }).op);
  }
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
    const scope: RequestScope = {
      signal: controller.signal,
      output: (stream, chunk) => {
        if (!this.closed && chunk) this.send({ type: "output", id, stream, chunk });
      },
    };
    return this.handler(this.ctx, req, scope)
      .then((data) => {
        if (controller.signal.aborted && req.op !== "exec") {
          this.reply(id, { ok: false, error: { code: "internal", message: "Canceled" } });
        } else {
          this.reply(id, { ok: true, data });
        }
      })
      .catch((err: unknown) => {
        const error = toMachineError(err);
        if (error.code === "internal" && error.message !== "Canceled") this.log(`${req.op} failed: ${error.message}`);
        this.reply(id, { ok: false, error });
      })
      .finally(() => {
        this.inflight.delete(id);
      });
  }

  cancel(id: string) {
    this.inflight.get(id)?.abort();
  }

  /** The connection ended: stop everything, send nothing more. */
  close() {
    this.closed = true;
    for (const c of this.inflight.values()) c.abort();
  }

  private reply(
    id: string,
    r: { ok: true; data: unknown } | { ok: false; error: { code: MachineErrorCode; message: string } },
  ) {
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
