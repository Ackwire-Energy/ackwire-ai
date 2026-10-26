import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  type AgentScope,
  MACHINE_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  type MachineErrorCode,
  parseAccess,
  parsePause,
} from "@agenteschat/adapters/machine-protocol";
import { lentAccounts } from "./accounts";
import { BrainManager } from "./brain";
import { CodexAppServers } from "./brain-codex-app";
import { BrowserManager, type BrowserManagerOptions } from "./browser";
import { type Dial, RunnerConnection, type SocketHandlers } from "./connection";
import { DEFAULT_LIMITS, machineOs, prepareWorkspace } from "./daemon";
import { DesktopManager, type DesktopManagerOptions } from "./desktop";
import { RUNNER_VERSION, RunnerError, toMachineError } from "./errors";
import { type HandlerContext, handleRequest } from "./handlers";
import { currentProcess, isCompiled, selfCommand } from "./launch";
import { readLines } from "./lines";
import { McpBridge, type McpTaskInfo, mcpSocketPath } from "./mcp";
import { agentWorkspace } from "./paths";
import type { FetchLike } from "./push";
import { agentSecrets, secretValue } from "./secrets";
import {
  BROWSER_LEASE_MS,
  UPLOAD_CHUNK_BYTES,
  type WorkerDesktop,
  type WorkerDesktopUse,
  type WorkerLinkFrame,
  type WorkerState,
} from "./supervisor";
import { TaskManager } from "./tasks";

/**
 * System mode: one agent's runner (`agentes-runner worker --agent <id>`),
 * started by the root supervisor through the agent's launcher, so all of it
 * runs as the agent's own OS user. The daemon's managers and handlers for
 * that agent only, over a link of JSON lines on stdin/stdout instead of the
 * server's socket (`supervisor.ts`): no pairing, service, tray or machine
 * token. Its home (`--home`: task journal, secrets, git credentials,
 * browser) is outside the agent's own home, its workspace (`--dir`).
 */

export interface WorkerOptions {
  agentId: string;
  /** The worker's own home. */
  home: string;
  /** The agent's home: the workspace its folder is made in. */
  dir: string;
  /** From the supervisor. */
  input: Readable;
  /** To the supervisor. */
  output: Writable;
  log: (line: string) => void;
  /** How this runner starts itself (default: this process). */
  self?: { command: string[]; compiled: boolean };
  /** Tests: the computer desktop use sees, and how its helper starts. */
  desktop?: Pick<DesktopManagerOptions, "system" | "command">;
  /** Tests: how `agent-browser` and Chrome start, and Chrome's debugging endpoint. */
  browser?: Pick<
    BrowserManagerOptions,
    "command" | "chrome" | "startChrome" | "isOurChrome" | "fetch" | "windowDrawMs"
  >;
}

/**
 * Root answers for the agent's desktop within that desktop's start, whose steps each have a limit; an ask it never
 * answers would hold the agent's browser commands behind it.
 */
const DESKTOP_MS = 2 * 60_000;

/** Until the supervisor says otherwise, nothing is allowed. */
const NOTHING_ALLOWED: WorkerState = {
  access: { folders: [], tools: { claude: false, codex: false, commands: false } },
  paused: { paused: false },
  limits: { ...DEFAULT_LIMITS },
};

/** `worker.state` as the supervisor sends it (the config's limits are checked there); null when it isn't one. */
function parseWorkerState(f: Record<string, unknown>): WorkerState | null {
  const access = parseAccess(f.access);
  const paused = parsePause(f.paused);
  const limits = { ...DEFAULT_LIMITS, ...(f.limits as Partial<WorkerState["limits"]>) };
  const viewers = Number.isSafeInteger(f.desktopViewers) ? Math.max(0, f.desktopViewers as number) : 0;
  return access && paused ? { access, paused, limits, desktopViewers: viewers } : null;
}

/**
 * The worker's end of the link. Each dial is one session on the same pipes;
 * `worker.close` ends it (the supervisor's own session with the server
 * ended) and the connection dials again, saying hello.
 */
