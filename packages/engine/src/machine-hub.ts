import {
  HEARTBEAT_MS,
  HELLO_TIMEOUT_MS,
  type MachineErrorCode,
  type MachineOp,
  type MachineReplies,
  type MachineRequest,
  MIN_RUNNER_PROTOCOL,
  machineRpcReplyTopic,
  machineRpcTopic,
  type PubSub,
  parseRunnerFrame,
  type RunnerFrame,
  type ServerFrame,
  TASKS_PROTOCOL,
  type Unsubscribe,
} from "@agenteschat/adapters";
import { and, type Database, eq, lt, schema } from "@agenteschat/db";
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
  authenticateMachine,
  getMachineById,
  MACHINE_CONTROL_TOPIC,
  MachineOfflineError,
  machineOnline,
  publishMachineStatus,
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
 * - Background tasks (protocol 4, `machine-tasks.ts`): this replica persists
 *   the `task.event` and `task.done` frames of the sockets it holds and acks
 *   each `task.done`; `hello` reconciles the runner's journal; a socket that
 *   closes schedules `machine.tasks_offline` after a grace.
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
  log?: { warn(message: string, data?: Record<string, unknown>): void };
}

/** Default time a request may take: a command's own timeout plus slack; an upload 5.5 minutes; the rest 2 minutes. */
export function requestTimeoutMs(request: MachineRequest) {
  if (request.op === "exec") return (request.timeoutSeconds + 30) * 1000;
  if (request.op === "push") return 330_000;
  return 120_000;
}

type RpcReply = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

/** `machine_rpc` rows older than this are deleted (opportunistically). */
export const MACHINE_RPC_KEEP_MS = 60 * 60_000;

/** What missions plug into the hub (ADR 0029): the `agentes` MCP calls of their tasks, and a machine coming back. */
export interface MachineMissionHooks {
  mcp?(
    machineId: string,
    frame: Extract<RunnerFrame, { type: "mcp.call" }>,
  ): Promise<{ ok: true; text: string } | { ok: false; error: { code: string; message: string } }>;
  online?(machineId: string): Promise<void>;
}

export function createMachineHub(deps: MachineHubDeps) {
  const { db, pubsub } = deps;
  const replicaId = deps.replicaId ?? crypto.randomUUID();
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const helloTimeoutMs = deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const rpcPollMs = deps.rpcPollMs ?? 500;
  const taskOfflineGraceMs = deps.taskOfflineGraceMs ?? TASK_OFFLINE_GRACE_MS;
  /** Sockets on this replica, by machine id. */
  const local = new Map<string, MachineConnection>();
  /** Cross-replica requests this replica is running, to cancel them. */
  const running = new Map<string, AbortController>();
  let lastCleanup = 0;
  const subscriptions: Unsubscribe[] = [];
  let hooks: MachineMissionHooks = {};

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
      const call: TaskCall = (_machineId, request) => callLocal(conn, request);
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
    const old = local.get(machine.id);
    local.set(machine.id, conn);
    if (old && old !== conn) {
      refuse(old, "replaced", "Another runner connected for this computer.", MACHINE_CLOSE.replaced);
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
        updatedAt: now,
      })
      .where(eq(machines.id, machine.id));
    conn.lastSeenWrite = Date.now();
    conn.lastPong = Date.now();
    send(conn, { type: "welcome", machineId: machine.id, name: machine.name, heartbeatMs });
    conn.pingTimer = setInterval(() => {
      if (Date.now() - conn.lastPong > 3 * heartbeatMs) {
        try {
          conn.socket.close(MACHINE_CLOSE.timeout, "no pong");
        } catch {}
        return;
      }
      send(conn, { type: "ping", at: Date.now() });
    }, heartbeatMs);
    await publishMachineStatus(pubsub, machine.orgId, machine.id, true);
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
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        conn.pending.delete(id);
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
      conn.pending.set(id, {
        onOutput: options.onOutput,
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
      else if (frame.type === "pong") await touch(conn);
      else if (frame.type === "task.event") {
        await applyTaskEvent({ db, pubsub }, conn.machineId, frame).catch(() => undefined);
      } else if (frame.type === "mcp.call") {
        mcpCall(conn, frame);
      } else if (frame.type === "task.done") {
        // Not acknowledged on failure: the runner sends it again after its next reconnect.
        await taskDone(conn, frame).catch((error) =>
          deps.log?.warn("task.done failed", { taskId: frame.taskId, error: String(error) }),
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
      if (conn) return callLocal(conn, request, options);
      const row = await getMachineById(db, machineId);
      if (!row || row.deletedAt) throw new MachineOfflineError(row?.name ?? "computer");
      if (!machineOnline(row) || !row.connectedReplica || row.connectedReplica === replicaId) {
        throw new MachineOfflineError(row.name);
      }
      return callRemote({ ...row, connectedReplica: row.connectedReplica }, request, options);
    },

    /** The machine as tools see it: online here, or online (and recently seen) on another replica. */
    async status(machineId: string): Promise<MachineStatus | null> {
      const row = await getMachineById(db, machineId);
      if (!row || row.deletedAt) return null;
      const online = local.has(machineId) || (machineOnline(row) && row.connectedReplica !== replicaId);
      return {
        id: row.id,
        orgId: row.orgId,
        name: row.name,
        online,
        execAllowed: row.execAllowed,
        os: row.os,
        protocol: row.protocol,
      };
    },

    /** Missions plug in their MCP tools and their reconnect follow-up (set once the engine is built). */
    setMissionHooks(next: MachineMissionHooks) {
      hooks = next;
    },

    /** Whether this replica holds the machine's socket. */
    isLocal: (machineId: string) => local.has(machineId),

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
