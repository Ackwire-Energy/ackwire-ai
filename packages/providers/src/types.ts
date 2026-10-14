/**
 * Provider-neutral model interface. Only the Model Gateway
 * (`@agenteschat/engine`, `createModelGateway`) calls it: no other code talks
 * to a model, and API keys never leave the backend.
 */
export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  model: string;
  system: string;
  /** Must start and end with a `user` turn; roles alternate. */
  messages: ModelMessage[];
  maxTokens: number;
  signal?: AbortSignal;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type StopReason = "end_turn" | "max_tokens" | "refusal" | "other";

export interface ModelResult {
  text: string;
  /** Model that actually answered: may differ from the request after a server-side fallback. */
  model: string;
  stopReason: StopReason;
  usage: ModelUsage;
}

export interface StreamOptions {
  apiKey: string;
  /** Called with each text fragment as it is generated. */
  onDelta(text: string): void;
}

export interface ModelProvider {
  readonly id: string;
  stream(request: ModelRequest, options: StreamOptions): Promise<ModelResult>;
}

/** A provider failure. `retryable` drives the outbox retry (rate limits, overload, network). */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
