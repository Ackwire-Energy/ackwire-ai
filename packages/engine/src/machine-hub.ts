import {
  ACCOUNTS_PROTOCOL,
  BROWSER_PROTOCOL,
  type BrowserHandoffInfo,
  brainTopic,
  HEARTBEAT_MS,
  HELLO_TIMEOUT_MS,
  type MachineErrorCode,
  type MachineOp,
  type MachineReplies,
  type MachineRequest,
  type McpToolInfo,
  MIN_RUNNER_PROTOCOL,
  machineRpcReplyTopic,
  machineRpcTopic,
  PAUSE_PROTOCOL,
  type PubSub,
  parseRunnerFrame,
  type RunnerAccess,
  type RunnerFrame,
  type RunnerPause,
  type ServerFrame,
  TASKS_PROTOCOL,
  type Unsubscribe,
} from "@agenteschat/adapters";
import { and, type Database, eq, inArray, lt, schema } from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { applyAccessDecided, storeMachineAccess } from "./machine-access";
import { syncMachineAccounts } from "./machine-accounts";
import {
  applyTaskDone,
  applyTaskEvent,
  getTask,
  type LocalTaskStarter,
  reconcileMachineTasks,
  settleInterruptedTask,
  startMachineTask,
  TASK_OFFLINE_GRACE_MS,
  type TaskCall,
} from "./machine-tasks";
import {
  assertNotPaused,
  authenticateMachine,
  getMachineById,
  MACHINE_CONTROL_TOPIC,
  MachineOfflineError,
  machineAgents,
  machineOnline,
  machineOwnerTimezone,
  machinePause,
  publishMachineStatus,
  publishMachineUpdated,
} from "./machines";
import { enqueue } from "./outbox";

const { machines, machineRpc } = schema;

/**
 * The live side of connected computers (ADR 0025): one WebSocket per machine,
 * held by whichever replica the runner reached. Socket-agnostic (the server
 * adapts Bun's WebSocket to `MachineSocket`; tests use an in-memory one).
 *
 * - `hello` → token checked → `welcome`; the row gets `online`, this
 *   replica's id and the runner's info. A second socket for the same machine
 *   replaces the first (`refused: replaced`).
 * - `ping` every heartbeat; `last_seen_at` is written at most every
 *   40 s on `pong`, so a row is never stale while its socket lives.
 * - `call` sends a `request` and resolves on its `result`, forwarding
 *   `output`; aborting sends `cancel`. A machine held by another replica is
 *   reached through a `machine_rpc` row plus a pub/sub signal both ways.
 * - Brain turns (protocol 8, ADR 0032): `brain.turn` is a request like any
 *   other; its `brain.event` / `brain.done` frames are published on
 *   `brainTopic(runId)` (with the machine id) for the replica running the turn.
 * - Background tasks (protocol 4, `machine-tasks.ts`): this replica persists
 *   the `task.event` and `task.done` frames of the sockets it holds and acks
 *   each `task.done`; `hello` reconciles the runner's journal; a socket that
 *   closes schedules `machine.tasks_offline` after a grace.
 * - Desktop app (protocols 9 and 10, ADR 0036): the pause (`hello.paused`,
 *   `runner.state`) and the access report (`hello.access`, `access.changed`)
 *   are stored on the row and told to the org; a paused machine gets no new
 *   work (`call` refuses with `MachinePausedError`); every request's `agent`
 *   carries the agent's name; the `agents` frame goes out after `welcome`
 *   and again on `machine.agents` (any replica); `access.decided` wakes the
 *   agent that asked (`machine-access.ts`).
 */
export interface MachineSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

/** Close codes the runner may see. */
export const MACHINE_CLOSE = {
  badFrame: 4400,
  invalidToken: 4401,
  revoked: 4403,
  timeout: 4408,
  replaced: 4409,
  outdated: 4426,
} as const;

/** The runner answered a request with an error (`not_found`, `exec_disabled`…). */
export class MachineRequestError extends Error {
  constructor(
    readonly code: MachineErrorCode | "timeout" | "canceled",
    message: string,
  ) {
    super(message);
    this.name = "MachineRequestError";
  }
}

export interface MachineCallOptions {
  signal?: AbortSignal;
  /** Live output of an `exec` with `stream: true` (only on the replica holding the socket). */
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
  timeoutMs?: number;
}

export interface MachineStatus {
  id: string;
  orgId: string;
  name: string;
  online: boolean;
  execAllowed: boolean;
  os: string;
  /** The runner's protocol (from its last hello). */
  protocol: number;
  /** Coding CLIs found at its last hello (protocol 7; empty for older runners). */
  executors: schema.MachineExecutors;
  /** The owner paused it (protocol 9): `until` null = until resumed; `timezone` is the owner's, for messages. */
  paused?: { until: string | null; timezone: string | null } | null;
  /** Folders and tools the machine allows (protocol 10); null when it doesn't report them. */
  access?: RunnerAccess | null;
}

/** What the machine provider needs from the hub. */
export interface MachineCaller {
  call<Op extends MachineOp>(
    machineId: string,
    request: Extract<MachineRequest, { op: Op }>,
    options?: MachineCallOptions,
  ): Promise<MachineReplies[Op]>;
  status(machineId: string): Promise<MachineStatus | null>;
}

