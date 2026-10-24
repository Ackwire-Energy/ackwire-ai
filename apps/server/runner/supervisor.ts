import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { chmodSync, chownSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { AGENT_WORKER_HOMES } from "@agenteschat/adapters/command-policy";
import {
  type AgentScope,
  HEARTBEAT_MS,
  MAX_FRAME_BYTES,
  type MachineRequest,
  parseRunnerFrame,
  type RunnerAccess,
  type RunnerFrame,
  type RunnerPause,
  type RunnerTask,
  type ServerFrame,
} from "@agenteschat/adapters/machine-protocol";
import { type AgentUser, readAgentUsers, systemLauncher } from "./agent-users";
import { backoffDelay } from "./connection";
import { RunnerError } from "./errors";
import type { RequestScope } from "./handlers";
import { readJson, writeJson } from "./json-file";
import { readLines } from "./lines";
import { type FetchLike, UPLOAD_TIMEOUT_MS, uploadUrl } from "./push";

/**
 * System mode (`install.sh --system`): this root process keeps the server's
 * socket and runs no agent work. Each agent's work runs in its worker
 * (`worker.ts`), as the agent's own OS user, started through its launcher on
 * the agent's first request. The link to a worker carries the machine
 * protocol as JSON lines, this side playing the server, plus a few frames of
 * its own (`WorkerLinkFrame`).
 *
 * A worker runs as the uid the agent's own code runs as, so everything it
 * sends is taken as that agent's: results and output only for requests sent
 * to it, `brain.*` only for its turns, `task.*` only for its tasks, browser
 * frames only for its agent, and never the computer's own frames (pause,
 * access, accounts). Uploads go out from here, with the machine token no
 * worker ever holds, to the server's own request's upload on the server this
 * computer is paired with.
 *
 * Worker sessions follow the server's: when the socket drops, theirs end too
 * (what they ran is aborted, as in a single runner) and they say hello again,
 * to be welcomed once the server is back.
 */

/**
 * `<supervisor home>/worker-tasks.json`: whose each background task is, until
 * the server acknowledges its end. Root's, so no worker can claim another
 * agent's task.
 */
export const WORKER_TASKS_FILE = "worker-tasks.json";
/** How long a worker may take to say hello once started. */
const WORKER_START_TIMEOUT_MS = 20_000;
/** A worker that ran this long before it stopped starts again without a wait. */
const WORKER_STABLE_MS = 60_000;
/** Pings keep each worker's session alive; well inside its watchdog (two heartbeats). */
const WORKER_PING_MS = 10_000;
/** A worker that leaves this much of what was sent to it unread is stopped. */
const WORKER_BACKLOG_MAX = 64 * 1024 * 1024;
/** A `push`'s bytes cross the link in pieces of this size. */
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;
/** A task the server never acknowledged is forgotten after this long. */
const TASK_OWNER_KEEP_MS = 8 * 24 * 3600_000;

/** What a worker must know about its computer, sent after each hello and when it changes. */
export interface WorkerState {
  access: RunnerAccess;
  paused: RunnerPause;
  limits: { maxConcurrentTasks: number; taskMaxSeconds: number; brainIdleMinutes: number; brainMaxProcesses: number };
}

/** The link's own frames, besides the machine protocol's. */
export type WorkerLinkFrame =
  /** To the worker. */
  | ({ type: "worker.state" } & WorkerState)
  /** To the worker: its session ends (the server's did); it dials again and says hello. */
  | { type: "worker.close" }
  /** To the worker: how its upload went (the server's status and body), or why it didn't go. */
  | { type: "upload.reply"; uploadId: string; status?: number; body?: string; error?: string }
  /** From the worker: a piece of a `push`'s bytes (base64). */
  | { type: "upload.chunk"; uploadId: string; data: string }
  /** From the worker: every piece was sent; upload them. */
  | { type: "upload.end"; uploadId: string; contentType: string; name: string; sha256: string };

/** A started worker (a process; tests: in-memory pipes). */
export interface WorkerProcess {
  stdin: Writable;
  stdout: Readable;
  stderr?: Readable;
  /** Settles once it has exited, or failed to start. */
  exited: Promise<unknown>;
  kill(): void;
}

export type StartWorker = (user: AgentUser) => WorkerProcess;

export interface SupervisorOptions {
  /** The supervisor's own home (`agents.json`, `worker-tasks.json`). */
  home: string;
  /** The agent's OS user, made on its first request (`AgentUsers.ensure`). */
  user: (agent: AgentScope) => AgentUser;
  /** Starts an agent's worker (`launchWorker`). */
  start: StartWorker;
  /** The machine token, for uploads. */
  token: string;
  /** The server this computer is paired with: the only place uploads go (`uploadUrl`). */
  server: string;
  /** A frame for the server; false while it is offline. */
  send: (frame: RunnerFrame) => boolean;
  state: () => WorkerState;
  log: (line: string) => void;
  fetch?: FetchLike;
  /** System mode: the loopback firewall (root), started with the supervisor. Absent in single-user and in tests. */
  guard?: { start(): void; stop(): void };
  /** A brain turn's account folder becomes its agent's user's before the turn reaches the worker (`AccountManager.lendTo`). */
  lend?: (kind: "claude_code" | "codex", accountId: string, uid: number) => Promise<unknown>;
}

type Outcome = { ok: true; data: unknown } | { ok: false; error: RunnerError };
type Push = Extract<MachineRequest, { op: "push" }>;
type ByCall = Extract<ServerFrame, { type: "mcp.result" | "mcp.tools" }>;
type Handoff = Extract<ServerFrame, { type: "browser.handoff" }>;

interface Inflight {
  req: MachineRequest;
  scope: RequestScope;
  settle(outcome: Outcome): void;
  /** `push`: the bytes the worker sent for it; uploaded once. */
  upload?: { parts: Buffer[]; size: number; sent: boolean };
}

interface Worker {
  user: AgentUser;
  proc: WorkerProcess | null;
  /** Its current session said hello: frames and requests can go to it. */
  ready: boolean;
  /** The `worker.state` line this session last got. */
  state: string;
  startedAt: number;
  /** Stops in a row soon after starting (the backoff). */
  attempt: number;
  notBefore: number;
  timer: ReturnType<typeof setTimeout> | null;
  waiters: Set<{ resolve(): void; reject(err: RunnerError): void }>;
  /** Requests sent to it, by the id this side gave them. */
  inflight: Map<string, Inflight>;
}

export class Supervisor {
  private readonly workers = new Map<string, Worker>();
  private readonly owners = new Map<string, { agentId: string; startedAt: string }>();
  /** `mcp.call` / `mcp.list` in flight → the worker that asked. */
  private readonly calls = new Map<string, Worker>();
  /** Open `browser.handoff`s, for a worker that says hello later. */
  private readonly handoffs = new Map<string, Handoff>();
  private online = false;
  private closed = false;
  private seq = 0;
  private pinger: ReturnType<typeof setInterval> | null = null;

  /** The connection's MCP side: answers go back to the worker that asked. */
  readonly mcp = {
    attach: () => {},
    detach: () => {},
    result: (frame: Extract<ServerFrame, { type: "mcp.result" }>) => this.toCaller(frame),
    tools: (frame: Extract<ServerFrame, { type: "mcp.tools" }>) => this.toCaller(frame),
  };

  constructor(private readonly opts: SupervisorOptions) {
    const saved = readJson<Record<string, { agentId?: unknown; startedAt?: unknown } | null>>(this.ownersFile);
    const cutoff = Date.now() - TASK_OWNER_KEEP_MS;
    for (const [taskId, o] of Object.entries(saved ?? {})) {
      if (typeof o?.agentId !== "string" || typeof o.startedAt !== "string") continue;
      if (Date.parse(o.startedAt) > cutoff) this.owners.set(taskId, { agentId: o.agentId, startedAt: o.startedAt });
    }
  }

  private get ownersFile() {
    return path.join(this.opts.home, WORKER_TASKS_FILE);
  }

  /** Starts the workers whose tasks need watching, and the pings. */
  boot() {
    const users = readAgentUsers(this.opts.home);
    for (const agentId of new Set([...this.owners.values()].map((o) => o.agentId))) {
      const user = users.find((u) => u.id === agentId);
      if (user) this.launch(this.entry(user));
    }
    this.pinger = setInterval(() => {
      for (const w of this.workers.values()) this.send(w, { type: "ping", at: Date.now() });
    }, WORKER_PING_MS);
    this.pinger.unref?.();
    this.opts.guard?.start();
  }

  /** An `agent` op (`OP_ROUTES`), run in the worker of the request's agent. */
  async run(req: MachineRequest, scope: RequestScope): Promise<unknown> {
    if (!req.agent) throw new RunnerError("bad_request", "This request belongs to an agent");
    if (this.closed) throw new RunnerError("internal", "The runner is stopping; try again in a minute");
    const w = this.entry(this.opts.user(req.agent));
    // Its turn reads the account's folder as the agent's user; a folder it can't have is `account_missing` there.
    if (req.op === "brain.turn" && typeof req.account === "string" && req.account && this.opts.lend) {
      await this.opts
        .lend(req.kind === "codex" ? "codex" : "claude_code", req.account, w.user.uid)
        .catch((err: unknown) =>
          this.opts.log(
            `[${w.user.user}] couldn't hand it its account: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }
    await this.ready(w, scope.signal);
    if (!w.ready) throw new RunnerError("internal", "The agent's worker isn't connected right now; try again");
    if (req.op === "task.start") this.own(req.taskId, w);
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      const onAbort = () => this.send(w, { type: "cancel", id });
      const entry: Inflight = {
        req,
        scope,
        settle: (outcome) => {
          if (w.inflight.get(id) !== entry) return;
          w.inflight.delete(id);
          scope.signal.removeEventListener("abort", onAbort);
          if (outcome.ok) resolve(outcome.data);
          else reject(outcome.error);
        },
      };
      w.inflight.set(id, entry);
      scope.signal.addEventListener("abort", onAbort, { once: true });
      this.send(w, { ...req, type: "request", id });
    });
  }

  /**
   * `hello.tasks`: every task a worker started that the server hasn't seen
   * end, whether its worker runs or not. All as `running`: the server keeps
   * them, and learns how each ended from its `task.done`, which its worker
   * sends again until acknowledged.
   */
  list(): RunnerTask[] {
    return [...this.owners].map(([taskId, o]) => ({
      taskId,
      agentId: o.agentId,
      status: "running" as const,
      startedAt: o.startedAt,
    }));
  }

  /** The server welcomed this computer: so are the workers' sessions. */
  attach() {
    this.online = true;
    for (const w of this.workers.values()) if (w.ready) this.welcome(w);
  }

  /** The server's socket is gone: the workers' sessions end too. */
  detach() {
    this.online = false;
    this.handoffs.clear();
    for (const w of this.workers.values()) {
      if (!w.ready) continue;
      this.send(w, { type: "worker.close" });
      w.ready = false;
      this.endSession(w, "The computer lost its connection to agentes.chat");
    }
  }

  /** `task.ack`: to the task's worker, or kept until it can be told (its worker sends `task.done` again). */
  ack(taskId: string) {
    const owner = this.owners.get(taskId);
    const w = owner ? this.workers.get(owner.agentId) : undefined;
    if (!w?.ready) return;
    this.send(w, { type: "task.ack", taskId });
    this.disown(taskId);
  }

  /** `browser.handoff`: to the agent's worker, and kept for a session that says hello later. */
  handoff(frame: Handoff) {
    if (frame.handoff) this.handoffs.set(frame.agentId, frame);
    else this.handoffs.delete(frame.agentId);
    const w = this.workers.get(frame.agentId);
    if (w && this.online) this.send(w, frame);
  }

  /** The computer's pause, access or limits may have changed. */
  stateChanged() {
    for (const w of this.workers.values()) this.sendState(w);
  }

  /** The session is over: workers' stdin closes (they finish and exit), and the ones still there after `graceMs` are killed. */
  async close(graceMs = 5000) {
    this.closed = true;
    if (this.pinger) clearInterval(this.pinger);
    this.opts.guard?.stop();
    const exits: Promise<unknown>[] = [];
    for (const w of this.workers.values()) {
      if (w.timer) clearTimeout(w.timer);
      w.timer = null;
      const stopping = "The runner is stopping; try again in a minute";
      for (const waiter of [...w.waiters]) waiter.reject(new RunnerError("internal", stopping));
      w.ready = false;
      this.endSession(w, stopping);
      if (!w.proc) continue;
      w.proc.stdin.end();
      exits.push(w.proc.exited);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all(exits), new Promise((r) => (timer = setTimeout(r, graceMs)))]);
    clearTimeout(timer);
    for (const w of this.workers.values()) w.proc?.kill();
  }

  // ── Workers ────────────────────────────────────────────────────────────────

  private entry(user: AgentUser): Worker {
    let w = this.workers.get(user.id);
    if (!w) {
      w = {
        user,
        proc: null,
        ready: false,
        state: "",
        startedAt: 0,
        attempt: 0,
        notBefore: 0,
        timer: null,
        waiters: new Set(),
        inflight: new Map(),
      };
      this.workers.set(user.id, w);
    }
    return w;
  }

  /** Waits for the worker's session, starting the worker when it isn't running. */
  private ready(w: Worker, signal: AbortSignal): Promise<void> {
    if (w.ready) return Promise.resolve();
    if (signal.aborted) return Promise.reject(new RunnerError("internal", "Canceled"));
    this.launch(w);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          done();
          resolve();
        },
        reject: (err: RunnerError) => {
          done();
          reject(err);
        },
      };
      const late = () =>
        waiter.reject(new RunnerError("internal", "The agent's worker didn't start on this computer in time"));
      const timer = setTimeout(late, WORKER_START_TIMEOUT_MS);
      const abort = () => waiter.reject(new RunnerError("internal", "Canceled"));
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        w.waiters.delete(waiter);
      };
      w.waiters.add(waiter);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  /** Starts the worker now, or once its backoff ends; nothing when it runs or a start is set. */
  private launch(w: Worker) {
    if (this.closed || w.proc || w.timer) return;
    const wait = w.notBefore - Date.now();
    if (wait > 0) {
      w.timer = setTimeout(() => {
        w.timer = null;
        this.launch(w);
      }, wait);
      return;
    }
    w.startedAt = Date.now();
    let proc: WorkerProcess;
    try {
      proc = this.opts.start(w.user);
    } catch (err) {
      this.opts.log(`couldn't start the worker of ${w.user.user}: ${err instanceof Error ? err.message : String(err)}`);
      this.stopped(w, null);
      return;
    }
    w.proc = proc;
    const tag = `[${w.user.user}]`;
    // A broken pipe ends in the worker's exit, handled below.
    proc.stdin.on("error", () => {});
    proc.stdout.on("error", () => {});
    proc.stderr?.on("error", () => {});
    readLines(
      proc.stdout,
      MAX_FRAME_BYTES + 1024,
      (line) => this.fromWorker(w, proc, line),
      () => {
        this.opts.log(`${tag} sent a line longer than a frame; stopping it`);
        proc.kill();
      },
    );
    if (proc.stderr) {
      readLines(
        proc.stderr,
        16 * 1024,
        (line) => this.opts.log(`${tag} ${line}`),
        () => this.opts.log(`${tag} (a log line too long was left out)`),
      );
    }
    const slow = setTimeout(() => {
      if (w.proc !== proc || w.ready) return;
      this.opts.log(`${tag} didn't say hello in time; stopping it`);
      proc.kill();
    }, WORKER_START_TIMEOUT_MS);
    slow.unref?.();
    void proc.exited.then((code) => {
      clearTimeout(slow);
      this.stopped(w, proc, code);
    });
  }

  /** The worker exited: what it ran fails, and it starts again after a backoff when it has tasks or requests waiting. */
  private stopped(w: Worker, proc: WorkerProcess | null, code?: unknown) {
    if (proc && w.proc !== proc) return;
    w.proc = null;
    w.ready = false;
    this.endSession(w, "The agent's worker stopped on this computer; try again");
    w.attempt = Date.now() - w.startedAt >= WORKER_STABLE_MS ? 0 : w.attempt + 1;
    w.notBefore = w.attempt > 0 ? Date.now() + backoffDelay(w.attempt - 1) : 0;
    if (this.closed) return;
    this.opts.log(`[${w.user.user}] stopped${typeof code === "number" ? ` (exit ${code})` : ""}`);
    if (w.waiters.size > 0 || [...this.owners.values()].some((o) => o.agentId === w.user.id)) this.launch(w);
  }

  /** Whatever the worker's last session ran is gone: its requests fail, its calls go nowhere. */
  private endSession(w: Worker, message: string) {
    for (const e of [...w.inflight.values()]) e.settle({ ok: false, error: new RunnerError("internal", message) });
    for (const [callId, caller] of this.calls) if (caller === w) this.calls.delete(callId);
  }

  private send(w: Worker, frame: ServerFrame | WorkerLinkFrame) {
    if (!w.ready || !w.proc) return;
    if (w.proc.stdin.writableLength > WORKER_BACKLOG_MAX) {
      this.opts.log(`[${w.user.user}] isn't reading what it is sent; stopping it`);
      w.proc.kill();
      return;
    }
    w.proc.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private welcome(w: Worker) {
    this.send(w, { type: "welcome", machineId: w.user.id, name: w.user.user, heartbeatMs: HEARTBEAT_MS });
    const handoff = this.handoffs.get(w.user.id);
    if (handoff) this.send(w, handoff);
  }

  /** The worker sees only its own agent's folders. */
  private sendState(w: Worker) {
    if (!w.ready) return;
    const s = this.opts.state();
    const folders = s.access.folders.filter((f) => f.agents.includes(w.user.id));
    const frame: WorkerLinkFrame = { type: "worker.state", ...s, access: { ...s.access, folders } };
    const line = JSON.stringify(frame);
    if (line === w.state) return;
    w.state = line;
    this.send(w, frame);
  }

  // ── Frames from workers ────────────────────────────────────────────────────

  private fromWorker(w: Worker, proc: WorkerProcess, line: string) {
    if (w.proc !== proc) return;
    try {
      const frame = parseRunnerFrame(line);
      if (frame) this.frame(w, frame);
      else this.linkFrame(w, line);
    } catch (err) {
      this.opts.log(`[${w.user.user}] a frame failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private frame(w: Worker, f: RunnerFrame) {
    if (f.type === "hello") return this.hello(w);
    if (!w.ready) return;
    switch (f.type) {
      case "result": {
        const e = w.inflight.get(f.id);
        if (!e) return;
        // Refused by the worker: that task never started.
        if (!f.ok && e.req.op === "task.start") this.disown(e.req.taskId);
        e.settle(
          f.ok ? { ok: true, data: f.data } : { ok: false, error: new RunnerError(f.error.code, f.error.message) },
        );
        return;
      }
      case "output":
        w.inflight.get(f.id)?.scope.output(f.stream, f.chunk);
        return;
      case "brain.event":
      case "brain.done":
        for (const e of w.inflight.values()) {
          if (e.req.op === "brain.turn" && e.req.runId === f.runId) return e.scope.emit?.(f);
        }
        return;
      case "task.event":
      case "task.done":
        if (this.owners.get(f.taskId)?.agentId === w.user.id) this.opts.send(f);
        return;
      case "mcp.call":
      case "mcp.list": {
        // Without the run's token the server takes the frame's task id as proof of whose call it is; here only
        // the token can be, since a worker speaks for its own agent and task ids on a shared computer aren't secret.
        if (f.type === "mcp.call" && !f.token) {
          this.send(w, {
            type: "mcp.result",
            callId: f.callId,
            ok: false,
            error: { code: "not_allowed", message: "This computer runs agentes tools only with the server's token" },
          });
          return;
        }
        const caller = this.calls.get(f.callId);
        if (caller && caller !== w) return;
        if (this.opts.send(f)) this.calls.set(f.callId, w);
        return;
      }
      case "browser.frame":
      case "browser.stream.ended":
        if (f.agentId === w.user.id) this.opts.send(f);
        return;
      default:
        // `pong`, and the computer's own frames (pause, access, accounts): never a worker's.
        return;
    }
  }

  /** A new session of the worker: whatever the last one ran is gone (the worker aborted it). */
  private hello(w: Worker) {
    this.endSession(w, "The agent's worker started over; try again");
    w.ready = true;
    w.state = "";
    this.sendState(w);
    if (this.online) this.welcome(w);
    for (const waiter of [...w.waiters]) waiter.resolve();
  }

  private toCaller(frame: ByCall) {
    const w = this.calls.get(frame.callId);
    this.calls.delete(frame.callId);
    if (w) this.send(w, frame);
  }

  // ── Tasks ──────────────────────────────────────────────────────────────────

  /** Marks the task as the agent's before it starts (its first frames may come before its result). */
  private own(taskId: unknown, w: Worker) {
    if (typeof taskId !== "string") return; // the worker refuses it
    const known = this.owners.get(taskId);
    if (known?.agentId === w.user.id) return;
    if (known) throw new RunnerError("bad_request", "Duplicate task id");
    this.owners.set(taskId, { agentId: w.user.id, startedAt: new Date().toISOString() });
    this.saveOwners();
  }

  private disown(taskId: unknown) {
    if (typeof taskId === "string" && this.owners.delete(taskId)) this.saveOwners();
  }

  private saveOwners() {
    try {
      writeJson(this.ownersFile, Object.fromEntries(this.owners));
    } catch (err) {
      this.opts.log(`${WORKER_TASKS_FILE}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Uploads ────────────────────────────────────────────────────────────────

  private linkFrame(w: Worker, line: string) {
    if (!w.ready) return;
    let f: Record<string, unknown> | null;
    try {
      f = JSON.parse(line) as Record<string, unknown> | null;
    } catch {
      return;
    }
    if (f?.type !== "upload.chunk" && f?.type !== "upload.end") return;
    const uploadId = typeof f.uploadId === "string" ? f.uploadId : "";
    const e = [...w.inflight.values()].find((x) => x.req.op === "push" && x.req.uploadId === uploadId);
    if (!e) {
      if (f.type === "upload.end") {
        this.send(w, { type: "upload.reply", uploadId, error: "No upload is waiting for these bytes" });
      }
      return;
    }
    const req = e.req as Push;
    e.upload ??= { parts: [], size: 0, sent: false };
    const u = e.upload;
    if (u.sent) return;
    const max = Math.max(0, Math.floor(Number(req.maxBytes) || 0));
    if (f.type === "upload.chunk") {
      const bytes = typeof f.data === "string" ? Buffer.from(f.data, "base64") : Buffer.alloc(0);
      u.size += bytes.length;
      // Past the limit nothing more is kept: the upload is refused at its end.
      if (u.size <= max) u.parts.push(bytes);
      else u.parts = [];
      return;
    }
    u.sent = true;
    const body = Buffer.concat(u.parts);
    u.parts = [];
    const reply =
      u.size > max
        ? Promise.resolve({
            status: 413,
            body: JSON.stringify({ error: { message: `The file is larger than ${max} bytes` } }),
          })
        : this.upload(req, body, f, e.scope.signal);
    void reply.then((r) => this.send(w, { type: "upload.reply", uploadId, ...r }));
  }

  /** To the request's upload on the server this computer is paired with, with the machine token; from the worker only the file's name, type and hash. */
  private async upload(req: Push, body: Buffer, end: Record<string, unknown>, signal: AbortSignal) {
    const target = uploadUrl(this.opts.server, req.url);
    if (!target) return { error: "The upload URL must be http(s)" };
    const doFetch: FetchLike = this.opts.fetch ?? ((url, init) => fetch(url, init));
    const sha256 = typeof end.sha256 === "string" && /^[0-9a-f]{64}$/.test(end.sha256) ? end.sha256 : "";
    try {
      const res = await doFetch(target, {
        method: "PUT",
        body: body as unknown as RequestInit["body"],
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          "content-type":
            typeof end.contentType === "string" && end.contentType ? end.contentType : "application/octet-stream",
          "x-agentes-file-name": typeof end.name === "string" ? end.name : "",
          "x-agentes-sha256": sha256,
          "x-agentes-upload-id": req.uploadId,
        },
        signal: AbortSignal.any([AbortSignal.timeout(UPLOAD_TIMEOUT_MS), signal]),
      });
      return { status: res.status, body: (await res.text().catch(() => "")).slice(0, 4000) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}

// ── Launching ──────────────────────────────────────────────────────────────

/**
 * The worker's home `<base>/<user>`: the agent's own (0700), in a folder only
 * root writes to and nobody else can list (0711), so no agent can plant a
 * link where root makes or opens it.
 */
export function workerHome(base: string, user: AgentUser): string {
  mkdirSync(base, { recursive: true, mode: 0o711 });
  chmodSync(base, 0o711);
  const dir = path.join(base, user.user);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new RunnerError("internal", `${dir} is not a folder`);
  if (st.uid !== user.uid) chownSync(dir, user.uid, st.gid);
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  return dir;
}

/** `agentes-runner worker` for one agent through its launcher (its user, its slice, only its environment). */
export function workerCommand(user: AgentUser, runner: string[], home: string, systemd?: boolean) {
  const l = systemLauncher(user, systemd);
  return {
    argv: [...l.prefix, ...runner, "worker", "--agent", user.id, "--dir", l.home, "--home", home],
    cwd: l.home,
    env: l.env,
  };
}

/** Starts each agent's worker as a process (`runner`: how this runner starts itself). */
export function launchWorker(runner: string[], base = AGENT_WORKER_HOMES): StartWorker {
  return (user) => {
    const { argv, cwd, env } = workerCommand(user, runner, workerHome(base, user));
    const [file = "", ...args] = argv;
    const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const events = child as unknown as EventEmitter;
    const exited = new Promise<unknown>((resolve) => {
      events.once("exit", (code: number | null) => resolve(code));
      events.once("error", (err: Error) => resolve(err));
    });
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited,
      // runuser passes SIGTERM on to the worker.
      kill: () => {
        child.stdin.destroy();
        child.kill("SIGTERM");
      },
    };
  };
}
