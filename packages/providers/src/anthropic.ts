import Anthropic from "@anthropic-ai/sdk";
import { MODEL_CATALOG } from "./catalog";
import { type ModelProvider, type ModelResult, ProviderError, type StopReason } from "./types";

/**
 * Anthropic Messages API, streaming. A client is created per call with the
 * org's decrypted key (never cached or logged). The system prompt carries a
 * cache breakpoint: org context + agent instructions are stable per agent.
 * Models flagged `serverSideFallback` opt into Anthropic's server-side
 * refusal fallback; the answering model is reported back for pricing.
 */
export function createAnthropicProvider(options: { baseURL?: string; maxRetries?: number } = {}): ModelProvider {
  return {
    id: "anthropic",
    async stream(request, { apiKey, onDelta }): Promise<ModelResult> {
      const client = new Anthropic({ apiKey, baseURL: options.baseURL, maxRetries: options.maxRetries ?? 2 });
      const fallback = MODEL_CATALOG[request.model]?.serverSideFallback === true;
      try {
        const stream = client.beta.messages.stream(
          {
            model: request.model,
            max_tokens: request.maxTokens,
            system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
            messages: request.messages,
            ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          },
          { signal: request.signal },
        );
        stream.on("text", (delta) => onDelta(delta));
        const message = await stream.finalMessage();
        const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
        return {
          text,
          model: message.model,
          stopReason: mapStopReason(message.stop_reason),
          usage: {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
          },
        };
      } catch (error) {
        throw toProviderError(error);
      }
    },
  };
}

function mapStopReason(reason: string | null): StopReason {
  if (reason === "end_turn" || reason === "max_tokens" || reason === "refusal") return reason;
  return "other";
}

function toProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  // Most specific first: rate limits and server errors are worth retrying, bad requests and auth are not.
  if (error instanceof Anthropic.RateLimitError) return new ProviderError("rate limited by provider", true, 429);
  if (error instanceof Anthropic.AuthenticationError) return new ProviderError("invalid provider API key", false, 401);
  if (error instanceof Anthropic.PermissionDeniedError) return new ProviderError("provider denied access", false, 403);
  if (error instanceof Anthropic.InternalServerError) return new ProviderError("provider error", true, error.status);
  if (error instanceof Anthropic.APIConnectionError) return new ProviderError("could not reach provider", true);
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    return new ProviderError(`provider rejected the request (${status ?? "?"})`, status === 529, status);
  }
  return new ProviderError(error instanceof Error ? error.message : String(error), false);
}
