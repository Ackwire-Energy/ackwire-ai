import type { BrainEffort } from "@agenteschat/adapters";

export type BrainKind = "model" | "claude_code" | "codex";

/** Brains that run on the agent's computer with a person's plan. */
export const isComputerBrain = (v: unknown): v is "claude_code" | "codex" => v === "claude_code" || v === "codex";

/** The account a computer brain runs with (ADR 0041): a folder on the agent's machine. */
export interface BrainAccount {
  id: string;
  /** What people call it, for messages. */
  label: string;
  status: "active" | "signed_out";
  /** A key account's coding plan (`zai`…), which names the models it runs. */
  provider?: string;
}

/** A tool as the engine offers it to a brain (same data the Tool Gateway lists for the run). */
export interface BrainTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema object
}

/** What a computer brain needs to reach the agent's machine. */
export interface BrainSession {
  /** Stable per thread (or per mission session): the executor's session id. */
  id: string;
  /** True when the session already exists on the machine (resume), false to start it. */
  resume: boolean;
  machineId: string;
  /** Folder on the machine (relative to the agent folder), e.g. "" or a mission repo dir. */
  cwd: string;
}

export interface BrainTurn {
  runId: string;
  orgId: string;
  agentId: string;
  channelId: string;
  threadRootId: string | null;
  /** The engine-built context (context.ts): system text + conversation, same for every brain. */
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** Tools this run may use (from the Tool Gateway, scopes applied). */
  tools: BrainTool[];
  /** Model id or alias for this brain ("claude-opus-5-5", "opus", "sonnet", "gpt-…"); undefined = brain default. */
  model?: string;
  /** Computer brains only. */
  session?: BrainSession;
  /** Computer brains: the account to run with (absent: the computer's own sign-in). */
  account?: BrainAccount;
  /** How hard it thinks (absent: the CLI's or the API's default); the model brain only gets one from "Automático". */
  effort?: BrainEffort;
  /** Computer brains: the agent's context limit in tokens (`agents.context_tokens`); absent: the model's window. */
  contextTokens?: number;
  /** The text the person/system sent that starts this turn (also the last user message). */
  trigger: string;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** The call is gated: the run pauses until a person decides (ADR 0015 approval or ask_user). */
  pause?: { kind: "approval" | "input"; id: string };
}

/** A person's message handed to a computer brain's turn in progress (live steering). */
export interface SteerMessage {
  /** A fresh UUID per handoff: `steer_read` names it once the turn read it. */
  uuid: string;
  /** Rendered as the loop renders messages read between turns. */
  text: string;
  /** "Parar e mandar": read now (the running tool moved to the background); a brain that can't is `unsupported`. */
  urgent?: boolean;
}

/**
 * `accepted`: handed to the turn (read later: `steer_read`). `unsupported`:
 * this turn can't take messages mid-turn (they wait for its end), or not an
 * urgent one (the turn is stopped and started again instead). `no_turn`: the
 * turn isn't there (just ended, or not started yet).
 */
export type SteerReply =
  | { status: "accepted"; accepted: string[] }
  | { status: "unsupported" | "no_turn"; reason?: string };

export interface BrainIO {
  signal: AbortSignal;
  /** Model brain: the engine executes tool calls through the Tool Gateway. */
  executeTool(call: { id: string; name: string; input: unknown }): Promise<ToolResult>;
  /**
   * Computer brains that can take messages mid-turn (Claude Code on runner
   * protocol 15) hand the engine a way to, once the turn is on its way, and
   * `null` when it ends. Brains that can't never call it.
   */
  steerable?(steer: ((messages: SteerMessage[]) => Promise<SteerReply>) | null): void;
}

export type BrainEvent =
  | { type: "text_delta"; text: string }
  /** `executed` present = already executed elsewhere (computer brains via the MCP bridge): the engine only records/displays it. */
  | { type: "tool_call"; id: string; name: string; input: unknown; executed?: ToolResult }
  | {
      type: "usage";
      /** Every input token the turn read (cache included); `cacheRead`/`cacheWrite` say how much of it was cache. */
      input: number;
      output: number;
      source: "api" | "plan";
      model?: string;
      cacheRead?: number;
      cacheWrite?: number;
    }
  | { type: "limit"; resetsAt?: string }
  | { type: "done"; text: string; session?: { id: string } }
  | {
      type: "error";
      code: string;
      message: string;
      retryable?: boolean;
      /** The computer dropped because our own server stopped (a restart): never from the runner's wire. */
      serverStop?: boolean;
    }
  /** Messages handed mid-turn (`BrainIO.steerable`) that the turn read, by their `uuid`. */
  | { type: "steer_read"; uuids: string[] };

export interface Brain {
  kind: BrainKind;
  run(turn: BrainTurn, io: BrainIO): AsyncIterable<BrainEvent>;
}
