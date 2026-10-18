import { createHash, randomBytes } from "node:crypto";
import {
  type AgentScope,
  BRAIN_PROTOCOL,
  type BrainTurnRequest,
  brainTopic,
  type PubSub,
  parseBrainEvent,
  type WireBrainEvent,
} from "@agenteschat/adapters";
import { type Database, schema } from "@agenteschat/db";
import { getAgentCached } from "../agents";
import { type MachineCaller, MachineRequestError, type MachineStatus } from "../machine-hub";
import { MachineOfflineError, MachinePausedError, pausedMessage } from "../machines";
import { computerPrompt } from "./prompt";
import type { Brain, BrainEvent, BrainIO, BrainTurn } from "./types";

/**
 * The Claude Code brain (ADR 0032): an agent thinks with Claude Code on its
 * computer, on the owner's plan.
 *
 * - One turn = one `brain.turn` request to the machine (protocol 8) through
 *   the hub. The runner streams `brain.event` frames; the hub publishes them
 *   on `brainTopic(runId)` for whichever replica runs the turn, and the brain
 *   yields them as `BrainEvent`s. The request's result repeats the final event
 *   (`done` or `error`), so the turn ends even if a published event is lost.
 * - Tools: Claude Code calls them through the runner's MCP bridge (block 2),
 *   executed by the engine's Tool Gateway; here they only arrive as
 *   `tool_call` events with `executed` (for the transcript and the live view).
 * - Usage: `usage{source:"plan"}` (no cost; `recordPlanUsage` writes it).
 *   A plan limit: `limit{resetsAt}` and then `error{code:"plan_limit"}`.
 * - Before sending anything the machine is checked: offline, commands off,
 *   an older runner, no Claude Code, or not logged in end the turn at once
 *   with an `error` whose `retryable: true` tells the engine it may fall back
 *   to the model brain (ADR 0032 §5).
 *
 * Error codes (`retryable` = the turn may run on another brain):
 * `no_session`, `machine_offline`, `exec_disabled`, `runner_outdated`,
 * `cli_missing`, `not_logged_in`, `plan_limit`, `busy` (all retryable);
 * `claude_failed`, `canceled`, `timeout`, `runner_error`, `bad_request` (not).
 */

export interface ClaudeCodeBrainDeps {
  hub: Pick<MachineCaller, "call" | "status">;
  pubsub: PubSub;
  /** The agent as the runner names its folder (`agentScopeFromDb`). */
  agentScope: (turn: BrainTurn) => Promise<AgentScope>;
  /** Keep one Claude Code process per thread alive between turns (default true). */
  keepAlive?: boolean;
  /** Also load the machine owner's own MCP servers (default false: only our bridge). */
  personalMcp?: (turn: BrainTurn) => boolean | Promise<boolean>;
  /** Command policy for the turn (missions pass plan/work, branch prefix, allowed rules). */
  permissions?: (
    turn: BrainTurn,
  ) => BrainTurnRequest["permissions"] | undefined | Promise<BrainTurnRequest["permissions"] | undefined>;
  /** The run's MCP bridge token (default: random per run). */
  mcpToken?: (turn: BrainTurn) => string;
  /**
   * Before a chat turn (ADR 0024 addendum): updates the agent's checkouts on
   * the machine and says where the turn starts and what to add to the
   * system text ("# Your code"). Null or a failure: the turn runs as before.
   */
  prepare?: (turn: BrainTurn, signal: AbortSignal) => Promise<{ cwd: string; prompt: string } | null>;
  /** How long a turn may take (default: the hub's, 3 h). */
  timeoutMs?: number;
  /** After the request's result, how long to wait for the stream's last events (default 1.5 s). */
  finalGraceMs?: number;
}

/** The agent's id and handle, as the runner names its folder (and its name, for the machine's activity log). */
export const agentScopeFromDb =
  (db: Database) =>
  async (turn: BrainTurn): Promise<AgentScope> => {
    const agent = await getAgentCached(db, turn.orgId, turn.agentId);
    return { id: turn.agentId, handle: agent?.handle ?? "agent", ...(agent ? { name: agent.name } : {}) };
  };

/**
 * A stable Claude Code session id for one agent in one conversation (a
 * thread, or a channel/DM without threads): a UUID derived from both, so the
 * engine needs to store nothing to resume it (the runner checks the
 * machine's disk to pick `--resume` or `--session-id`).
 */