export class WorkerLink {
  private session: SocketHandlers | null = null;
  private readonly uploads = new Map<string, (reply: Extract<WorkerLinkFrame, { type: "upload.reply" }>) => void>();
  private readonly desktops = new Map<string, (reply: Extract<WorkerLinkFrame, { type: "desktop.ensured" }>) => void>();
  private nextEnsure = 0;
  onState: (state: WorkerState) => void = () => {};
  /** Browser clicked on the agent's desktop, as root relays it: answered with `showing` and `shown`. */
  onShow: (showId: string, agent: AgentScope) => void = () => {};
  /** The supervisor is gone (stdin closed). */
  onEnd: () => void = () => {};

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly desktopMs = DESKTOP_MS,
  ) {
    readLines(
      input,
      MAX_FRAME_BYTES + 1024,
      (line) => this.line(line),
      () => {},
    );
    input.once("end", () => this.ended());
    input.once("close", () => this.ended());
  }

  private ended() {
    this.unanswered("The runner is stopping; try again in a minute");
    this.onEnd();
  }

  /** Desktops still asked for fail when the session or the link ends, as the work that asked for them does. */
  private unanswered(message: string) {
    for (const answer of [...this.desktops.values()]) {
      answer({ type: "desktop.ensured", ensureId: "", error: { code: "internal", message } });
    }
  }

  readonly dial: Dial = (_url, handlers) => {
    this.session = handlers;
    queueMicrotask(() => handlers.onOpen());
    return {
      send: (data) => this.write(data),
      close: () => this.end(handlers),
    };
  };

  private end(handlers: SocketHandlers | null) {
    if (!handlers || this.session !== handlers) return;
    this.session = null;
    this.unanswered("The computer lost its connection to agentes.chat");
    queueMicrotask(() => handlers.onClose(1000, ""));
  }

  private write(data: string) {
    this.output.write(`${data}\n`);
  }

  private line(line: string) {
    let f: Record<string, unknown> | null = null;
    try {
      f = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (f?.type) {
      case "worker.close":
        this.end(this.session);
        return;
      case "worker.state": {
        const state = parseWorkerState(f);
        if (state) this.onState(state);
        return;
      }
      case "upload.reply":
        if (typeof f.uploadId === "string") this.uploads.get(f.uploadId)?.(f as never);
        return;
      case "desktop.ensured":
        if (typeof f.ensureId === "string") this.desktops.get(f.ensureId)?.(f as never);
        return;
      case "browser.show": {
        const agent = f.agent as Partial<AgentScope> | undefined;
        if (typeof f.showId === "string" && typeof agent?.id === "string" && typeof agent.handle === "string") {
          this.onShow(f.showId, agent as AgentScope);
        }
        return;
      }
      default:
        this.session?.onMessage(line);
    }
  }

  /** Chrome for Testing installs first, for that click. */
  showing(showId: string) {
    this.write(JSON.stringify({ type: "browser.showing", showId } satisfies WorkerLinkFrame));
  }

  /** The agent's Chrome is on its desktop, or why it isn't. */
  shown(showId: string, error?: { code: MachineErrorCode; message: string }) {
    this.write(
      JSON.stringify({ type: "browser.shown", showId, ...(error ? { error } : {}) } satisfies WorkerLinkFrame),
    );
  }

  /**
   * The agent's desktop (root's, ADR 0058 §10), started when it isn't running: the supervisor answers only
   * while this worker serves a request that uses it that way.
   */
  desktop(use: WorkerDesktopUse): Promise<WorkerDesktop> {
    const ensureId = String(++this.nextEnsure);
    return new Promise((resolve, reject) => {
      const late = setTimeout(() => {
        const error = { code: "internal" as const, message: "The agent's desktop didn't start in time" };
        this.desktops.get(ensureId)?.({ type: "desktop.ensured", ensureId, error });
      }, this.desktopMs);
      this.desktops.set(ensureId, (reply) => {
        clearTimeout(late);
        this.desktops.delete(ensureId);
        if (reply.desktop) resolve(reply.desktop);
        else reject(new RunnerError(reply.error?.code ?? "internal", reply.error?.message ?? "No desktop"));
      });
      this.write(JSON.stringify({ type: "desktop.ensure", ensureId, use } satisfies WorkerLinkFrame));
    });
  }

  /** Its agent's Chrome is in use on the agent's desktop: root doesn't stop that desktop as idle for a while. */
  browserOnDesktop() {
    this.write(JSON.stringify({ type: "browser.desktop" } satisfies WorkerLinkFrame));
  }

  /**
   * `push` without the machine token: the bytes go to the supervisor in
   * pieces, it uploads them to the request's URL and says how that went.
   */
  readonly fetch: FetchLike = (_url, init) => {
    const headers = new Headers(init.headers as Record<string, string>);
    const uploadId = headers.get("x-agentes-upload-id") ?? "";
    const body = init.body instanceof Uint8Array ? init.body : new Uint8Array();
    const signal = init.signal ?? undefined;
    return new Promise<Response>((resolve, reject) => {
      const done = () => {
        this.uploads.delete(uploadId);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        done();
        reject(signal?.reason instanceof Error ? signal.reason : new Error("Canceled"));
      };
      this.uploads.set(uploadId, (reply) => {
        done();
        const status = reply.status ?? 0;
        if (typeof reply.error === "string") reject(new Error(reply.error));
        else resolve(new Response(reply.body ?? "", { status: status >= 200 && status <= 599 ? status : 502 }));
      });
      signal?.addEventListener("abort", abort, { once: true });
      for (let at = 0; at < body.byteLength; at += UPLOAD_CHUNK_BYTES) {
        const data = Buffer.from(body.subarray(at, at + UPLOAD_CHUNK_BYTES)).toString("base64");
        this.write(JSON.stringify({ type: "upload.chunk", uploadId, data } satisfies WorkerLinkFrame));
      }
      this.write(
        JSON.stringify({
          type: "upload.end",
          uploadId,
          contentType: headers.get("content-type") ?? "",
          name: headers.get("x-agentes-file-name") ?? "",
          sha256: headers.get("x-agentes-sha256") ?? "",
        } satisfies WorkerLinkFrame),
      );
    });
  };
}

