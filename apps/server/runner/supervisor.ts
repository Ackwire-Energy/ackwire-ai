import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { AGENT_WORKER_HOMES } from "@agenteschat/adapters/command-policy";
import {
  type AgentScope,
  HEARTBEAT_MS,
  inRange,
  isObject,
  MAX_FRAME_BYTES,
  type MachineErrorCode,
  type MachineReplies,
  type MachineRequest,
  parseRunnerFrame,
  type RunnerAccess,
  type RunnerFrame,
  type RunnerPause,
  type RunnerTask,
  type ServerFrame,
} from "@agenteschat/adapters/machine-protocol";
import type { AccountGrant } from "./accounts";
import { type AgentUser, readAgentUsers, systemLauncher } from "./agent-users";
import { type BindPolicyOptions, ensureBrowserBindPolicy } from "./browser-bind-policy";
import { backoffDelay } from "./connection";
import { DESKTOP_USE_OPS } from "./desktop";
import { SHOW_MS } from "./desktop-browser";
import { errnoCode, RunnerError, toMachineError } from "./errors";
import type { RequestScope } from "./handlers";
import { readJson, writeJson } from "./json-file";
import { readLines } from "./lines";
import { type FetchLike, UPLOAD_TIMEOUT_MS, uploadUrl } from "./push";
import type { ScopeKind } from "./scope-gate";
import { type ActivatedSecret, activatedSecret, handleSecret } from "./secrets";
import { agentCategorySlice, agentSlice } from "./service";
import type { RelayCount } from "./streams";

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
/**
 * A worker's word that its agent's Chrome is in use on the agent's desktop holds this long; the worker renews
 * it three times as often while it is.
 */
export const BROWSER_LEASE_MS = 90_000;
/** What a request or a click still waiting on a worker hears once the runner stops. */
export const STOPPING = "The runner is stopping. Try again in a minute.";
/** A worker's `browser.traffic` larger than this (bytes, either way) isn't believed. */
const TRAFFIC_DELTA_MAX = 1e12;
/** How many of its processes a worker may have moved a minute (`scope.enter`). */
const SCOPE_ENTERS_PER_MINUTE = 30;
/** A moved process shows in its new slice within this, or the worker hears it didn't. */
const SCOPE_SHOW_MS = 2000;
const SCOPE_POLL_MS = 20;
const SECRET_INSTALL_MS = 20_000;

/** The broker is a child of the root runner home, never of an agent-owned home. */
function secureSecretRoot(home: string, requireRoot = false): string {
  const owner = process.getuid?.();
  if (requireRoot && owner !== 0) throw new RunnerError("internal", "System secret broker requires root");
  const parent = lstatSync(home);
  if (!parent.isDirectory() || (owner !== undefined && parent.uid !== owner) || parent.mode & 0o022)
    throw new RunnerError("internal", "The runner home is not owned securely");
  const root = path.join(home, "secret-broker");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const st = lstatSync(root);
  if (!st.isDirectory() || (owner !== undefined && st.uid !== owner) || st.mode & 0o077)
    throw new RunnerError("internal", "The secret broker is not owned securely");
  return root;
}

/** `busctl` and its answer, without holding the runner while systemd answers. */
const busctl = (args: string[]) =>
  new Promise<{ code: number; output: string }>((resolve) =>
    execFile("/usr/bin/busctl", args, { timeout: 10_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? 1 : 0, output: `${stdout}${stderr}`.trim() }),
    ),
  );

/** What a worker must know about its computer, sent after each hello and when it changes. */
export interface WorkerState {
  access: RunnerAccess;
  paused: RunnerPause;
  limits: { maxConcurrentTasks: number; taskMaxSeconds: number; brainIdleMinutes: number; brainMaxProcesses: number };
  /** People watching or controlling its agent's desktop (root's): its Chrome there isn't idle meanwhile. */
  desktopViewers?: number;
  /** The account its agent thinks with now (null: none): its processes on any other close (`keepAccount`). */
  account?: string | null;
}

/** The agent's desktop as its worker uses it (desktop use, its Chrome): where it runs, never its VNC passwords. */
export type WorkerDesktop = MachineReplies["desktop.session.start"] & { xauthority: string; home: string };

/** What a worker asks for its agent's desktop for: desktop use, or its Chrome there (ADR 0058 §7). */
export type WorkerDesktopUse = "desktop" | "browser";

