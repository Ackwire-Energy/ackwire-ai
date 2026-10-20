import {
  type AgentScope,
  BRAIN_PROTOCOL,
  type BrainTurnRequest,
  brainTopic,
  type PubSub,
  parseBrainEvent,
} from "@agenteschat/adapters";
import type { MachineCaller } from "../machine-hub";
import { MachineOfflineError, MachinePausedError, pausedMessage } from "../machines";
import { CODEX_MIN_VERSION, versionOf } from "../missions";
import { accountFields, accountUnavailable } from "./claude-code";
import { computerPrompt } from "./prompt";
import type { Brain, BrainEvent, BrainIO, BrainTurn } from "./types";

/**
 * The Codex brain (ADR 0032, ADR 0029 "Codex"): one agent turn runs as
 * `codex exec --json` on the agent's connected computer, through the runner's
 * `brain.turn` op. The runner owns the Codex side (command line, our session
 * → Codex thread id, JSONL → `BrainEvent`, the MCP bridge config); this brain
 * checks the computer can run it, builds the request (context on the first
 * turn, the new messages on a resumed one) and passes the events through,
 * making sure the turn ends with exactly one `done` or `error`.
 *
 * Tools run through the runner's MCP bridge (the engine's Tool Gateway with
 * the run's identity), so `io.executeTool` is never used here; Codex's own
 * commands and file edits arrive as `tool_call` with `executed` (transcript
 * only). Usage is the person's plan (`source: "plan"`, cost zero).
 */

/** `brain.turn` as the server sends it to the runner (the shared wire type, `machine-protocol.ts`). */
export type { BrainTurnRequest };

/** What the brain needs from the machine hub (the integrator wires it to `brain.turn` / `brain.event`). */
export interface ComputerBrainLink {
  status(machineId: string): Promise<{
    online: boolean;
    execAllowed: boolean;
    /** The runner's protocol (absent: not checked). */
    protocol?: number;
    executors: { codex?: { version: string }; claude?: { version: string } };
    /** The owner paused the computer (protocol 9; absent: not checked). */
    paused?: { until: string | null; timezone: string | null } | null;
    name?: string;
    /** What the machine allows (protocol 10): with it, Codex needs its own tool on, not commands. */
    access?: { tools: { claude: boolean; codex: boolean; commands: boolean } } | null;
  } | null>;
  /** Sends `brain.turn` and calls `onEvent` per `brain.event`; resolves on `brain.done`. */
  turn(
    machineId: string,
    request: BrainTurnRequest & { agent?: AgentScope },
    options: { signal: AbortSignal; onEvent: (event: BrainEvent) => void },
  ): Promise<void>;
}

export interface CodexBrainDeps {
  link: ComputerBrainLink;
  /** A fresh MCP bridge token for this run (and the bridge URL when it is HTTP). */
  mcp(turn: BrainTurn): Promise<{ token: string; url?: string }>;
  /** The agent's folder scope on the machine (id + handle). */
  agent?(turn: BrainTurn): Promise<AgentScope | undefined>;
  /** Before a chat turn: the agent's checkouts updated, where it starts and the "# Your code" block (`prepareAgentCode`). */
  prepare?(turn: BrainTurn, signal: AbortSignal): Promise<{ cwd: string; prompt: string } | null>;
}

/** `codex-cli 0.163.0` is new enough (`CODEX_MIN_VERSION`). */
export function codexVersionOk(version: string | undefined): boolean {
  const have = versionOf(version);
  const want = versionOf(CODEX_MIN_VERSION) as number[];
  if (!have) return false;
  for (let i = 0; i < 3; i++) if ((have[i] ?? 0) !== (want[i] ?? 0)) return (have[i] ?? 0) > (want[i] ?? 0);
  return true;
}

