import {
  type AgentScope,
  BRAIN_PROTOCOL,
  type BrainTurnRequest,
  brainTopic,
  type PubSub,
  parseBrainEvent,
} from "@agenteschat/adapters";
import type { MachineCaller } from "../machine-hub";
import { CODEX_MIN_VERSION, versionOf } from "../missions";
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
}

/** `codex-cli 0.163.0` is new enough (`CODEX_MIN_VERSION`). */
export function codexVersionOk(version: string | undefined): boolean {
  const have = versionOf(version);
  const want = versionOf(CODEX_MIN_VERSION) as number[];
  if (!have) return false;
  for (let i = 0; i < 3; i++) if ((have[i] ?? 0) !== (want[i] ?? 0)) return (have[i] ?? 0) > (want[i] ?? 0);
  return true;
}

/**
 * What Codex reads this turn. A new thread gets the conversation so far
 * (its context; the system text goes as developer instructions) and the
 * trigger; a resumed thread already has everything up to its own last reply,
 * so it gets only what people said after it.
 */
export function codexPrompt(turn: BrainTurn): string {
  const messages = turn.messages;
  const trigger = turn.trigger.trim();
  const last = messages[messages.length - 1];
  const before = last && last.role === "user" && last.content.trim() === trigger ? messages.slice(0, -1) : messages;
  const render = (m: { role: string; content: string }) => `${m.role === "user" ? "User" : "You"}: ${m.content}`;
  if (turn.session?.resume) {
    let i = before.length;
    while (i > 0 && before[i - 1]?.role === "user") i--;
    const fresh = before.slice(i);
    if (!fresh.length) return trigger;
    return `New messages since your last reply:\n\n${fresh.map(render).join("\n\n")}\n\nNow answer this:\n\n${trigger}`;
  }
  if (!before.length) return trigger;
  return `The conversation so far:\n\n${before.map(render).join("\n\n")}\n\nNow answer this:\n\n${trigger}`;
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
    if (!status.execAllowed) {
      yield {
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

    const [mcp, agent] = await Promise.all([this.deps.mcp(turn), this.deps.agent?.(turn)]);
    const request: BrainTurnRequest & { agent?: AgentScope } = {
      runId: turn.runId,
      kind: "codex",
      session: { id: session.id, resume: session.resume },
      cwd: session.cwd,
      ...(turn.model ? { model: turn.model } : {}),
      system: turn.system,
      prompt: codexPrompt(turn),
      mcp,
      ...(agent ? { agent } : {}),
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