interface Pending {
  onOutput?: MachineCallOptions["onOutput"];
  /** A `brain.turn`: its run and bridge token, so its frames (events, tool calls) prove it is alive. */
  brain?: { runId: string; token: string };
  /** Restarts the request's inactivity timer (brain turns). */
  touch?(): void;
  settle(frame: Extract<RunnerFrame, { type: "result" }>): void;
  fail(error: Error): void;
}

export interface MachineConnection {
  readonly connectionId: string;
  readonly socket: MachineSocket;
  machineId: string | null;
  orgId: string | null;
  name: string;
  authing: boolean;
  closed: boolean;
  pending: Map<string, Pending>;
  lastPong: number;
  lastSeenWrite: number;
  helloTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  /** The runner's protocol (from its hello). */
  protocol: number;
  /** The pause the runner last reported (protocol 9); null = not paused. */
  pause: { until: string | null } | null;
}

export interface MachineHubDeps {
  db: Database;
  pubsub: PubSub;
  /** This process (default: random): rows record which replica holds a socket. */
  replicaId?: string;
  heartbeatMs?: number;
  helloTimeoutMs?: number;
  /** Cross-replica callers read the `machine_rpc` row this often (the signal usually comes first). */
  rpcPollMs?: number;
  /** A machine offline this long has its running tasks interrupted (default 60 s). */
  taskOfflineGraceMs?: number;
  /** A brain turn with no frame of its own (event, tool call) for this long fails (default `BRAIN_IDLE_TIMEOUT_MS`). */
  brainIdleMs?: number;
  /** A cross-replica caller checks this often that the replica it asked still holds the socket (default 5 s). */
  rpcLivenessMs?: number;
  log?: { warn(message: string, data?: Record<string, unknown>): void };
}

/**
 * A brain turn that sends nothing of its own for this long has stopped (a hung
 * CLI behind a live socket): it fails instead of keeping the run "working".
 * Every `brain.event`, and every bridge call with the turn's token (a
 * permission prompt polls every few seconds while it waits for a person),
 * restarts it; a long legit turn keeps talking. A dropped socket is caught much
 * sooner: its pending requests fail when it closes, is replaced or stops
 * answering pings.
 */
export const BRAIN_IDLE_TIMEOUT_MS = 15 * 60_000;

/** Default time a request may take: a command's own timeout plus slack; an upload 5.5 minutes; the rest 2 minutes. */
export function requestTimeoutMs(request: MachineRequest) {
  if (request.op === "exec") return (request.timeoutSeconds + 30) * 1000;
  if (request.op === "push") return 330_000;
  // A clone of a big repository on a slow link: its own deadline plus slack.
  if (request.op === "git.sync") return (Math.max(1, request.timeoutSeconds) + 30) * 1000;
  // A brain turn may wait on a person (a command approval) for up to 30 minutes, more than once.
  if (request.op === "brain.turn") return 3 * 3600_000;
  return 120_000;
}

type RpcReply = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

/**
 * Requests that start something new on the machine: refused while it is
 * paused (ADR 0036 §6). Following running work (a task's output, canceling
 * it), cleaning up and reducing access still go through.
 */
export function isNewWork(request: MachineRequest) {
  switch (request.op) {
    case "task.status":
    case "task.cancel":
    case "task.output":
    case "access.reduce":
    // The owner managing the brains' accounts (ADR 0041) isn't agent work.
    case "account":
      return false;
    case "secret":
      return request.action !== "discard" && request.action !== "remove";
    default:
      return true;
  }
}

/** The pause in force (a past `until` is over). */
const pauseActive = (pause: { until: string | null } | null, now = Date.now()) =>
  Boolean(pause && (!pause.until || Date.parse(pause.until) > now));

const pauseOf = (p: RunnerPause | undefined): { until: string | null } | null =>
  p?.paused ? { until: p.until ?? null } : null;

/** `machine_rpc` rows older than this are deleted (opportunistically). */
export const MACHINE_RPC_KEEP_MS = 60 * 60_000;

/** What missions plug into the hub (ADR 0029): the `agentes` MCP calls of their tasks, and a machine coming back. */
export interface MachineMissionHooks {
  mcp?(
    machineId: string,
    frame: Extract<RunnerFrame, { type: "mcp.call" }>,
  ): Promise<{ ok: true; text: string } | { ok: false; error: { code: string; message: string } }>;
  /** `mcp.list` (protocol 8, ADR 0032): the tools of the token's run or task. */
  mcpList?(
    machineId: string,
    frame: Extract<RunnerFrame, { type: "mcp.list" }>,
  ): Promise<{ ok: true; tools: McpToolInfo[] } | { ok: false; error: { code: string; message: string } }>;
  online?(machineId: string): Promise<void>;
}

/**
 * What the agent browser's live view plugs into the hub (ADR 0040 §7): the
 * runner's frames of the sockets held here, never stored, and a socket
 * closing (its viewers retry).
 */