/** Events pushed by a callback, read as an async iterable. */
function channel<T>() {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  return {
    push(v: T) {
      queue.push(v);
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    async *read(): AsyncGenerator<T> {
      for (;;) {
        while (queue.length) yield queue.shift() as T;
        if (ended) return;
        await new Promise<void>((r) => {
          wake = r;
        });
        wake = null;
      }
    },
  };
}

export class CodexBrain implements Brain {
  readonly kind = "codex" as const;

  constructor(private readonly deps: CodexBrainDeps) {}

  async *run(turn: BrainTurn, io: BrainIO): AsyncIterable<BrainEvent> {
    const session = turn.session;
    if (!session) {
      yield { type: "error", code: "no_session", message: "The Codex brain needs a session on a computer." };
      return;
    }
    const status = await this.deps.link.status(session.machineId);
    if (!status?.online) {
      yield { type: "error", code: "machine_offline", message: "The computer is offline.", retryable: true };
      return;
    }
    if (status.paused) {
      const message = pausedMessage(status.name ?? "", status.paused.until, status.paused.timezone);
      yield { type: "error", code: "machine_paused", message, retryable: true };
      return;
    }
    if (status.access ? status.access.tools.codex !== true : !status.execAllowed) {
      yield status.access
        ? {
            type: "error",
            code: "tool_off",
            message: "Codex is turned off on the computer (its owner can turn it on in the agentes app).",
            retryable: true,
          }
        : {
            type: "error",
            code: "exec_disabled",
            message: "Commands are turned off on the computer (its runner was started with --no-exec).",
            retryable: true,
          };
      return;
    }
    if (status.protocol !== undefined && status.protocol < BRAIN_PROTOCOL) {
      yield {
        type: "error",
        code: "runner_outdated",
        message: "The runner on the computer is too old for agents that think with Codex; update it.",
        retryable: true,
      };
      return;
    }
    const codex = status.executors.codex;
    if (!codex) {
      yield {
        type: "error",
        code: "codex_missing",
        message: "Codex is not installed on the computer.",
        retryable: true,
      };
      return;
    }
    if (!codexVersionOk(codex.version)) {
      yield {
        type: "error",
        code: "codex_too_old",
        message: `Codex on the computer is ${codex.version}; agents need ${CODEX_MIN_VERSION} or newer (update it there).`,
        retryable: true,
      };
      return;
    }
    const account = accountUnavailable(status, turn.account, "codex");
    if (account) {
      yield { type: "error", code: account.code, message: account.message, retryable: true };
      return;
    }

    const [mcp, agent, code] = await Promise.all([
      this.deps.mcp(turn),
      this.deps.agent?.(turn),
      this.deps.prepare?.(turn, io.signal).catch(() => null),
    ]);
    const request: BrainTurnRequest & { agent?: AgentScope } = {
      runId: turn.runId,
      kind: "codex",
      session: { id: session.id, resume: session.resume },
      cwd: code?.cwd || session.cwd,
      ...(turn.model ? { model: turn.model } : {}),
      system: code?.prompt ? `${turn.system}\n\n${code.prompt}` : turn.system,
      prompt: computerPrompt(turn),
      mcp,
      ...(agent ? { agent } : {}),
      ...accountFields(status.protocol, turn),
    };

    const events = channel<BrainEvent>();
    let text = "";
    let ended = false;
    const state: { failure?: unknown } = {};
    const sent = this.deps.link
      .turn(session.machineId, request, {
        signal: io.signal,
        onEvent: (event) => events.push(event),
      })
      .catch((error: unknown) => {
        state.failure = error ?? new Error("The runner failed");
      })
      .finally(() => events.end());

    for await (const event of events.read()) {
      if (ended) continue;
      if (event.type === "text_delta") text += event.text;
      if (event.type === "done") {
        ended = true;
        yield { type: "done", text: event.text, session: { id: session.id } };
        continue;
      }
      if (event.type === "error") ended = true;
      yield event;
    }
    await sent;
    if (ended) return;
    if (io.signal.aborted) {
      yield { type: "error", code: "canceled", message: "The turn was canceled." };
    } else if (state.failure instanceof MachineOfflineError) {
      // The computer dropped mid-turn: the engine waits for it and resumes the turn there.
      yield { type: "error", code: "machine_offline", message: state.failure.message, retryable: true };
    } else if (state.failure instanceof MachinePausedError) {
      yield { type: "error", code: "machine_paused", message: state.failure.message, retryable: true };
    } else if (state.failure !== undefined) {
      const message = state.failure instanceof Error ? state.failure.message : String(state.failure);
      yield { type: "error", code: "runner_failed", message, retryable: true };
    } else {
      // The runner finished without saying how: what it streamed is the answer.
      yield { type: "done", text, session: { id: session.id } };
    }
  }
}

/**
 * The `ComputerBrainLink` over the machine hub: `brain.turn` goes to the
 * machine (whichever replica holds its socket), `brain.event` frames come
 * back on `brainTopic(runId)`; the request's result repeats the final event,
 * so the turn ends even if a published event is lost.
 */
export function hubBrainLink(deps: {
  hub: Pick<MachineCaller, "call" | "status">;
  pubsub: PubSub;
  timeoutMs?: number;
  /** After the request's result, how long to wait for the stream's last events (default 1.5 s). */
  finalGraceMs?: number;
}): ComputerBrainLink {
  return {
    status: (machineId) => deps.hub.status(machineId).catch(() => null),
    async turn(machineId, request, options) {
      let streamEnded = false;
      let finalSeen = false;
      let wake: (() => void) | null = null;
      const off = deps.pubsub.subscribe(brainTopic(request.runId), (e) => {
        if (e.machineId !== machineId) return;
        if (e.type === "brain.done") {
          streamEnded = true;
          wake?.();
          return;
        }
        if (e.type !== "brain.event") return;
        const event = parseBrainEvent(e.event);
        if (!event) return;
        if (event.type === "done" || event.type === "error") finalSeen = true;
        options.onEvent(event as BrainEvent);
      });
      try {
        const reply = await deps.hub.call<"brain.turn">(
          machineId,
          { op: "brain.turn", ...request },
          { signal: options.signal, ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) },
        );
        if (!streamEnded) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, deps.finalGraceMs ?? 1500);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
        }
        // The stream lost its last event: the reply carries it.
        const final = parseBrainEvent(reply?.final);
        if (!finalSeen && final && (final.type === "done" || final.type === "error"))
          options.onEvent(final as BrainEvent);
      } finally {
        off();
      }
    },
  };
}
