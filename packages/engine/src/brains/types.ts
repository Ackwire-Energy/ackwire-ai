export type BrainKind = "model" | "claude_code" | "codex";

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
  /** The text the person/system sent that starts this turn (also the last user message). */
  trigger: string;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
  /** The call is gated: the run pauses until a person decides (ADR 0015 approval or ask_user). */
  pause?: { kind: "approval" | "input"; id: string };
}

export interface BrainIO {
  signal: AbortSignal;
  /** Model brain: the engine executes tool calls through the Tool Gateway. */
  executeTool(call: { id: string; name: string; input: unknown }): Promise<ToolResult>;
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
  | { type: "error"; code: string; message: string; retryable?: boolean };

export interface Brain {
  kind: BrainKind;
  run(turn: BrainTurn, io: BrainIO): AsyncIterable<BrainEvent>;
}
