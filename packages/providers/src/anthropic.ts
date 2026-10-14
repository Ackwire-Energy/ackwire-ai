import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
  BetaTextBlockParam,
  BetaTool,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { MODEL_CATALOG } from "./catalog";
import {
  type ContentBlock,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  type PartialUsage,
  ProviderError,
  type StopReason,
} from "./types";

/**
 * Anthropic Messages API, streaming. A client is created per call with the
 * org's decrypted key (never cached or logged).
 *
 * - Prompt caching: every system block marked `cache` gets a breakpoint (the
 *   org context and the agent instructions are stable), and top-level
 *   automatic caching covers the growing conversation in tool loops. Tools
 *   are sorted by name so their prefix is deterministic.
 * - Tool use: client tools with `eager_input_streaming`; inputs are validated
 *   by the Tool Gateway before anything runs. Thinking and other provider
 *   blocks come back as `opaque` and are replayed unchanged.
 * - Structured output: `outputSchema` maps to `output_config.format`.
 * - Models flagged `serverSideFallback` opt into Anthropic's server-side
 *   refusal fallback; the answering model is reported back for pricing.
 * - Mid-stream failures carry the usage seen so far (`ProviderError.partial`).
 */
export function createAnthropicProvider(
  options: { baseURL?: string; maxRetries?: number /** Tests only: scripted transport. */; fetch?: typeof fetch } = {},
): ModelProvider {
  const client = (apiKey: string, workspaceId?: string) =>
    new Anthropic({
      apiKey,
      baseURL: options.baseURL,
      maxRetries: options.maxRetries ?? 2,
      fetch: options.fetch,
      // Keys not scoped to a workspace must name one on every request.
      ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}),
    });

  return {
    id: "anthropic",
    async stream(request, { apiKey, workspaceId, onDelta }): Promise<ModelResult> {
      const fallback = MODEL_CATALOG[request.model]?.serverSideFallback === true;
      const partial: PartialUsage = {
        inputTokens: null,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: null,
        outputChars: 0,
      };
      try {
        const stream = client(apiKey, workspaceId).beta.messages.stream(
          {
            model: request.model,
            max_tokens: request.maxTokens,
            system: toSystem(request),
            messages: request.messages.map(toMessageParam),
            cache_control: { type: "ephemeral" },
            ...(request.tools && request.tools.length > 0 ? { tools: toTools(request) } : {}),
            ...(request.outputSchema || request.effort
              ? {
                  output_config: {
                    ...(request.outputSchema
                      ? { format: { type: "json_schema" as const, schema: request.outputSchema } }
                      : {}),
                    ...(request.effort ? { effort: request.effort } : {}),
                  },
                }
              : {}),
            ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          },
          { signal: request.signal },
        );
        stream.on("streamEvent", (event) => {
          if (event.type === "message_start") {
            partial.inputTokens = event.message.usage.input_tokens;
            partial.cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0;
            partial.cacheWriteTokens = event.message.usage.cache_creation_input_tokens ?? 0;
          } else if (event.type === "message_delta") {
            partial.outputTokens = event.usage.output_tokens;
          } else if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
            partial.outputChars += event.delta.partial_json.length;
          }
        });
        stream.on("text", (delta) => {
          partial.outputChars += delta.length;
          onDelta(delta);
        });
        const message = await stream.finalMessage();
        const content = message.content.map(fromContentBlock);
        return {
          text: content.map((b) => (b.type === "text" ? b.text : "")).join(""),
          content,
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
        const mapped = toProviderError(error);
        if (partial.inputTokens !== null || partial.outputChars > 0) mapped.partial = partial;
        throw mapped;
      }
    },

    async countTokens(request, { apiKey, workspaceId }) {
      try {
        const result = await client(apiKey, workspaceId).beta.messages.countTokens({
          model: request.model,
          system: toSystem(request),
          messages: request.messages.map(toMessageParam),
          ...(request.tools && request.tools.length > 0 ? { tools: toTools(request) } : {}),
        });
        return result.input_tokens;
      } catch (error) {
        throw toProviderError(error);
      }
    },
  };
}

function toSystem(request: ModelRequest): BetaTextBlockParam[] {
  if (typeof request.system === "string") {
    return [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }];
  }
  return request.system
    .filter((b) => b.text.length > 0)
    .map((b) => ({
      type: "text" as const,
      text: b.text,
      ...(b.cache ? { cache_control: { type: "ephemeral" } } : {}),
    }));
}

function toTools(request: ModelRequest): BetaTool[] {
  return [...(request.tools ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as BetaTool["input_schema"],
      eager_input_streaming: true,
    }));
}

function toMessageParam(message: ModelMessage): BetaMessageParam {
  if (typeof message.content === "string") return { role: message.role, content: message.content };
  return { role: message.role, content: message.content.map(toBlockParam) };
}

function toBlockParam(block: ContentBlock): BetaContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        ...(block.isError ? { is_error: true } : {}),
      };
    case "opaque":
      // Replayed exactly as received (thinking blocks keep their signature).
      return block.data as unknown as BetaContentBlockParam;
  }
}

function fromContentBlock(block: BetaContentBlock): ContentBlock {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "tool_use")
    return { type: "tool_use", id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> };
  return { type: "opaque", provider: "anthropic", data: block as unknown as Record<string, unknown> };
}

function mapStopReason(reason: string | null): StopReason {
  if (reason === "end_turn" || reason === "max_tokens" || reason === "refusal" || reason === "tool_use") return reason;
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
  if (error instanceof Anthropic.APIUserAbortError) return new ProviderError("request aborted", false);
  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    return new ProviderError(`provider rejected the request (${status ?? "?"})`, status === 529, status);
  }
  // With eager input streaming a tool input can arrive as unparseable JSON: retrying the turn is the fix.
  if (error instanceof Anthropic.AnthropicError || error instanceof SyntaxError) {
    return new ProviderError(`could not read the model's reply: ${error.message}`, true);
  }
  return new ProviderError(error instanceof Error ? error.message : String(error), false);
}
