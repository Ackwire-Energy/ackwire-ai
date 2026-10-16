import {
  HEARTBEAT_MS,
  type MachineRequest,
  parseServerFrame,
  type RunnerFrame,
  type RunnerInfo,
} from "@agenteschat/adapters/machine-protocol";
import { type HandlerContext, handleRequest, RequestRunner } from "./handlers";
import type { McpBridge } from "./mcp";

export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;

/** What a transport tells the connection. */
export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: string): void;
  onClose(code: number, reason: string): void;
}

export interface Socket {
  send(data: string): void;
  close(): void;
}

/** Opens a socket (real WebSocket in the runner, a fake in tests). */
export type Dial = (url: string, handlers: SocketHandlers) => Socket;

/** The global WebSocket (Node 22+ and Bun both have it). */
export const webSocketDial: Dial = (url, handlers) => {
  if (typeof WebSocket === "undefined") {
    throw new Error("This runtime has no WebSocket client; use Node.js 22 or newer, or Bun");
  }
  const ws = new WebSocket(url);
  let closed = false;
  const decoder = new TextDecoder();
  ws.addEventListener("open", () => handlers.onOpen());
  ws.addEventListener("message", (ev) => {
    const data: unknown = ev.data;
    if (typeof data === "string") handlers.onMessage(data);
    else if (data instanceof ArrayBuffer) handlers.onMessage(decoder.decode(data));
    else if (ArrayBuffer.isView(data)) handlers.onMessage(decoder.decode(data as Uint8Array));
  });
  ws.addEventListener("close", (ev) => {
    if (closed) return;
    closed = true;
    handlers.onClose(ev.code, ev.reason);
  });
  // An `error` is always followed by `close`; the watchdog covers the rest.
  ws.addEventListener("error", () => {});
  return {
    send: (data) => ws.send(data),
    close: () => {
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
};

/** 1 s, 2 s, 4 s… up to 60 s, each ±20 %. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, Math.min(attempt, 10)));
  return Math.min(BACKOFF_MAX_MS, Math.round(base * (0.8 + 0.4 * random())));
}

/** Why `run()` ended: the CLI exits with `exitCode`. */
export interface ConnectionOutcome {
  exitCode: number;
  reason: "invalid_token" | "revoked" | "outdated" | "replaced" | "stopped";
  message: string;
}

const REFUSED_EXIT: Record<Exclude<ConnectionOutcome["reason"], "stopped">, number> = {
  invalid_token: 2,
  revoked: 2,
  outdated: 3,
  replaced: 0,
};

export interface ConnectionOptions {
  /** `wss://…/api/machines/connect`. */
  url: string;
  token: string;
  info: RunnerInfo;
  context: HandlerContext;
  dial?: Dial;
  log?: (line: string) => void;
  random?: () => number;
  /** Tests: run requests with a fake. */
  handler?: typeof handleRequest;
  /**
   * Background tasks (protocol 4): `hello` carries their journal, each
   * `welcome` re-sends every `task.done` not yet acknowledged, `task.ack`
   * marks one delivered. Defaults to `context.tasks`.
   */
  tasks?: Pick<NonNullable<HandlerContext["tasks"]>, "list" | "attach" | "detach" | "ack">;
  /** Protocol 5: the local MCP endpoint of mission tasks; its calls go out while connected. */
  mcp?: Pick<McpBridge, "attach" | "detach" | "result">;
  /** Called after each `welcome`. */
  onWelcome?: (welcome: { machineId: string; name: string; heartbeatMs: number }) => void;
}

interface SessionEnd {
  welcomed: boolean;
  outcome?: ConnectionOutcome;
}

/**
 * Keeps one connection to the server: `hello` first, `pong` for each `ping`,
 * requests run concurrently, reconnects with backoff, and reconnects when no
 * ping arrives for two heartbeats. Ends only when the server refuses the
 * runner or `stop()` is called.
 */
export class RunnerConnection {
  private stopped = false;
  private endSession?: () => void;
  private wake?: () => void;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: ConnectionOptions) {
    this.log = opts.log ?? (() => {});
  }

  async run(): Promise<ConnectionOutcome> {
    let attempt = 0;
    while (!this.stopped) {
      const end = await this.session();
      if (end.outcome) return end.outcome;
      if (this.stopped) break;
      if (end.welcomed) attempt = 0;
      const delay = backoffDelay(attempt, this.opts.random);
      attempt++;
      this.log(`disconnected; reconnecting in ${(delay / 1000).toFixed(1)} s`);
      await this.sleep(delay);
    }
    return { exitCode: 0, reason: "stopped", message: "stopped" };
  }

  /** Closes the socket, aborts running requests and makes `run()` return. */
  stop() {
    this.stopped = true;
    this.endSession?.();
    this.wake?.();
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    }).finally(() => {
      this.wake = undefined;
    });
  }

  private session(): Promise<SessionEnd> {
    return new Promise<SessionEnd>((resolve) => {
      const { opts, log } = this;
      let socket: Socket | undefined;
      let welcomed = false;
      let finished = false;
      let outcome: ConnectionOutcome | undefined;
      let heartbeatMs = HEARTBEAT_MS;
      let watchdog: ReturnType<typeof setTimeout> | undefined;

      const send = (frame: RunnerFrame) => {
        if (finished || !socket) return;
        try {
          socket.send(JSON.stringify(frame));
        } catch {
          // closing; the session ends on `close`
        }
      };
      const runner = new RequestRunner(opts.context, send, log, opts.handler ?? handleRequest);
      const tasks = opts.tasks ?? opts.context.tasks;

      const end = () => {
        if (finished) return;
        finished = true;
        if (watchdog) clearTimeout(watchdog);
        runner.close();
        tasks?.detach();
        opts.mcp?.detach();
        socket?.close();
        this.endSession = undefined;
        resolve({ welcomed, outcome });
      };
      const arm = () => {
        if (watchdog) clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          log("no ping from the server; reconnecting");
          end();
        }, 2 * heartbeatMs);
      };

      const onFrame = (raw: string) => {
        const frame = parseServerFrame(raw);
        if (!frame) {
          log("ignored a frame the runner doesn't understand");
          return;
        }
        switch (frame.type) {
          case "welcome": {
            welcomed = true;
            if (typeof frame.heartbeatMs === "number" && frame.heartbeatMs > 0) heartbeatMs = frame.heartbeatMs;
            log(`connected as ${frame.name}`);
            arm();
            opts.onWelcome?.({ machineId: frame.machineId, name: frame.name, heartbeatMs });
            tasks?.attach(send);
            opts.mcp?.attach(send);
            return;
          }
          case "mcp.result":
            opts.mcp?.result(frame);
            return;
          case "task.ack":
            tasks?.ack(frame.taskId);
            return;
          case "ping":
            send({ type: "pong", at: frame.at });
            arm();
            return;
          case "request": {
            const { type: _type, id, ...request } = frame;
            void runner.start(id, request as MachineRequest);
            return;
          }
          case "cancel":
            runner.cancel(frame.id);
            return;
          case "refused": {
            const reason = frame.reason in REFUSED_EXIT ? frame.reason : "invalid_token";
            outcome = { exitCode: REFUSED_EXIT[reason], reason, message: frame.message || reason };
            end();
            return;
          }
        }
      };

      this.endSession = end;
      try {
        socket = (opts.dial ?? webSocketDial)(opts.url, {
          onOpen: () => {
            queueMicrotask(() =>
              send({ type: "hello", token: opts.token, ...opts.info, ...(tasks ? { tasks: tasks.list() } : {}) }),
            );
          },
          onMessage: (raw) => {
            if (!finished) onFrame(raw);
          },
          onClose: (code, reason) => {
            if (!finished && !welcomed && code !== 1000) {
              log(`could not connect${reason ? ` (${reason})` : code ? ` (code ${code})` : ""}`);
            }
            end();
          },
        });
      } catch (err) {
        log(`could not connect: ${err instanceof Error ? err.message : String(err)}`);
        end();
        return;
      }
      if (finished) socket.close();
      else arm();
    });
  }
}