/** Browser requests that may start the agent's Chrome, whose answers say what they waited on (protocol 27). */
const BROWSER_SETUP_OPS: ReadonlySet<string> = new Set(["browser.act", "browser.batch", "browser.warm"]);

/** The account a request's CLI signs in with: a turn's or route's, or a Claude Code or Codex task's (protocol 31). */
function accountOf(req: MachineRequest): { kind: "claude_code" | "codex"; account: string } | null {
  const cli =
    req.op === "brain.turn" || req.op === "brain.route"
      ? req.kind
      : req.op === "task.start" && (req.executor === "claude" || req.executor === "codex")
        ? req.executor
        : null;
  if (cli === null || !("account" in req) || typeof req.account !== "string" || !req.account) return null;
  return { kind: cli === "codex" ? "codex" : "claude_code", account: req.account };
}

/** What a request the server sent may use its agent's desktop for; null when it may not. */
function desktopUseOf(req: MachineRequest): WorkerDesktopUse | null {
  if (DESKTOP_USE_OPS.has(req.op)) return "desktop";
  return BROWSER_SETUP_OPS.has(req.op) && "desktop" in req && req.desktop === true ? "browser" : null;
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
  | { type: "upload.end"; uploadId: string; contentType: string; name: string; sha256: string }
  /** From the worker: its agent's desktop, started when it isn't running (root's, ADR 0058 §10). */
  | { type: "desktop.ensure"; ensureId: string; use: WorkerDesktopUse }
  /** To the worker: where its agent's desktop runs, or why it can't. */
  | {
      type: "desktop.ensured";
      ensureId: string;
      desktop?: WorkerDesktop;
      error?: { code: MachineErrorCode; message: string };
    }
  /** From the worker: its agent's Chrome is in use on the agent's desktop (`BROWSER_LEASE_MS`). */
  | { type: "browser.desktop" }
  /** To the worker: Browser was clicked on its agent's desktop (`BrowserManager.show`). */
  | { type: "browser.show"; showId: string; agent: AgentScope }
  /** From the worker: Chrome for Testing installs first. */
  | { type: "browser.showing"; showId: string }
  /** From the worker: the agent's Chrome is on its desktop, or why not. */
  | { type: "browser.shown"; showId: string; error?: { code: MachineErrorCode; message: string } }
  /** From the worker: what its agent's Chrome sent and received since it last said (protocol 23). */
  | { type: "browser.traffic"; up: number; down: number }
  /** From the worker: a turn's plan usage (`rate_limit_event`, Codex's rate limits), for the account it thinks with. */
  | { type: "usage"; kind: "claude_code" | "codex"; account: string; info: unknown }
  /** From the worker: its process `pid`, held until the answer, into the agent's slice for `kind` (`scope-gate.ts`). */
  | { type: "scope.enter"; enterId: string; pid: number; kind: ScopeKind }
  /** To the worker: it is there, or why not (it starts where it is either way). */
  | { type: "scope.entered"; enterId: string; error?: string }
  | { type: "secret.install"; installId: string; agent: AgentScope; secret: ActivatedSecret }
  | {
      type: "secret.installed";
      installId: string;
      size?: number;
      superseded?: boolean;
      error?: { code: MachineErrorCode; message: string };
    };

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
  /** Real system installation: refuse to start the broker without root. Tests use in-memory workers. */
  requireRootBroker?: boolean;
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
  /**
   * System mode: apply socket bind policy to every persisted UID before restoring or serving workers
   * (`prepareAgents`: an agent whose check fails is left out, never the whole boot).
   */
  prepareExisting?: (users: AgentUser[]) => void;
  /** A brain turn's account folder becomes its agent's user's before the turn reaches the worker (`AccountManager.lendTo`). */
  lend?: (kind: "claude_code" | "codex", accountId: string, uid: number) => Promise<unknown>;
  /**
   * Protocol 29: what a brain turn or route on an account root keeps gets with it (`AccountManager.grant`); null for
   * one whose folder is lent instead.
   */
  grant?: (kind: "claude_code" | "codex", accountId: string) => Promise<AccountGrant | null>;
  /** A turn's plan usage, for its account (`AccountManager.noteRateLimit`, `noteCodexRateLimits`). */
  usage?: (kind: "claude_code" | "codex", accountId: string, info: unknown) => void;
  /** The agent's desktop for its worker (`DesktopSessions`), behind the switches `use` needs; without it a worker gets none. */
  desktop?: (agent: AgentScope, use: WorkerDesktopUse) => Promise<WorkerDesktop>;
  /** How many people watch or control the agent's desktop (`DesktopSessions.status`). */
  desktopViewers?: (agentId: string) => number;
  /** The account an agent thinks with now, still on this computer (the agents frame); null: none. */
  account?: (agentId: string) => string | null;
  /** Tests: the clock of the browser's lease. */
  now?: () => number;
  /** Tests: how long a click on Browser waits for its worker (`SHOW_MS`). */
  showMs?: number;
  /** What root relayed, `relayed.json` (the live view of the agents' browsers is counted here). */
  relayed?: RelayCount;
  /** Tests: where processes are read (`/proc`), and how systemd is asked to move one. */
  proc?: string;
  busctl?: (args: string[]) => Promise<{ code: number; output: string }>;
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
  installs: Map<string, { settle(value: MachineReplies["secret"] | RunnerError): void }>;
  /** Clicks on Browser on its agent's desktop it is answering, by the id this side gave them. */
  shows: Map<string, Show>;
  /** When it last said its agent's Chrome is in use on the agent's desktop. */
  browserLeaseAt: number;
  /** When it asked for its processes to be moved, in the last minute (`scope.enter`). */
  enters: number[];
}