export function brainSessionId(agentId: string, conversation: string, salt = "claude_code"): string {
  const h = createHash("sha256").update(`${salt}:${agentId}:${conversation}`).digest("hex");
  // RFC 4122 layout, version 5-style (name-based) and the variant bits.
  const v = `5${h.slice(13, 16)}`;
  const variant = ((Number.parseInt(h.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${v}-${variant}-${h.slice(20, 32)}`;
}

const err = (code: string, message: string, retryable: boolean): BrainEvent => ({
  type: "error",
  code,
  message,
  retryable,
});

/** Why the turn can't go to this machine now (null: it can). */
export function claudeCodeAvailability(status: MachineStatus | null): BrainEvent | null {
  if (!status) return err("machine_offline", "The agent's computer is not connected to the organization.", true);
  if (!status.online) return err("machine_offline", `Claude Code on ${status.name} is offline.`, true);
  if (status.paused) {
    return err("machine_paused", pausedMessage(status.name, status.paused.until, status.paused.timezone), true);
  }
  // A machine that reports its tools (protocol 10, the desktop app) runs Claude Code when that tool is on,
  // whatever "commands" says (the runner checks the same); an older runner follows its `exec` switch.
  const off = toolOff(status, "claude");
  if (off) return err(off.code, off.message, true);
  if (status.protocol < BRAIN_PROTOCOL) {
    return err(
      "runner_outdated",
      `The runner on ${status.name} is too old for agents that think with Claude Code; update it (agentes-runner update).`,
      true,
    );
  }
  const ex = status.executors ?? {};
  if (ex.detectedAt && !ex.claude) return err("cli_missing", `Claude Code is not installed on ${status.name}.`, true);
  if (ex.claude?.loggedIn === false) {
    return err("not_logged_in", `Claude Code on ${status.name} is not logged in (run claude auth login there).`, true);
  }
  return null;
}

/**
 * Whether the machine refuses this coding CLI: its tool switched off (protocol
 * 10, `access.tools`), or commands off on a runner that doesn't report tools.
 */
export function toolOff(
  status: Pick<MachineStatus, "name" | "execAllowed" | "access">,
  tool: "claude" | "codex",
): { code: string; message: string } | null {
  const tools = status.access?.tools;
  const name = tool === "claude" ? "Claude Code" : "Codex";
  if (tools) {
    return tools[tool] === true
      ? null
      : {
          code: "tool_off",
          message: `${name} is turned off on ${status.name} (its owner can turn it on in the agentes app).`,
        };
  }
  return status.execAllowed ? null : { code: "exec_disabled", message: `Commands are turned off on ${status.name}.` };
}

/** A failed `brain.turn` request as the turn's error. */
export function claudeCodeCallError(error: unknown): BrainEvent {
  if (error instanceof MachineOfflineError) return err("machine_offline", error.message, true);
  if (error instanceof MachinePausedError) return err("machine_paused", error.message, true);
  if (error instanceof MachineRequestError) {
    switch (error.code) {
      case "canceled":
        return err("canceled", "The turn was canceled.", false);
      case "timeout":
        return err("timeout", error.message, false);
      case "exec_disabled":
        return err("exec_disabled", error.message, true);
      case "no_slot":
        return err("busy", error.message, true);
      case "internal":
        if (error.message === "busy") return err("busy", "The computer is busy with other requests.", true);
        return err("runner_error", error.message, false);
      case "bad_request":
        if (/unknown op|no brain turns/i.test(error.message)) return err("runner_outdated", error.message, true);
        return err("bad_request", error.message, false);
      default:
        return err("runner_error", error.message, false);
    }
  }
  return err("runner_error", error instanceof Error ? error.message : String(error), false);
}

const toBrainEvent = (e: WireBrainEvent): BrainEvent => e as BrainEvent;
const isFinal = (e: BrainEvent) => e.type === "done" || e.type === "error";

type Item = { kind: "event"; event: BrainEvent } | { kind: "stream_end" } | { kind: "reply"; final: BrainEvent };

/** A tiny async queue with an optional wait limit. */
class Queue {
  private items: Item[] = [];
  private waiter: ((item: Item | null) => void) | null = null;

  push(item: Item) {
    const w = this.waiter;
    if (w) {
      this.waiter = null;
      w(item);
    } else this.items.push(item);
  }

  next(timeoutMs?: number): Promise<Item | null> {
    const item = this.items.shift();
    if (item) return Promise.resolve(item);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      this.waiter = (i) => {
        if (timer) clearTimeout(timer);
        resolve(i);
      };
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.waiter = null;
          resolve(null);
        }, timeoutMs);
      }
    });
  }
}

export function createClaudeCodeBrain(deps: ClaudeCodeBrainDeps): Brain {
  return {
    kind: "claude_code",
    async *run(turn: BrainTurn, io: BrainIO): AsyncIterable<BrainEvent> {
      const session = turn.session;
      if (!session) {
        yield err("no_session", "This agent has no computer for Claude Code.", true);
        return;
      }
      const status = await deps.hub.status(session.machineId).catch(() => null);
      const unavailable = claudeCodeAvailability(status);
      if (unavailable) {
        yield unavailable;
        return;
      }
      const queue = new Queue();
      const off = deps.pubsub.subscribe(brainTopic(turn.runId), (e) => {
        // Only the agent's own computer speaks for this run.
        if (e.machineId !== session.machineId) return;
        if (e.type === "brain.done") return queue.push({ kind: "stream_end" });
        if (e.type !== "brain.event") return;
        const event = parseBrainEvent(e.event);
        if (event) queue.push({ kind: "event", event: toBrainEvent(event) });
      });
      try {
        const [agent, personalMcp] = await Promise.all([
          deps.agentScope(turn),
          Promise.resolve(deps.personalMcp?.(turn) ?? false),
        ]);
        const permissions = await deps.permissions?.(turn);
        const code = await deps.prepare?.(turn, io.signal).catch(() => null);
        const request: BrainTurnRequest = {
          runId: turn.runId,
          kind: "claude_code",
          session: { id: session.id, resume: session.resume },
          cwd: code?.cwd || session.cwd,
          ...(turn.model ? { model: turn.model } : {}),
          system: code?.prompt ? `${turn.system}\n\n${code.prompt}` : turn.system,
          prompt: computerPrompt(turn),
          mcp: { token: deps.mcpToken?.(turn) ?? randomBytes(24).toString("base64url") },
          keepAlive: deps.keepAlive !== false,
          personalMcp,
          ...(permissions ? { permissions } : {}),
        };
        deps.hub
          .call<"brain.turn">(
            session.machineId,
            { op: "brain.turn", ...request, agent },
            { signal: io.signal, ...(deps.timeoutMs ? { timeoutMs: deps.timeoutMs } : {}) },
          )
          .then(
            (reply) => {
              const final = parseBrainEvent(reply?.final);
              queue.push({
                kind: "reply",
                final:
                  final && isFinal(toBrainEvent(final))
                    ? toBrainEvent(final)
                    : err("runner_error", "The computer answered without an end to the turn.", false),
              });
            },
            (error: unknown) => queue.push({ kind: "reply", final: claudeCodeCallError(error) }),
          );
        let streamEnded = false;
        let replyFinal: BrainEvent | null = null;
        for (;;) {
          const item = await queue.next(replyFinal ? (streamEnded ? 0 : (deps.finalGraceMs ?? 1500)) : undefined);
          if (item === null) {
            if (replyFinal) yield replyFinal;
            return;
          }
          if (item.kind === "event") {
            yield item.event;
            if (isFinal(item.event)) return;
          } else if (item.kind === "stream_end") {
            streamEnded = true;
          } else {
            replyFinal = item.final;
          }
        }
      } finally {
        off();
      }
    },
  };
}

/**
 * Records a computer brain's plan usage (source "plan"): tokens with the
 * run, agent and org, cost zero, billed to the owner's plan. The engine calls
 * it for each `usage` event with `source: "plan"` (the Model Gateway records
 * API usage itself).
 */
export async function recordPlanUsage(
  db: Database,
  input: {
    orgId: string;
    agentId: string;
    runId: string;
    /** `claude_code` or `codex`. */
    provider: string;
    model?: string;
    inputTokens: number;
    outputTokens: number;
  },
): Promise<string | null> {
  const [row] = await db
    .insert(schema.usageRecords)
    .values({
      orgId: input.orgId,
      agentId: input.agentId,
      kind: "agent",
      runId: input.runId,
      credentialId: null,
      provider: input.provider,
      model: input.model ?? input.provider,
      requestedModel: input.model ?? input.provider,
      inputTokens: Math.max(0, Math.round(input.inputTokens)),
      outputTokens: Math.max(0, Math.round(input.outputTokens)),
      costNanoUsd: 0,
      billedTo: "plan",
    })
    .returning({ id: schema.usageRecords.id });
  return row?.id ?? null;
}