export interface MachineBrowserHooks {
  frame?(machineId: string, frame: Extract<RunnerFrame, { type: "browser.frame" }>): void;
  streamEnded?(machineId: string, frame: Extract<RunnerFrame, { type: "browser.stream.ended" }>): void;
  closed?(machineId: string): void;
  /** A runner on protocol 12+ said hello here: what it should know again (open handoffs). */
  connected?(machineId: string): void;
}

export function createMachineHub(deps: MachineHubDeps) {
  const { db, pubsub } = deps;
  const replicaId = deps.replicaId ?? crypto.randomUUID();
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const helloTimeoutMs = deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const rpcPollMs = deps.rpcPollMs ?? 500;
  const taskOfflineGraceMs = deps.taskOfflineGraceMs ?? TASK_OFFLINE_GRACE_MS;
  const brainIdleMs = deps.brainIdleMs ?? BRAIN_IDLE_TIMEOUT_MS;
  const rpcLivenessMs = deps.rpcLivenessMs ?? 5000;
  /** Sockets on this replica, by machine id. */
  const local = new Map<string, MachineConnection>();
  /** Cross-replica requests this replica is running, to cancel them. */
  const running = new Map<string, AbortController>();
  let lastCleanup = 0;
  const subscriptions: Unsubscribe[] = [];
  let hooks: MachineMissionHooks = {};
  let browserHooks: MachineBrowserHooks = {};

  const send = (conn: MachineConnection, frame: ServerFrame) => {
    if (conn.closed) return;
    try {
      conn.socket.send(JSON.stringify(frame));
    } catch {
      // A socket that broke is cleaned up by its close.
    }
  };

  const refuse = (
    conn: MachineConnection,
    reason: Extract<ServerFrame, { type: "refused" }>["reason"],
    message: string,
    code: number,
  ) => {
    send(conn, { type: "refused", reason, message });
    try {
      conn.socket.close(code, reason);
    } catch {}
  };

  const markOffline = async (machineId: string, orgId: string | null) => {
    const [row] = await db
      .update(machines)
      .set({ online: false, connectedReplica: null, updatedAt: new Date() })
      .where(and(eq(machines.id, machineId), eq(machines.connectedReplica, replicaId)))
      .returning({ orgId: machines.orgId });
    if (!row) return false;
    await publishMachineStatus(pubsub, row.orgId ?? orgId, machineId, false);
    // Its running tasks become interrupted if it isn't back after the grace (any replica's worker runs it).
    await enqueue(db, {
      orgId: row.orgId,
      kind: "machine.tasks_offline",
      payload: { machineId },
      dedupeKey: `machine.tasks_offline:${machineId}:${Date.now()}`,
      runAt: new Date(Date.now() + taskOfflineGraceMs),
    }).catch(() => undefined);
    return true;
  };

  /** Starts a task through this socket (resuming one after an interruption). */
  const localStarter =
    (conn: MachineConnection): LocalTaskStarter =>
    (input) => {
      const call: TaskCall = async (_machineId, request) => callLocal(conn, await withAgentName(conn.orgId, request));
      return startMachineTask({ db, pubsub, call }, input);
    };

  /** `task.done`: persisted (and the conversation woken), then acknowledged so the runner stops re-sending it. */
  async function taskDone(conn: MachineConnection, frame: Extract<RunnerFrame, { type: "task.done" }>) {
    const machineId = conn.machineId as string;
    if (frame.interrupted) {
      const row = await getTask(db, frame.taskId);
      if (row && row.machineId === machineId) {
        await settleInterruptedTask({ db, pubsub, start: localStarter(conn) }, row, frame);
      }
    } else {
      await applyTaskDone({ db, pubsub }, machineId, frame);
    }
    send(conn, { type: "task.ack", taskId: frame.taskId });
  }

  async function hello(conn: MachineConnection, frame: Extract<RunnerFrame, { type: "hello" }>) {
    if (conn.machineId || conn.authing) return;
    conn.authing = true;
    if (frame.protocol < MIN_RUNNER_PROTOCOL) {
      return refuse(conn, "outdated", "This runner is too old; install the latest one.", MACHINE_CLOSE.outdated);
    }
    const machine = await authenticateMachine(db, frame.token);
    if (!machine) {
      return refuse(
        conn,
        "invalid_token",
        "This computer's token is not valid (it may have been removed); pair it again.",
        MACHINE_CLOSE.invalidToken,
      );
    }
    if (conn.closed) return;
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    conn.helloTimer = null;
    conn.machineId = machine.id;
    conn.orgId = machine.orgId;
    conn.name = machine.name;
    conn.protocol = frame.protocol;
    // Protocol 9: a runner that says nothing about the pause isn't paused.
    conn.pause = frame.protocol >= PAUSE_PROTOCOL ? pauseOf(frame.paused) : null;
    const old = local.get(machine.id);
    local.set(machine.id, conn);
    if (old && old !== conn) {
      refuse(old, "replaced", "Another runner connected for this computer.", MACHINE_CLOSE.replaced);
      // Its requests end now, not when (if ever) the dead socket's close arrives: a runner that restarted
      // mid-request lost them all (its requests die with its session).
      await closeConn(old);
    }
    const now = new Date();
    await db
      .update(machines)
      .set({
        online: true,
        connectedReplica: replicaId,
        lastSeenAt: now,
        hostname: frame.hostname,
        os: frame.os,
        arch: frame.arch,
        runnerVersion: frame.version,
        protocol: frame.protocol,
        workspace: frame.workspace,
        execAllowed: frame.exec,
        // Protocol 7: which coding CLIs it has (an older runner says nothing: kept as unknown).
        // Protocol 12: whether it can run the agent browser (ADR 0040), kept with what it found.
        ...(frame.executors || frame.browser
          ? {
              executors: {
                ...(frame.executors ?? {}),
                ...(frame.browser ? { browser: frame.browser } : {}),
                detectedAt: now.toISOString(),
              },
            }
          : {}),
        paused: conn.pause !== null,
        pausedUntil: conn.pause?.until ? new Date(conn.pause.until) : null,
        // Protocol 10: what the machine allows (an older runner reports nothing: unknown).
        access: frame.access ?? null,
        updatedAt: now,
      })
      .where(eq(machines.id, machine.id));
    // An older socket for this machine on another replica (the runner came back elsewhere) is dropped there.
    await pubsub
      .publish(MACHINE_CONTROL_TOPIC, {
        type: "machine.connected",
        machineId: machine.id,
        replicaId,
        connectionId: conn.connectionId,
      })
      .catch(() => undefined);
    conn.lastSeenWrite = Date.now();
    conn.lastPong = Date.now();
    send(conn, { type: "welcome", machineId: machine.id, name: machine.name, heartbeatMs });
    // Protocol 9: the agents that use this computer, for the desktop app.
    if (frame.protocol >= PAUSE_PROTOCOL) await sendAgents(conn);
    if (frame.protocol >= BROWSER_PROTOCOL) browserHooks.connected?.(machine.id);
    conn.pingTimer = setInterval(() => {
      if (Date.now() - conn.lastPong > 3 * heartbeatMs) {
        try {
          conn.socket.close(MACHINE_CLOSE.timeout, "no pong");
        } catch {}
        // A half-open socket may never report its close: its requests fail and the machine goes offline now.
        void closeConn(conn);
        return;
      }
      send(conn, { type: "ping", at: Date.now() });
    }, heartbeatMs);
    await publishMachineStatus(pubsub, machine.orgId, machine.id, true);
    if (frame.protocol >= PAUSE_PROTOCOL) {
      await publishMachineUpdated(pubsub, machine.orgId, machine.id, { paused: conn.pause, access: true });
    }
    // Protocol 13 (ADR 0041): the accounts of the computer brains on it (an older runner says nothing: kept).
    if (frame.protocol >= ACCOUNTS_PROTOCOL && frame.accounts) {
      await syncMachineAccounts({ db, pubsub }, machine.orgId, machine.id, frame.accounts).catch((error) =>
        deps.log?.warn("account sync failed", { machineId: machine.id, error: String(error) }),
      );
    }
    if (frame.protocol >= TASKS_PROTOCOL) {
      await reconcileMachineTasks({ db, pubsub, start: localStarter(conn) }, machine.id, frame.tasks ?? []).catch(
        (error) => deps.log?.warn("task reconcile failed", { machineId: machine.id, error: String(error) }),
      );
    }
    // Missions on this machine: queued messages and `.agentes/` files go out now (not in this frame's path).
    if (hooks.online) {
      const online = hooks.online;
      queueMicrotask(
        () =>
          void online(machine.id).catch((error) =>
            deps.log?.warn("mission reconnect failed", { machineId: machine.id, error: String(error) }),
          ),
      );
    }
  }

  /** The `agents` frame (protocol 9): the org's agents pointed at this machine. */
  async function sendAgents(conn: MachineConnection) {
    if (!conn.machineId || !conn.orgId || conn.protocol < PAUSE_PROTOCOL) return;
    const agents = await machineAgents(db, conn.orgId, conn.machineId).catch(() => null);
    if (agents) send(conn, { type: "agents", agents });
  }

  /** `runner.state` (protocol 9): paused, resumed or a new `until`; stored and told to the org. */
  async function runnerState(conn: MachineConnection, frame: Extract<RunnerFrame, { type: "runner.state" }>) {
    const machineId = conn.machineId as string;
    const wasPaused = pauseActive(conn.pause);
    conn.pause = pauseOf(frame.paused);
    const [row] = await db
      .update(machines)
      .set({
        paused: conn.pause !== null,
        pausedUntil: conn.pause?.until ? new Date(conn.pause.until) : null,
        updatedAt: new Date(),
      })
      .where(eq(machines.id, machineId))
      .returning({ orgId: machines.orgId });
    if (!row) return;
    await publishMachineUpdated(pubsub, row.orgId, machineId, { paused: conn.pause });
    // Resumed: what waited for this computer goes on (runs waiting for its brain, missions' queued work).
    if (wasPaused && !pauseActive(conn.pause) && hooks.online) {
      const online = hooks.online;
      queueMicrotask(
        () =>
          void online(machineId).catch((error) =>
            deps.log?.warn("resume after pause failed", { machineId, error: String(error) }),
          ),
      );
    }
  }

  /** Fills `agent.name` (protocol 9, for the machine's activity log) when a caller left it out. */
  async function withAgentName<R extends MachineRequest>(orgId: string | null, request: R): Promise<R> {
    const scope = request.agent;
    if (!scope || scope.name || !orgId) return request;
    const agent = await getAgentCached(db, orgId, scope.id).catch(() => null);
    return agent ? { ...request, agent: { ...scope, name: agent.name } } : request;
  }

  /** `mcp.call` (protocol 5): run by the missions hook, answered with `mcp.result`; never blocks other frames. */
  function mcpCall(conn: MachineConnection, frame: Extract<RunnerFrame, { type: "mcp.call" }>) {
    const machineId = conn.machineId as string;
    const run = hooks.mcp
      ? hooks.mcp(machineId, frame)
      : Promise.resolve({
          ok: false as const,
          error: { code: "mission.unavailable", message: "Missions are not available on this server." },
        });
    void run
      .catch((error: unknown) => ({
        ok: false as const,
        error: { code: "internal", message: error instanceof Error ? error.message : String(error) },
      }))
      .then((out) =>
        send(
          conn,
          out.ok
            ? { type: "mcp.result", callId: frame.callId, ok: true, text: out.text.slice(0, 50_000) }
            : { type: "mcp.result", callId: frame.callId, ok: false, error: out.error },
        ),
      );
  }

  /** `mcp.list` (protocol 8): answered with `mcp.tools`; never blocks other frames. */
  function mcpList(conn: MachineConnection, frame: Extract<RunnerFrame, { type: "mcp.list" }>) {
    const machineId = conn.machineId as string;
    const run = hooks.mcpList
      ? hooks.mcpList(machineId, frame)
      : Promise.resolve({
          ok: false as const,
          error: { code: "bridge.unavailable", message: "Tools are not available on this server." },
        });
    void run
      .catch((error: unknown) => ({
        ok: false as const,
        error: { code: "internal", message: error instanceof Error ? error.message : String(error) },
      }))
      .then((out) =>
        send(
          conn,
          out.ok
            ? { type: "mcp.tools", callId: frame.callId, ok: true, tools: out.tools }
            : { type: "mcp.tools", callId: frame.callId, ok: false, error: out.error },
        ),
      );
  }

  async function touch(conn: MachineConnection) {
    conn.lastPong = Date.now();
    if (!conn.machineId || Date.now() - conn.lastSeenWrite < Math.min(40_000, heartbeatMs * 1.6)) return;
    conn.lastSeenWrite = Date.now();
    await db
      .update(machines)
      .set({ lastSeenAt: new Date(), online: true })
      .where(and(eq(machines.id, conn.machineId), eq(machines.connectedReplica, replicaId)))
      .catch(() => undefined);
  }

  function callLocal<Op extends MachineOp>(
    conn: MachineConnection,
    request: Extract<MachineRequest, { op: Op }>,
    options: MachineCallOptions = {},
  ): Promise<MachineReplies[Op]> {
    return new Promise((resolve, reject) => {
      const { signal } = options;
      if (signal?.aborted) return reject(new MachineRequestError("canceled", "canceled"));
      const id = crypto.randomUUID();
      const timeoutMs = options.timeoutMs ?? requestTimeoutMs(request);
      const turn = request.op === "brain.turn" ? (request as Extract<MachineRequest, { op: "brain.turn" }>) : null;
      const brain = turn ? { runId: turn.runId, token: turn.mcp.token } : undefined;
      let idle: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(idle);
        signal?.removeEventListener("abort", onAbort);
        conn.pending.delete(id);
      };
      /** A brain turn that went quiet: canceled on the machine, failed here. */
      const touch = () => {
        if (!brain) return;
        clearTimeout(idle);
        idle = setTimeout(() => {
          cleanup();
          send(conn, { type: "cancel", id });
          reject(
            new MachineRequestError(
              "timeout",
              `no news from the computer ${conn.name} for ${Math.round(brainIdleMs / 60_000)} min`,
            ),
          );
        }, brainIdleMs);
      };
      const timer = setTimeout(() => {
        cleanup();
        send(conn, { type: "cancel", id });
        reject(
          new MachineRequestError(
            "timeout",
            `the computer ${conn.name} did not answer within ${Math.round(timeoutMs / 1000)} s`,
          ),
        );
      }, timeoutMs);
      function onAbort() {
        send(conn, { type: "cancel", id });
        // A command reports how it ended (`canceled`); anything else just stops waiting.
        if (request.op !== "exec") {
          cleanup();
          reject(new MachineRequestError("canceled", "canceled"));
        }
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      touch();
      conn.pending.set(id, {
        onOutput: options.onOutput,
        ...(brain ? { brain, touch } : {}),
        settle(frame) {
          cleanup();
          if (frame.ok) resolve(frame.data as MachineReplies[Op]);
          else reject(new MachineRequestError(frame.error.code, frame.error.message));
        },
        fail(error) {
          cleanup();
          reject(error);
        },
      });
      send(conn, { type: "request", id, ...request } as ServerFrame);
    });
  }

  /** A brain turn's own frame arrived: it is alive (restarts its inactivity timer). */
  function touchBrain(conn: MachineConnection, match: (b: NonNullable<Pending["brain"]>) => boolean) {
    for (const p of conn.pending.values()) if (p.brain && match(p.brain)) p.touch?.();
  }

  async function cleanupRpc() {
    if (Date.now() - lastCleanup < 10 * 60_000) return;
    lastCleanup = Date.now();
    await db
      .delete(machineRpc)
      .where(lt(machineRpc.createdAt, new Date(Date.now() - MACHINE_RPC_KEEP_MS)))
      .catch(() => undefined);
  }

  async function callRemote<Op extends MachineOp>(
    machine: { id: string; orgId: string; name: string; connectedReplica: string },
    request: Extract<MachineRequest, { op: Op }>,
    options: MachineCallOptions = {},
  ): Promise<MachineReplies[Op]> {
    void cleanupRpc();
    const [rpc] = await db
      .insert(machineRpc)
      .values({ orgId: machine.orgId, machineId: machine.id, request: request as unknown as Record<string, unknown> })
      .returning({ id: machineRpc.id });
    if (!rpc) throw new Error("machine_rpc insert returned nothing");
    let wake: (() => void) | null = null;
    const off = pubsub.subscribe(machineRpcReplyTopic(rpc.id), () => wake?.());
    const onAbort = () => {
      void pubsub
        .publish(machineRpcTopic(machine.connectedReplica), { type: "machine.rpc.cancel", rpcId: rpc.id })
        .catch(() => undefined);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const deadline = Date.now() + (options.timeoutMs ?? requestTimeoutMs(request)) + 10_000;
    let checkedAt = Date.now();
    try {
      await pubsub.publish(machineRpcTopic(machine.connectedReplica), { type: "machine.rpc", rpcId: rpc.id });
      for (;;) {
        const [row] = await db
          .select({ status: machineRpc.status, reply: machineRpc.reply })
          .from(machineRpc)
          .where(eq(machineRpc.id, rpc.id));
        if (row && (row.status === "done" || row.status === "failed")) {
          const reply = row.reply as RpcReply | null;
          if (reply?.ok) return reply.data as MachineReplies[Op];
          const error = reply && !reply.ok ? reply.error : { code: "internal", message: "no reply" };
          if (error.code === "offline") throw new MachineOfflineError(machine.name);
          throw new MachineRequestError(error.code as MachineErrorCode, error.message);
        }
        // The replica asked no longer holds the socket (the runner came back elsewhere, or that replica
        // died): its answer will never come, so the request ends now as offline.
        if (Date.now() - checkedAt >= rpcLivenessMs) {
          checkedAt = Date.now();
          const now = await getMachineById(db, machine.id).catch(() => undefined);
          if (
            now !== undefined &&
            (!now || now.deletedAt || !machineOnline(now) || now.connectedReplica !== machine.connectedReplica)
          ) {
            const [gone] = await db
              .update(machineRpc)
              .set({ status: "failed", repliedAt: new Date() })
              .where(and(eq(machineRpc.id, rpc.id), inArray(machineRpc.status, ["pending", "running"])))
              .returning({ id: machineRpc.id });
            // No row: the answer landed meanwhile (read on the next pass).
            if (gone) {
              onAbort();
              throw new MachineOfflineError(machine.name);
            }
            continue;
          }
        }
        if (Date.now() >= deadline) {
          await db
            .update(machineRpc)
            .set({ status: "failed", repliedAt: new Date() })
            .where(and(eq(machineRpc.id, rpc.id), eq(machineRpc.status, "pending")));
          throw new MachineRequestError("timeout", `the computer ${machine.name} did not answer in time`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, Math.min(rpcPollMs, Math.max(0, deadline - Date.now())));
          function done() {
            clearTimeout(timer);
            wake = null;
            resolve();
          }
          wake = done;
        });
      }
    } finally {
      off();
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Runs a request another replica wrote for a machine whose socket is here. */
  async function serveRpc(rpcId: string) {
    const [row] = await db
      .update(machineRpc)
      .set({ status: "running" })
      .where(and(eq(machineRpc.id, rpcId), eq(machineRpc.status, "pending")))
      .returning();
    if (!row) return;
    const conn = local.get(row.machineId);
    let reply: RpcReply;
    if (!conn) reply = { ok: false, error: { code: "offline", message: "offline" } };
    else {
      const controller = new AbortController();
      running.set(rpcId, controller);
      try {
        const request = row.request as unknown as MachineRequest;
        const data = await callLocal(conn, request, { signal: controller.signal });
        reply = { ok: true, data };
      } catch (error) {
        reply =
          error instanceof MachineOfflineError
            ? { ok: false, error: { code: "offline", message: error.message } }
            : {
                ok: false,
                error: {
                  code: error instanceof MachineRequestError ? error.code : "internal",
                  message: error instanceof Error ? error.message : String(error),
                },
              };
      } finally {
        running.delete(rpcId);
      }
    }
    await db
      .update(machineRpc)
      .set({
        status: reply.ok ? "done" : "failed",
        reply: reply as unknown as Record<string, unknown>,
        repliedAt: new Date(),
      })
      .where(eq(machineRpc.id, rpcId));
    await pubsub.publish(machineRpcReplyTopic(rpcId), { type: "machine.rpc.reply", rpcId }).catch(() => undefined);
  }

  async function closeConn(conn: MachineConnection) {
    if (conn.closed) return;
    conn.closed = true;
    if (conn.helloTimer) clearTimeout(conn.helloTimer);
    if (conn.pingTimer) clearInterval(conn.pingTimer);
    for (const p of [...conn.pending.values()]) p.fail(new MachineOfflineError(conn.name || "computer"));
    conn.pending.clear();
    if (conn.machineId && local.get(conn.machineId) === conn) {
      local.delete(conn.machineId);
      browserHooks.closed?.(conn.machineId);
      await markOffline(conn.machineId, conn.orgId).catch(() => undefined);
    }
  }

  subscriptions.push(
    pubsub.subscribe(machineRpcTopic(replicaId), (event) => {
      const rpcId = typeof event.rpcId === "string" ? event.rpcId : "";
      if (!rpcId) return;
      if (event.type === "machine.rpc") {
        void serveRpc(rpcId).catch((error) => deps.log?.warn("machine rpc failed", { rpcId, error: String(error) }));
      } else if (event.type === "machine.rpc.cancel") running.get(rpcId)?.abort();
    }),
    pubsub.subscribe(MACHINE_CONTROL_TOPIC, (event) => {
      if (event.type === "machine.connected" && typeof event.machineId === "string") {
        if (event.replicaId === replicaId) return;
        const conn = local.get(event.machineId);
        if (!conn || conn.connectionId === event.connectionId) return;
        // The runner came back on another replica: this socket is a stale one (outside the publisher's call stack).
        queueMicrotask(() => {
          refuse(conn, "replaced", "Another runner connected for this computer.", MACHINE_CLOSE.replaced);
          void closeConn(conn);
        });
        return;
      }
      if (event.type === "machine.agents" && typeof event.orgId === "string") {
        // The org's agents changed: its machines here list them again (outside the publisher's call stack).
        for (const conn of local.values()) {
          if (conn.orgId === event.orgId) queueMicrotask(() => void sendAgents(conn).catch(() => undefined));
        }
        return;
      }
      if (event.type !== "machine.revoke" || typeof event.machineId !== "string") return;
      const conn = local.get(event.machineId);
      if (!conn) return;
      // Outside the publisher's call stack (in-memory pub/sub delivers synchronously).
      queueMicrotask(() =>
        refuse(conn, "revoked", "This computer was removed from the organization.", MACHINE_CLOSE.revoked),
      );
    }),
  );

  return {
    replicaId,

    /** A socket opened on `/api/machines/connect`: it has `HELLO_TIMEOUT_MS` to say `hello`. */
    open(socket: MachineSocket): MachineConnection {
      const conn: MachineConnection = {
        connectionId: crypto.randomUUID(),
        socket,
        machineId: null,
        orgId: null,
        name: "",
        authing: false,
        closed: false,
        pending: new Map(),
        lastPong: Date.now(),
        lastSeenWrite: 0,
        helloTimer: null,
        pingTimer: null,
        protocol: 0,
        pause: null,
      };
      conn.helloTimer = setTimeout(() => {
        if (!conn.machineId) refuse(conn, "invalid_token", "No hello in time.", MACHINE_CLOSE.timeout);
      }, helloTimeoutMs);
      return conn;
    },

    async message(conn: MachineConnection, raw: string | Buffer | Uint8Array) {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      const frame = parseRunnerFrame(text);
      if (!frame) {
        if (!conn.machineId) refuse(conn, "invalid_token", "Send hello first.", MACHINE_CLOSE.badFrame);
        return;
      }
      if (frame.type === "hello") return hello(conn, frame);
      if (!conn.machineId) {
        if (!conn.authing) refuse(conn, "invalid_token", "Send hello first.", MACHINE_CLOSE.badFrame);
        return;
      }
      if (frame.type === "output") conn.pending.get(frame.id)?.onOutput?.(frame.stream, frame.chunk);
      else if (frame.type === "result") conn.pending.get(frame.id)?.settle(frame);
      // The agent browser's live view (ADR 0040): straight to the viewers in memory.
      else if (frame.type === "browser.frame") browserHooks.frame?.(conn.machineId, frame);
      else if (frame.type === "browser.stream.ended") browserHooks.streamEnded?.(conn.machineId, frame);
      else if (frame.type === "pong") await touch(conn);
      else if (frame.type === "task.event") {
        await applyTaskEvent({ db, pubsub }, conn.machineId, frame).catch(() => undefined);
      } else if (frame.type === "mcp.call") {
        if (frame.token) touchBrain(conn, (b) => b.token === frame.token);
        mcpCall(conn, frame);
      } else if (frame.type === "mcp.list") {
        touchBrain(conn, (b) => b.token === frame.token);
        mcpList(conn, frame);
      } else if (frame.type === "brain.event" || frame.type === "brain.done") {
        touchBrain(conn, (b) => b.runId === frame.runId);
        // Brain turns (protocol 8, ADR 0032): to whichever replica runs the turn; it checks the machine.
        await pubsub
          .publish(brainTopic(frame.runId), {
            type: frame.type,
            machineId: conn.machineId,
            ...(frame.type === "brain.event" ? { event: frame.event } : {}),
          })
          .catch(() => undefined);
      } else if (frame.type === "task.done") {
        // Not acknowledged on failure: the runner sends it again after its next reconnect.
        await taskDone(conn, frame).catch((error) =>
          deps.log?.warn("task.done failed", { taskId: frame.taskId, error: String(error) }),
        );
      } else if (frame.type === "runner.state") {
        await runnerState(conn, frame).catch((error) =>
          deps.log?.warn("runner.state failed", { machineId: conn.machineId, error: String(error) }),
        );
      } else if (frame.type === "accounts.changed") {
        if (conn.machineId && conn.orgId) {
          const machineId = conn.machineId;
          const orgId = conn.orgId;
          await syncMachineAccounts({ db, pubsub }, orgId, machineId, frame.accounts).catch((error) =>
            deps.log?.warn("account sync failed", { machineId, error: String(error) }),
          );
        }
      } else if (frame.type === "access.changed") {
        const machineId = conn.machineId;
        await storeMachineAccess({ db, pubsub }, machineId, frame.access).catch((error) =>
          deps.log?.warn("access.changed failed", { machineId, error: String(error) }),
        );
        // A tool turned on (Claude Code, Codex, commands): what waited for this computer goes on.
        if (hooks.online) {
          const online = hooks.online;
          queueMicrotask(
            () =>
              void online(machineId).catch((error) =>
                deps.log?.warn("resume after access change failed", { machineId, error: String(error) }),
              ),
          );
        }
      } else if (frame.type === "access.decided") {
        await applyAccessDecided({ db, pubsub }, conn.machineId, frame).catch((error) =>
          deps.log?.warn("access.decided failed", { requestId: frame.requestId, error: String(error) }),
        );
      }
    },

    /** The socket closed (either side): pending requests fail, and the machine goes offline unless replaced. */
    close: closeConn,

    /** Sends a request to a machine, wherever its socket is. Offline: `MachineOfflineError`. */
    async call<Op extends MachineOp>(
      machineId: string,
      request: Extract<MachineRequest, { op: Op }>,
      options: MachineCallOptions = {},
    ): Promise<MachineReplies[Op]> {
      const conn = local.get(machineId);
      if (conn) {
        // Paused (ADR 0036 §6): nothing new starts; the row says until when, in whose time zone.
        if (isNewWork(request) && pauseActive(conn.pause)) {
          const row = await getMachineById(db, machineId);
          if (row) await assertNotPaused(db, row);
        }
        return callLocal(conn, await withAgentName(conn.orgId, request), options);
      }
      const row = await getMachineById(db, machineId);
      if (!row || row.deletedAt) throw new MachineOfflineError(row?.name ?? "computer");
      if (!machineOnline(row) || !row.connectedReplica || row.connectedReplica === replicaId) {
        throw new MachineOfflineError(row.name);
      }
      if (isNewWork(request)) await assertNotPaused(db, row);
      const named = await withAgentName(row.orgId, request);
      return callRemote({ ...row, connectedReplica: row.connectedReplica }, named, options);
    },

    /** The machine as tools see it: online here, or online (and recently seen) on another replica. */
    async status(machineId: string): Promise<MachineStatus | null> {
      const row = await getMachineById(db, machineId);
      if (!row || row.deletedAt) return null;
      const online = local.has(machineId) || (machineOnline(row) && row.connectedReplica !== replicaId);
      const pause = machinePause(row);
      return {
        id: row.id,
        orgId: row.orgId,
        name: row.name,
        online,
        execAllowed: row.execAllowed,
        os: row.os,
        protocol: row.protocol,
        executors: row.executors ?? {},
        paused: pause ? { until: pause.until, timezone: await machineOwnerTimezone(db, row).catch(() => null) } : null,
        access: row.access ?? null,
      };
    },

    /** Missions plug in their MCP tools and their reconnect follow-up (set once the engine is built). */
    setMissionHooks(next: MachineMissionHooks) {
      hooks = next;
    },

    /** The agent browser's live view plugs in (set once the engine is built). */
    setBrowserHooks(next: MachineBrowserHooks) {
      browserHooks = next;
    },

    /** Whether this replica holds the machine's socket. */
    isLocal: (machineId: string) => local.has(machineId),

    /**
     * `browser.handoff` to a computer whose socket is here (protocol 12+), for
     * its desktop app; false when it isn't here or too old (nothing to do).
     */
    sendBrowserHandoff(machineId: string, agentId: string, handoff: BrowserHandoffInfo | null): boolean {
      const conn = local.get(machineId);
      if (!conn || conn.protocol < BROWSER_PROTOCOL) return false;
      send(conn, { type: "browser.handoff", agentId, handoff });
      return true;
    },

    /** Stops listening and closes every socket (shutdown, tests). */
    async stop() {
      for (const off of subscriptions) off();
      subscriptions.length = 0;
      for (const conn of [...local.values()]) {
        try {
          conn.socket.close(1001, "server stopping");
        } catch {}
        await closeConn(conn);
      }
    },
  };
}

export type MachineHub = ReturnType<typeof createMachineHub>;