interface Show {
  agent: AgentScope;
  installing(): void;
  settle(error?: RunnerError): void;
}

export class Supervisor {
  private readonly workers = new Map<string, Worker>();
  private readonly owners = new Map<string, { agentId: string; startedAt: string }>();
  /** `mcp.call` / `mcp.list` in flight → the worker that asked. */
  private readonly calls = new Map<string, Worker>();
  /** Open `browser.handoff`s, for a worker that says hello later. */
  private readonly handoffs = new Map<string, Handoff>();
  private online = false;
  /** The server runs each `mcp.call` once per `callId` (its `welcome`): the workers' welcome says so too. */
  private mcpOnce = false;
  private closed = false;
  private seq = 0;
  private readonly secretRoot: string;
  private pinger: ReturnType<typeof setInterval> | null = null;
  /** What the workers said their agents' Chromes sent and received, not taken yet (protocol 23). */
  private traffic = { up: 0, down: 0 };

  /** The connection's MCP side: answers go back to the worker that asked. */
  readonly mcp = {
    attach: (_send: unknown, server: { mcpOnce?: boolean } = {}) => {
      this.mcpOnce = server.mcpOnce === true;
    },
    detach: () => {},
    result: (frame: Extract<ServerFrame, { type: "mcp.result" }>) => this.toCaller(frame),
    tools: (frame: Extract<ServerFrame, { type: "mcp.tools" }>) => this.toCaller(frame),
  };

  constructor(private readonly opts: SupervisorOptions) {
    this.secretRoot = secureSecretRoot(opts.home, opts.requireRootBroker);
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
    // Browser ports are guarded for the entire UID range before any worker can bind.
    this.opts.guard?.start();
    const users = readAgentUsers(this.opts.home);
    this.opts.prepareExisting?.(users);
    for (const agentId of new Set([...this.owners.values()].map((o) => o.agentId))) {
      const user = users.find((u) => u.id === agentId);
      if (user) this.launch(this.entry(user));
    }
    this.pinger = setInterval(() => {
      for (const w of this.workers.values()) this.send(w, { type: "ping", at: Date.now() });
    }, WORKER_PING_MS);
    this.pinger.unref?.();
  }

