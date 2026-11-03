/**
 * Provider-neutral model interface. Only the Model Gateway
 * (`@agenteschat/engine`, `createModelGateway`) calls it: no other code talks
 * to a model, and API keys never leave the backend.
 */

/** A piece of a message. Provider-specific blocks (thinking, fallback markers) travel as `opaque`. */
export type ContentBlock = (
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean }
  /**
   * A block we don't interpret (e.g. Anthropic `thinking` with its signature).
   * It must be sent back to the same provider exactly as received when the
   * conversation continues (tool loops), so we keep the raw object.
   */
  | { type: "opaque"; provider: string; data: Record<string, unknown> }
) & {
  /**
   * On the first block of a reply written while the thinking sent back was left out (Anthropic dropped or
   * refused it), with or without thinking of its own: the provider with this id never sends the thinking before
   * this message again, or the API would drop or refuse the thinking written after it too.
   */
  restart?: string;
};

export interface ModelMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

/** A block of the system prompt. `cache` marks a prompt-cache breakpoint after this block. */
export interface SystemBlock {
  text: string;
  cache?: boolean;
}

export type SystemPrompt = string | SystemBlock[];

/** A tool the model may call. Execution never happens in the provider: callers run tools (Tool Gateway). */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (object) of the tool input. */
  inputSchema: Record<string, unknown>;
  /**
   * The same in every run of the agent, whatever else loads: the stable tools are sent first and the others after
   * (each part sorted by name), with a prompt-cache breakpoint after the last stable one where the provider takes it,
   * so loading a tool group doesn't throw away the cached tools before it.
   */
  stable?: boolean;
}

export interface ModelRequest {
  model: string;
  system: SystemPrompt;
  /** Must start with a `user` turn; roles alternate. */
  messages: ModelMessage[];
  maxTokens: number;
  tools?: ToolSpec[];
  /** JSON Schema the reply must follow (structured output). The reply text is then JSON. */
  outputSchema?: Record<string, unknown>;
  /**
   * How much reasoning to spend. Providers without the notion ignore it. Default: the provider's.
   * `none`: the least the model allows (its catalog `leastThinking`), else `low`.
   */
  effort?: "none" | "low" | "medium" | "high";
  /**
   * `1h`: the breakpoints of the stable prefix (stable tools, system blocks marked `cache`) last an hour where the
   * provider offers it (Anthropic's extended TTL, written at 2× the input price); the conversation's tail keeps the
   * 5-minute default. Absent: 5 minutes everywhere.
   */
  cacheTtl?: "1h";
  signal?: AbortSignal;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Of `cacheWriteTokens`, those written to the 1-hour cache (`cacheTtl`), priced higher; absent: none. */
  cacheWriteLongTokens?: number;
}

export type StopReason = "end_turn" | "max_tokens" | "refusal" | "tool_use" | "other";

export interface ModelResult {
  /** Concatenated text blocks. */
  text: string;
  /** Every block of the reply, in order (text, tool calls, opaque provider blocks). */
  content: ContentBlock[];
  /** Model that actually answered: may differ from the request after a server-side fallback. */
  model: string;
  stopReason: StopReason;
  usage: ModelUsage;
  /** What the provider says the call cost (OpenRouter's `usage.cost`); absent: priced from the catalog. */
  costNanoUsd?: number;
  /**
   * Thinking sent back that the call went without (Anthropic): the blocks the API dropped, by reason, or the
   * refusal that sent the call again without any.
   */
  thinking?: { dropped?: Record<string, number>; refused?: string };
}

export interface StreamOptions {
  apiKey: string;
  /** Account scoping some providers need (Anthropic: `anthropic-workspace-id`). */
  workspaceId?: string;
  /** OpenAI organization and project (headers), when the key needs them. */
  organization?: string;
  project?: string;
  /** Called with each text fragment as it is generated. */
  onDelta(text: string): void;
}

export interface ModelProvider {
  readonly id: string;
  stream(request: ModelRequest, options: StreamOptions): Promise<ModelResult>;
  /** Exact input-token count of a request (provider API). Optional: callers fall back to an estimate. */
  countTokens?(
    request: ModelRequest,
    options: { apiKey: string; workspaceId?: string; organization?: string; project?: string },
  ): Promise<number>;
}

/** What the provider had already reported or sent when a stream failed. */
export interface PartialUsage {
  /** From the provider's start-of-stream event; null when the stream died before it. */
  inputTokens: number | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Of `cacheWriteTokens`, those written to the 1-hour cache. */
  cacheWriteLongTokens?: number;
  /** Output tokens reported by the provider so far, or null when it reported none. */
  outputTokens: number | null;
  /** Characters of output received (text and tool input), for a local estimate. */
  outputChars: number;
}

/** A provider failure. `retryable` drives the outbox retry (rate limits, overload, network). */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    /** Set when the failure happened mid-stream, so the gateway can bill what was consumed. */
    public partial?: PartialUsage,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Rough token estimate (≈ 4 characters per token), used only when the provider gave no count. */
export const estimateTokens = (chars: number) => Math.ceil(chars / 4);

/** Characters of a request's prompt (system, messages, tools), for estimates. */
export function promptChars(request: Pick<ModelRequest, "system" | "messages" | "tools">): number {
  const system =
    typeof request.system === "string" ? request.system.length : request.system.reduce((n, b) => n + b.text.length, 0);
  let messages = 0;
  for (const m of request.messages)
    messages += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length;
  const tools = request.tools ? JSON.stringify(request.tools).length : 0;
  return system + messages + tools;
}

/** Tools in the order providers send them: the stable ones, then the others, each part sorted by name. */
export const stableToolsFirst = <T extends Pick<ToolSpec, "name" | "stable">>(tools: readonly T[]): T[] => {
  const byName = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  return [...byName.filter((t) => t.stable), ...byName.filter((t) => !t.stable)];
};

/** Concatenated text of a message content. */
export const textOf = (content: string | ContentBlock[]) =>
  typeof content === "string"
    ? content
    : content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");

/** Flattens a system prompt into one string (for providers without blocks, and tests). */
export const systemText = (system: SystemPrompt) =>
  typeof system === "string" ? system : system.map((b) => b.text).join("\n\n");