/** Runs the worker until the supervisor goes away; its background tasks keep running (ADR 0029). */
export async function runWorker(o: WorkerOptions): Promise<number> {
  const { home, log } = o;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const workspaceReal = prepareWorkspace(o.dir);
  const self = o.self ?? { command: selfCommand(currentProcess()), compiled: isCompiled(currentProcess()) };
  const secretsDir = path.join(home, "secrets");
  const socketPath = mcpSocketPath(home);
  const mcpCommand = { socketPath, command: self.command };
  let state = NOTHING_ALLOWED;
  const tasks = new TaskManager({
    mcp: mcpCommand,
    root: path.join(home, "tasks"),
    workspaceReal,
    maxConcurrent: state.limits.maxConcurrentTasks,
    defaultMaxSeconds: state.limits.taskMaxSeconds,
    log,
    agentFolder: (agent) => agentWorkspace(workspaceReal, agent),
    secrets: (agent) => agentSecrets(secretsDir, agent),
    ...(self.compiled ? { wrapperCommand: [...self.command, "task-wrapper"] } : {}),
  });
  await tasks.init();
  const brainLimits = () => ({
    idleMs: state.limits.brainIdleMinutes * 60_000,
    maxProcesses: state.limits.brainMaxProcesses,
  });
  // The account folders root lends to this agent's user for its turns (`AccountManager.lendTo`).
  const accounts = lentAccounts();
  const brains = new BrainManager({
    root: path.join(home, "brains"),
    mcp: mcpCommand,
    accounts,
    ...brainLimits(),
    log,
  });
  const codexRuns = new Map<string, McpTaskInfo>();
  const codexApp = new CodexAppServers({ runs: codexRuns, ...brainLimits(), log });
  const mcp = new McpBridge({
    socketPath,
    task: (taskId) => tasks.mcpTask(taskId) ?? brains.mcpTask(taskId) ?? codexRuns.get(taskId) ?? null,
    log,
  });
  await mcp
    .listen()
    .catch((err: unknown) => log(`mission tools unavailable: ${err instanceof Error ? err.message : String(err)}`));
  const link = new WorkerLink(o.input, o.output);
  let live: RunnerConnection | null = null;
  // The desktop is root's: this worker's helper and Chrome run on it as the agent's own user, where root says.
  let desktop: WorkerDesktop | null = null;
  const ensureDesktop = (use: WorkerDesktopUse) => async () => {
    desktop = await link.desktop(use);
    return desktop;
  };
  // Root doesn't stop the desktop as idle while the agent's Chrome on it is in use: said after each change and
  // renewed well within the lease.
  const lease = () => {
    if (browser.onDesktopInUse(o.agentId)) link.browserOnDesktop();
  };
  const browser = new BrowserManager({
    home,
    log,
    send: (frame) => live?.send(frame) ?? false,
    secret: (agent, name) => secretValue(secretsDir, agent, name),
    desktops: {
      ensure: ensureDesktop("browser"),
      session: () => desktop,
      status: () => ({ running: desktop !== null, streams: state.desktopViewers ?? 0 }),
    },
    onChange: () => queueMicrotask(lease),
    ...o.browser,
  });
  const leases = setInterval(lease, BROWSER_LEASE_MS / 3);
  leases.unref?.();
  void browser.closeAll();
  link.onShow = (showId, agent) => {
    const shown =
      agent.id === o.agentId
        ? agentWorkspace(workspaceReal, agent).then((folder) => browser.show(agent, folder, () => link.showing(showId)))
        : Promise.reject(new RunnerError("not_allowed", "This worker serves another agent"));
    shown.then(
      () => link.shown(showId),
      (err: unknown) => link.shown(showId, toMachineError(err)),
    );
  };
  const own = process.getuid?.() ?? null;
  const desktopUse = new DesktopManager({
    desktops: {
      // Root's hello says whether the computer can; a worker reports nothing.
      info: () => ({ available: true }),
      ensure: ensureDesktop("desktop"),
      session: () => desktop,
    },
    uids: () => (own === null ? null : { runner: 0, agents: new Map([[o.agentId, own]]) }),
    secrets: (agent) => agentSecrets(secretsDir, agent),
    browserPid: (agentId) => browser.chromePid(agentId),
    log,
    ...o.desktop,
  });
  const context: HandlerContext = {
    workspaceReal,
    get exec() {
      return state.access.tools.commands;
    },
    token: "",
    fetch: link.fetch,
    secretsDir,
    gitDir: path.join(home, "git"),
    tasks,
    brains,
    codex: { runnerHome: home, mcp: mcpCommand, runs: codexRuns, app: codexApp, accounts },
    paused: () => state.paused.paused,
    access: () => state.access,
    browser,
    desktopUse,
  };
  const connection = new RunnerConnection({
    url: "supervisor",
    token: "",
    info: () => ({
      version: RUNNER_VERSION,
      protocol: MACHINE_PROTOCOL_VERSION,
      os: machineOs(),
      arch: os.arch(),
      hostname: os.hostname(),
      workspace: workspaceReal,
      exec: state.access.tools.commands,
    }),
    context,
    mcp,
    log,
    dial: link.dial,
    handler: (ctx, req, scope) =>
      req.agent?.id === o.agentId
        ? handleRequest(ctx, req, scope)
        : Promise.reject(new RunnerError("not_allowed", "This worker serves another agent")),
    onBrowserHandoff: (frame) => browser.setHandoff(frame.agentId, frame.handoff),
    onState: (s) => {
      if (s === "online") return;
      browser.stopStreams();
      browser.clearHandoffs();
    },
  });
  live = connection;
  link.onState = (next) => {
    const browserOff = state.access.tools.browser === true && next.access.tools.browser !== true;
    // Desktop use needs both switches: its helpers stop with either.
    const use = (s: WorkerState) => s.access.tools.desktop === true && s.access.tools.commands;
    if (use(state) && !use(next)) desktopUse.stopAll();
    state = next;
    tasks.setLimits({ maxConcurrent: next.limits.maxConcurrentTasks, defaultMaxSeconds: next.limits.taskMaxSeconds });
    brains.setLimits(brainLimits());
    codexApp.setLimits(brainLimits());
    // The browser switch went off: the agent's browser closes now, not at its next command.
    if (browserOff) void browser.closeAll();
  };
  link.onEnd = () => connection.stop();
  log(`agentes-runner ${RUNNER_VERSION}: worker of agent ${o.agentId} (folder ${workspaceReal})`);
  await connection.run();
  clearInterval(leases);
  desktopUse.stopAll();
  tasks.close();
  brains.close();
  codexApp.close();
  await browser.close().catch(() => undefined);
  await mcp.close().catch(() => undefined);
  return 0;
}