  /**
   * An `agent` op (`OP_ROUTES`), run in the worker of the request's agent. A browser request that waited for that
   * worker to start (its user made first, for a new agent) says how long in its answer's `setup.worker`.
   */
  async run(sent: MachineRequest, scope: RequestScope): Promise<unknown> {
    // A grant is root's alone to give: never one the server put in the request.
    const { grant: _forged, ...clean } = sent as MachineRequest & { grant?: unknown };
    const req = clean as MachineRequest;
    if (!req.agent) throw new RunnerError("bad_request", "This request belongs to an agent");
    if (this.closed) throw new RunnerError("dropped", STOPPING);
    const now = this.opts.now ?? Date.now;
    const since = now();
    const cold = BROWSER_SETUP_OPS.has(req.op) && this.workers.get(String(req.agent.id))?.ready !== true;
    const w = this.entry(this.opts.user(req.agent));
    let grant: AccountGrant | null = null;
    // Its turn, route or Claude Code/Codex task gets the account root keeps with it, or reads the account's folder
    // as the agent's user; a folder it can't have is `account_missing` there.
    const signIn = accountOf(req);
    if (signIn) {
      const { kind, account } = signIn;
      const failed = (err: unknown) =>
        this.opts.log(
          `[${w.user.user}] couldn't hand it its account: ${err instanceof Error ? err.message : String(err)}`,
        );
      grant = (await this.opts.grant?.(kind, account).catch(failed)) ?? null;
      if (!grant) await this.opts.lend?.(kind, account, w.user.uid).catch(failed);
    }
    await this.ready(w, scope.signal);
    if (!w.ready) throw new RunnerError("internal", "The agent's worker isn't connected right now. Try again.");
    if (req.op === "task.start") this.own(req.taskId, w);
    const worker = cold ? Math.round(now() - since) : 0;
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
          if (!outcome.ok) reject(outcome.error);
          else if (worker < 10 || !isObject(outcome.data)) resolve(outcome.data);
          else {
            const setup = isObject(outcome.data.setup) ? outcome.data.setup : {};
            resolve({ ...outcome.data, setup: { ...setup, worker } });
          }
        },
      };
      w.inflight.set(id, entry);
      scope.signal.addEventListener("abort", onAbort, { once: true });
      this.send(w, { ...req, type: "request", id, ...(grant ? { grant } : {}) } as ServerFrame);
    });
  }

  /** The root-owned pre-commit store; the worker receives a value only after activation. */
  async secret(req: Extract<MachineRequest, { op: "secret" }>, scope: RequestScope): Promise<MachineReplies["secret"]> {
    if (!req.agent) throw new RunnerError("bad_request", "Secrets belong to an agent");
    if (this.closed) throw new RunnerError("internal", STOPPING);
    const w = this.entry(this.opts.user(req.agent));
    if (req.action === "discard" || req.action === "keypair")
      return handleSecret(this.secretRoot, req.agent, this.opts.home, req, { storageOnly: true });
    if (req.action === "remove") {
      if (!req.throughOrder && !req.requestIds?.length)
        throw new RunnerError("bad_request", "Secret removal needs a delivery generation cutoff");
      await this.ready(w, scope.signal);
      // The server does not mark a removal committed unless the live worker cleared it.
      await this.run(req, scope);
      return handleSecret(this.secretRoot, req.agent, this.opts.home, req, { storageOnly: true });
    }
    const result = await handleSecret(this.secretRoot, req.agent, this.opts.home, req, { storageOnly: true });
    if (req.action !== "activate" || result.superseded) return result;
    await this.ready(w, scope.signal);
    const secret = await activatedSecret(this.secretRoot, req.agent, req.requestId);
    if (!secret) throw new RunnerError("not_found", "This request has no activated secret");
    return this.install(w, req.agent, secret, scope.signal);
  }

  private install(
    w: Worker,
    agent: AgentScope,
    secret: ActivatedSecret,
    signal: AbortSignal,
  ): Promise<MachineReplies["secret"]> {
    const installId = String(++this.seq);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (value: MachineReplies["secret"] | RunnerError) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        w.installs.delete(installId);
        if (value instanceof RunnerError) reject(value);
        else resolve(value);
      };
      const abort = () => finish(new RunnerError("internal", "Canceled"));
      const timer = setTimeout(
        () => finish(new RunnerError("internal", "The agent's worker did not install the secret in time")),
        SECRET_INSTALL_MS,
      );
      w.installs.set(installId, { settle: finish });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) return abort();
      this.write(w, { type: "secret.install", installId, agent, secret });
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

  /** The computer's pause, access or limits, or who watches an agent's desktop, may have changed. */
  stateChanged() {
    for (const w of this.workers.values()) this.sendState(w);
  }

  /**
   * Whether the agent's Chrome is in use on its desktop, as its worker last said: the desktop doesn't stop as
   * idle under it. The agent's own code could say so too, which keeps only its own desktop, inside its slice.
   */
  onDesktopInUse(agentId: string): boolean {
    const w = this.workers.get(agentId);
    return !!w?.proc && (this.opts.now ?? Date.now)() - w.browserLeaseAt < BROWSER_LEASE_MS;
  }

  /**
   * Browser clicked on the agent's desktop (`desktop-browser.ts`): its worker, started when it isn't running,
   * brings the agent's Chrome there, and gets the desktop from root meanwhile (`desktop.ensure`).
   */
  async showBrowser(agent: AgentScope, installing: () => void): Promise<void> {
    if (this.closed) throw new RunnerError("internal", STOPPING);
    const w = this.entry(this.opts.user(agent));
    await this.ready(w, new AbortController().signal);
    if (!w.ready) throw new RunnerError("internal", "The agent's worker isn't connected right now. Try again.");
    const showId = String(++this.seq);
    await new Promise<void>((resolve, reject) => {
      // The agent's own code can stop its worker (same user): past the launcher's own wait the click is over, and
      // root lends it the desktop no longer.
      const late = setTimeout(
        () => w.shows.get(showId)?.settle(new RunnerError("internal", "The agent's worker didn't answer in time")),
        this.opts.showMs ?? SHOW_MS,
      );
      w.shows.set(showId, {
        agent,
        installing,
        settle: (error) => {
          if (!w.shows.delete(showId)) return;
          clearTimeout(late);
          if (error) reject(error);
          else resolve();
        },
      });
      this.send(w, { type: "browser.show", showId, agent });
    });
  }

  /** What the agents' Chromes sent and received since the last call, as their workers said (protocol 23). */
  takeTraffic(): { up: number; down: number } {
    const total = this.traffic;
    this.traffic = { up: 0, down: 0 };
    return total;
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
      for (const waiter of [...w.waiters]) waiter.reject(new RunnerError("dropped", STOPPING));
      w.ready = false;
      this.endSession(w, STOPPING);
      this.endShows(w, STOPPING);
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
        installs: new Map(),
        shows: new Map(),
        browserLeaseAt: 0,
        enters: [],
      };
      this.workers.set(user.id, w);
    }
    return w;
  }

  /** Waits for the worker's session, starting the worker when it isn't running. */
  private ready(w: Worker, signal: AbortSignal): Promise<void> {
    if (w.ready) return Promise.resolve();
    if (signal.aborted) return Promise.reject(new RunnerError("internal", "Canceled"));
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
      // After it waits: a start that fails at once tells it why.
      this.launch(w);
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
      const why = err instanceof Error ? err.message : String(err);
      this.opts.log(`couldn't start the worker of ${w.user.user}: ${why}`);
      // What waits for it learns why now, not from the start's timeout.
      const failed = new RunnerError("internal", `The agent's worker couldn't start on this computer: ${why}`);
      for (const waiter of [...w.waiters]) waiter.reject(failed);
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
    w.browserLeaseAt = 0;
    this.endSession(
      w,
      "The agent's worker on this computer stopped while this ran: it may have stopped partway or finished. Check before running it again.",
    );
    this.endShows(w, "The agent's worker stopped on this computer. Try again.");
    w.attempt = Date.now() - w.startedAt >= WORKER_STABLE_MS ? 0 : w.attempt + 1;
    w.notBefore = w.attempt > 0 ? Date.now() + backoffDelay(w.attempt - 1) : 0;
    if (this.closed) return;
    this.opts.log(`[${w.user.user}] stopped${typeof code === "number" ? ` (exit ${code})` : ""}`);
    // The live view of its agent's browser went with it: the server would otherwise keep a stream nothing sends.
    if (this.online) this.opts.send({ type: "browser.stream.ended", agentId: w.user.id, reason: "closed" });
    if (w.waiters.size > 0 || [...this.owners.values()].some((o) => o.agentId === w.user.id)) this.launch(w);
  }

  /**
   * Whatever the worker's last session ran is gone: its requests fail, its calls go nowhere. `dropped`: the
   * server waits for the computer and resumes an agent's turn instead of failing it.
   */
  private endSession(w: Worker, message: string) {
    for (const e of [...w.inflight.values()]) e.settle({ ok: false, error: new RunnerError("dropped", message) });
    for (const install of [...w.installs.values()]) install.settle(new RunnerError("internal", message));
    for (const [callId, caller] of this.calls) if (caller === w) this.calls.delete(callId);
  }

  /** The worker is gone: the clicks it was answering fail. Not with its session, which follows the server's. */
  private endShows(w: Worker, message: string) {
    for (const s of [...w.shows.values()]) s.settle(new RunnerError("internal", message));
  }

  private send(w: Worker, frame: ServerFrame | WorkerLinkFrame) {
    if (w.ready) this.write(w, frame);
  }

  /** To the worker's process, also between two of its sessions. */
  private write(w: Worker, frame: ServerFrame | WorkerLinkFrame) {
    if (!w.proc) return;
    if (w.proc.stdin.writableLength > WORKER_BACKLOG_MAX) {
      this.opts.log(`[${w.user.user}] isn't reading what it is sent; stopping it`);
      w.proc.kill();
      return;
    }
    const line = `${JSON.stringify(frame)}\n`;
    if (frame.type === "request" && frame.op === "browser.input" && this.opts.relayed) {
      this.opts.relayed.browserView.down += Buffer.byteLength(line);
    }
    w.proc.stdin.write(line);
  }

  private welcome(w: Worker) {
    this.send(w, {
      type: "welcome",
      machineId: w.user.id,
      name: w.user.user,
      heartbeatMs: HEARTBEAT_MS,
      ...(this.mcpOnce ? { mcpOnce: true } : {}),
    });
    const handoff = this.handoffs.get(w.user.id);
    if (handoff) this.send(w, handoff);
  }

  /** The worker sees only its own agent's folders, who watches its own agent's desktop and its account. */
  private sendState(w: Worker) {
    if (!w.ready) return;
    const s = this.opts.state();
    const folders = s.access.folders.filter((f) => f.agents.includes(w.user.id));
    const viewers = this.opts.desktopViewers?.(w.user.id) ?? 0;
    const frame: WorkerLinkFrame = {
      type: "worker.state",
      ...s,
      access: { ...s.access, folders },
      ...(viewers > 0 ? { desktopViewers: viewers } : {}),
      ...(this.opts.account ? { account: this.opts.account(w.user.id) } : {}),
    };
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
      if (frame) this.frame(w, frame, line);
      else this.linkFrame(w, line);
    } catch (err) {
      this.opts.log(`[${w.user.user}] a frame failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private frame(w: Worker, f: RunnerFrame, line: string) {
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
        if (f.agentId === w.user.id && this.opts.send(f) && f.type === "browser.frame" && this.opts.relayed) {
          this.opts.relayed.browserView.up += Buffer.byteLength(line);
        }
        return;
      default:
        // `pong`, and the computer's own frames (pause, access, accounts): never a worker's.
        return;
    }
  }

  /** A new session of the worker: whatever the last one ran is gone (the worker aborted it). */
  private hello(w: Worker) {
    this.endSession(w, "The agent's worker started over. Try again.");
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
    let f: Record<string, unknown> | null;
    try {
      f = JSON.parse(line) as Record<string, unknown> | null;
    } catch {
      return;
    }
    // A click's answer may come between two of the worker's sessions (they follow the server's): its id is this
    // side's own, so no other click's answer can pass for it.
    if (f?.type === "browser.showing" || f?.type === "browser.shown") {
      const show = w.shows.get(typeof f.showId === "string" ? f.showId : "");
      if (!show) return;
      if (f.type === "browser.showing") return show.installing();
      const error = f.error as { code?: unknown; message?: unknown } | undefined;
      return show.settle(
        error
          ? new RunnerError(
              typeof error.code === "string" ? (error.code as MachineErrorCode) : "internal",
              typeof error.message === "string" ? error.message.slice(0, 500) : "The browser didn't open",
            )
          : undefined,
      );
    }
    // So may the desktop its Chrome asks for: unanswered, the click would hang, and the agent's browser commands
    // behind it.
    if (f?.type === "desktop.ensure") {
      const use = f.use === "browser" ? "browser" : "desktop";
      return this.ensureDesktop(w, typeof f.ensureId === "string" ? f.ensureId : "", use);
    }
    // Its processes start held until this is answered, between its sessions too.
    if (f?.type === "scope.enter") {
      const enterId = typeof f.enterId === "string" ? f.enterId.slice(0, 64) : "";
      void this.enterScope(w, f.pid, f.kind).then((error) =>
        this.write(w, { type: "scope.entered", enterId, ...(error ? { error } : {}) }),
      );
      return;
    }
    // Counted whenever it comes: the worker's Chrome ran between its sessions too.
    if (f?.type === "browser.traffic") {
      if (inRange(f.up, [0, TRAFFIC_DELTA_MAX]) && inRange(f.down, [0, TRAFFIC_DELTA_MAX])) {
        this.traffic.up += f.up;
        this.traffic.down += f.down;
      }
      return;
    }
    if (f?.type === "secret.installed") {
      const id = typeof f.installId === "string" ? f.installId : "";
      const install = w.installs.get(id);
      if (!install) return;
      const error = f.error as { code?: unknown; message?: unknown } | undefined;
      if (error)
        install.settle(
          new RunnerError(
            typeof error.code === "string" ? (error.code as MachineErrorCode) : "internal",
            typeof error.message === "string" ? error.message.slice(0, 500) : "Secret installation failed",
          ),
        );
      else
        install.settle({
          ...(typeof f.size === "number" ? { size: f.size } : {}),
          ...(f.superseded === true ? { superseded: true } : {}),
        });
      return;
    }
    if (!w.ready) return;
    if (f?.type === "browser.desktop") {
      w.browserLeaseAt = (this.opts.now ?? Date.now)();
      return;
    }
    // Only for the account a turn this worker runs now thinks with.
    if (f?.type === "usage") {
      const kind = f.kind === "codex" ? "codex" : "claude_code";
      const account = typeof f.account === "string" ? f.account : "";
      const ours = [...w.inflight.values()].some(
        (e) =>
          e.req.op === "brain.turn" && e.req.account === account && (e.req.kind === "codex") === (kind === "codex"),
      );
      if (account && ours) this.opts.usage?.(kind, account, f.info);
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

  /**
   * The worker's agent's desktop, only while it serves a request the server sent it that uses the desktop that
   * way (desktop use, or a browser command the server put on the desktop), or, for its Chrome, a click on Browser
   * on that desktop (`showBrowser`): the agent's own code runs as the worker's user and could ask at any other time.
   * Between two of the worker's sessions only a click is answered: what the last session ran is over.
   */
  private ensureDesktop(w: Worker, ensureId: string, use: WorkerDesktopUse) {
    const reply = (r: { desktop: WorkerDesktop } | { error: { code: MachineErrorCode; message: string } }) =>
      this.write(w, { type: "desktop.ensured", ensureId, ...r });
    const agent =
      [...w.inflight.values()].find((e) => desktopUseOf(e.req) === use)?.req.agent ??
      (use === "browser" ? [...w.shows.values()][0]?.agent : undefined);
    if (!agent || !this.opts.desktop) {
      const message =
        use === "desktop"
          ? "No desktop use request of this agent is running"
          : "No browser command of this agent on its desktop is running";
      reply({ error: { code: "not_allowed", message } });
      return;
    }
    this.opts.desktop(agent, use).then(
      (desktop) => reply({ desktop }),
      (err: unknown) => reply({ error: toMachineError(err) }),
    );
  }

  /**
   * `scope.enter`: a process of the worker's agent, already in that agent's slice, goes into the agent's
   * slice for its kind (`agentCategorySlice`), named from the worker's uid and never from the frame, where the
   * Cloud's guard counts its traffic apart. The worst a worker can do here is mislabel its own agent's bytes.
   * Answered once the process shows there; otherwise with why not.
   */
  private async enterScope(w: Worker, pid: unknown, kind: unknown): Promise<string | undefined> {
    if (kind !== "browser" && kind !== "cli") return "The kind is browser or cli";
    if (!inRange(pid, [2, 2 ** 22])) return "That isn't a process id";
    const now = (this.opts.now ?? Date.now)();
    w.enters = w.enters.filter((at) => at > now - 60_000);
    if (w.enters.length >= SCOPE_ENTERS_PER_MINUTE) return "Too many processes moved this minute";
    w.enters.push(now);
    const { uid } = w.user;
    const read = (file: string) =>
      readFile(path.join(this.opts.proc ?? "/proc", String(pid), file), "utf8").catch(() => "");
    const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(await read("status"));
    if (!ids || ids.slice(1).some((id) => Number(id) !== uid)) return "That isn't this agent's process";
    const agentDir = `/agents.slice/${agentSlice(uid)}/`;
    const cgroup = async () => /^0::(\/.*)$/m.exec(await read("cgroup"))?.[1] ?? "";
    if (!(await cgroup()).startsWith(agentDir)) return "That process isn't in this agent's slice";
    const slice = agentCategorySlice(uid, kind);
    const asked = await (this.opts.busctl ?? busctl)([
      "call",
      "--timeout=5",
      "org.freedesktop.systemd1",
      "/org/freedesktop/systemd1",
      "org.freedesktop.systemd1.Manager",
      "StartTransientUnit",
      "ssa(sv)a(sa(sv))",
      `agentes-${kind}-${uid}-${pid}.scope`,
      "fail",
      "3",
      "PIDs",
      "au",
      "1",
      String(pid),
      "Slice",
      "s",
      slice,
      "CollectMode",
      "s",
      "inactive-or-failed",
      "0",
    ]);
    if (asked.code !== 0) {
      this.opts.log(`[${w.user.user}] couldn't move a process into ${slice}: ${asked.output.slice(0, 300)}`);
      return "systemd didn't move it";
    }
    for (let waited = 0; waited <= SCOPE_SHOW_MS; waited += SCOPE_POLL_MS) {
      if ((await cgroup()).startsWith(`${agentDir}${slice}/`)) return undefined;
      await new Promise((r) => setTimeout(r, SCOPE_POLL_MS));
    }
    return "It didn't show in its slice in time";
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

/**
 * Pre-broker keys were readable by the agent UID. They cannot be trusted for
 * a later committed delivery, even if copied into a root directory: the
 * agent may already have copied or changed them. Retire them before the new
 * worker starts. Active values in store.json remain available to the agent.
 * Linux /proc/self/fd pins both agent-owned parent directories, so a symlink
 * swap cannot redirect root's rename into another tree.
 */
export function retireLegacyPending(
  base: string,
  home: string,
  user: AgentUser,
  afterRetire?: (name: string, attempt: number) => void,
): void {
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    throw new RunnerError("internal", "Retiring legacy secrets requires root on Linux");
  const baseStat = lstatSync(base);
  if (!baseStat.isDirectory() || baseStat.uid !== 0 || baseStat.mode & 0o022)
    throw new RunnerError("internal", "The worker home base is not owned securely");
  const quarantine = path.join(base, ".legacy-secret-quarantine");
  mkdirSync(quarantine, { mode: 0o700, recursive: true });
  const qst = lstatSync(quarantine);
  if (!qst.isDirectory() || qst.uid !== 0 || qst.mode & 0o077)
    throw new RunnerError("internal", "The legacy secret quarantine is not owned securely");
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let secretsFd: number;
  try {
    secretsFd = openSync(path.join(home, "secrets"), flags);
  } catch (err) {
    if (errnoCode(err) === "ENOENT") return;
    throw err;
  }
  try {
    const id8 = user.user.slice(3);
    if (!/^[a-z0-9]{8}$/.test(id8)) throw new RunnerError("internal", "Invalid agent user");
    let agentFd: number;
    try {
      agentFd = openSync(`/proc/self/fd/${secretsFd}/${id8}`, flags);
    } catch (err) {
      if (errnoCode(err) === "ENOENT") return;
      throw err;
    }
    try {
      for (const name of ["keys", "staged"]) {
        // An agent that continually recreates this directory makes startup
        // fail closed. No new broker key is ever written under this home.
        for (let attempt = 0; attempt < 3; attempt++) {
          const source = `/proc/self/fd/${agentFd}/${name}`;
          const retired = path.join(quarantine, randomUUID());
          try {
            renameSync(source, retired);
          } catch (err) {
            if (errnoCode(err) === "ENOENT") break;
            throw err;
          }
          afterRetire?.(name, attempt);
          const retiredFd = openSync(retired, flags);
          try {
            for (const entry of readdirSync(retired)) {
              if (entry === "." || entry === "..") continue;
              const file = `/proc/self/fd/${retiredFd}/${entry}`;
              const item = lstatSync(file);
              if (item.isDirectory()) throw new RunnerError("internal", "Legacy pending secrets contain a directory");
              unlinkSync(file);
            }
          } finally {
            closeSync(retiredFd);
          }
          rmdirSync(retired);
          if (attempt === 2) {
            try {
              lstatSync(source);
              throw new RunnerError("internal", "Legacy pending secrets were recreated during startup");
            } catch (err) {
              if (errnoCode(err) !== "ENOENT") throw err;
            }
          }
        }
      }
    } finally {
      closeSync(agentFd);
    }
  } finally {
    closeSync(secretsFd);
  }
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

/** Starts each agent's worker as a process (`runner`: how this runner starts itself), its bind check passed first. */
export function launchWorker(runner: string[], policy: BindPolicyOptions, base = AGENT_WORKER_HOMES): StartWorker {
  return (user) => {
    ensureBrowserBindPolicy(user, runner, policy);
    const home = workerHome(base, user);
    retireLegacyPending(base, home, user);
    const { argv, cwd, env } = workerCommand(user, runner, home);
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
