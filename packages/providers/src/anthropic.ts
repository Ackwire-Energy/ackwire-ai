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
  stableToolsFirst,
  type ToolSpec,
} from "./types";

/** The tool a compatible endpoint gives structured output through: its input is the reply. */
const STRUCTURED_OUTPUT = "structured_output";

/** Lets a request say what happens to thinking the API can no longer read back (`block_binding`). */
const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01";

/** What the API said about a refused request, at most (it ends up on the run's error). */
const API_ERROR_CHARS = 300;

/**
 * Anthropic Messages API, streaming. A client is created per call with the
 * org's decrypted key (never cached or logged).
 *
 * - Prompt caching: the stable tools go first (`ToolSpec.stable`) with a
 *   breakpoint after the last one, so loading a tool group keeps them cached;
 *   every system block marked `cache` gets a breakpoint (the latest ones when
 *   the 4 allowed would be passed), and top-level automatic caching covers
 *   the growing conversation in tool loops. Each part of the tools is sorted
 *   by name so its prefix is deterministic. `cacheTtl: "1h"` makes the tool and
 *   system breakpoints last an hour; the automatic one stays at 5 minutes
 *   (longer entries must come first).
 * - Tool use: client tools with `eager_input_streaming`; inputs are validated
 *   by the Tool Gateway before anything runs. Thinking and other provider
 *   blocks come back as `opaque` and are replayed unchanged, only to the
 *   provider that wrote them.
 * - Preserved thinking: Claude reads a thinking block back only while the
 *   system prompt, the tools and every message before it are the ones it was
 *   written with, and refuses the call otherwise (accounts created since
 *   2026-08-31). A run's tools change between calls (a computer that stops
 *   answering, a permission turned on), so the API is asked to drop such a
 *   block instead. It drops every later thinking block with it, so the reply
 *   to that call is a `restart`: the thinking before it is never sent again.
 *   A call refused for its thinking all the same goes once more without any,
 *   and its reply is a `restart` too. Both show on `ModelResult.thinking`.
 * - Structured output: `outputSchema` maps to `output_config.format`.
 * - Models flagged `serverSideFallback` opt into Anthropic's server-side
 *   refusal fallback; the answering model is reported back for pricing.
 * - Mid-stream failures carry the usage seen so far (`ProviderError.partial`);
 *   a refused request keeps the API's error type and words.
 *
 * `compat` points it at another company's Anthropic-compatible endpoint
 * (`baseURL`, `id`). It keeps the beta client and the system blocks' cache
 * breakpoints, and leaves out what they don't all take: top-level caching
 * (each caches prompt prefixes by itself), fallbacks, eager input
 * streaming, `countTokens` and `output_config.format`. Structured output is a
 * `structured_output` tool, forced where `tool_choice: any` is honored, and
 * its input comes back as the reply's JSON text. Medium effort is sent as
 * `high`: Kimi and GLM take only low, high and max.
 */
export function createAnthropicProvider(
  options: {
    /** The provider's id in `PROVIDERS`. */
    id?: string;
    baseURL?: string;
    compat?: { toolChoiceAny: boolean };
    maxRetries?: number;
    /** Tests only: scripted transport. */
    fetch?: typeof fetch;
  } = {},
): ModelProvider {
  const id = options.id ?? "anthropic";
  const { compat } = options;
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
    id,
    async stream(request, { apiKey, workspaceId, onDelta }): Promise<ModelResult> {
      const info = MODEL_CATALOG[request.model];
      const fallback = !compat && info?.serverSideFallback === true;
      const format = compat ? undefined : request.outputSchema;
      const answerSchema = compat ? request.outputSchema : undefined;
      const tools = [
        ...toTools(request.tools ?? [], !compat, compat ? undefined : cacheControl(request)),
        ...(answerSchema
          ? [
              {
                name: STRUCTURED_OUTPUT,
                description:
                  "Answer by calling this tool once, with your whole answer as its input. Don't answer in text.",
                input_schema: answerSchema as BetaTool["input_schema"],
              },
            ]
          : []),
      ];
      // `none`: thinking off where the model allows it, `low` elsewhere. With thinking off a compatible
      // endpoint gets no effort: MiniMax takes one only on the model that always thinks.
      const thinkingOff = request.effort === "none" && info?.leastThinking === "off";
      const asked = request.effort === "none" ? (thinkingOff && compat ? undefined : "low") : request.effort;
      const effort = compat && asked === "medium" ? "high" : asked;
      const partial: PartialUsage = {
        inputTokens: null,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: null,
        outputChars: 0,
      };
      const call = async (withThinking: boolean): Promise<ModelResult> => {
        // `block_binding` is taken only with thinking on; the call made without thinking goes plain.
        const bind = withThinking && !compat && !thinkingOff;
        const betas = [
          ...(fallback ? ["server-side-fallback-2026-07-01"] : []),
          ...(bind ? [THINKING_BINDING_BETA] : []),
        ];
        const stream = client(apiKey, workspaceId).beta.messages.stream(
          {
            model: request.model,
            max_tokens: request.maxTokens,
            system: toSystem(request, compat ? undefined : room(request)),
            messages: toMessageParams(request.messages, id, withThinking),
            ...(compat ? {} : { cache_control: { type: "ephemeral" as const } }),
            ...(tools.length > 0 ? { tools } : {}),
            ...(answerSchema && compat?.toolChoiceAny ? { tool_choice: { type: "any" as const } } : {}),
            ...(thinkingOff
              ? { thinking: { type: "disabled" as const } }
              : bind
                ? {
                    thinking: {
                      type: "adaptive" as const,
                      block_binding: { prefix_mismatch_behavior: "drop_block" as const },
                    },
                  }
                : {}),
            ...(format || effort
              ? {
                  output_config: {
                    ...(format ? { format: { type: "json_schema" as const, schema: format } } : {}),
                    ...(effort ? { effort } : {}),
                  },
                }
              : {}),
            ...(betas.length > 0 ? { betas } : {}),
            ...(fallback ? { fallbacks: "default" as const } : {}),
          },
          { signal: request.signal },
        );
        stream.on("streamEvent", (event) => {
          if (event.type === "message_start") {
            partial.inputTokens = event.message.usage.input_tokens;
            partial.cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0;
            partial.cacheWriteTokens = event.message.usage.cache_creation_input_tokens ?? 0;
            const long = event.message.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
            if (long > 0) partial.cacheWriteLongTokens = long;
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
        const dropped: Record<string, number> = {};
        for (const t of message.input_transformations ?? [])
          if (t.type === "thinking_dropped") dropped[t.reason] = (dropped[t.reason] ?? 0) + 1;
        const blocks = message.content.map((b) => fromContentBlock(b, id));
        const answer = answerSchema ? blocks.find(isAnswer) : undefined;
        // The answer as `output_config.format` gives it: the JSON as the only text, after any thinking.
        const content: ContentBlock[] = answer
          ? [...blocks.filter((b) => b.type === "opaque"), { type: "text", text: JSON.stringify(answer.input) }]
          : blocks;
        // Only a prefix mismatch takes the later blocks with it; one another model wrote (a fallback) goes alone.
        const [first] = content;
        if (first && (!withThinking || dropped.prefix_binding_mismatch)) first.restart = id;
        return {
          text: content.map((b) => (b.type === "text" ? b.text : "")).join(""),
          content,
          model: message.model,
          stopReason: answer ? "end_turn" : mapStopReason(message.stop_reason),
          usage: {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
            cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
            ...((message.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0
              ? { cacheWriteLongTokens: message.usage.cache_creation?.ephemeral_1h_input_tokens }
              : {}),
          },
          ...(Object.keys(dropped).length > 0 ? { thinking: { dropped } } : {}),
        };
      };
      const failure = (error: unknown) => {
        const mapped = toProviderError(error);
        if (partial.inputTokens !== null || partial.outputChars > 0) mapped.partial = partial;
        return mapped;
      };
      let refused: string;
      try {
        return await call(true);
      } catch (error) {
        if (!refusesThinking(error)) throw failure(error);
        refused = toProviderError(error).message;
      }
      try {
        return { ...(await call(false)), thinking: { refused } };
      } catch (error) {
        const last = failure(error);
        throw new ProviderError(
          `${refused} (sent again without its thinking: ${last.message})`,
          last.retryable,
          last.status,
          last.partial,
        );
      }
    },

    ...(compat
      ? {}
      : {
          async countTokens(request: ModelRequest, { apiKey, workspaceId }: { apiKey: string; workspaceId?: string }) {
            try {
              const result = await client(apiKey, workspaceId).beta.messages.countTokens({
                model: request.model,
                system: toSystem(request),
                messages: toMessageParams(request.messages, id),
                ...(request.tools && request.tools.length > 0 ? { tools: toTools(request.tools, true) } : {}),
              });
              return result.input_tokens;
            } catch (error) {
              throw toProviderError(error);
            }
          },
        }),
  };
}

const isAnswer = (b: ContentBlock): b is Extract<ContentBlock, { type: "tool_use" }> =>
  b.type === "tool_use" && b.name === STRUCTURED_OUTPUT;

/** Breakpoints a request may carry. */
const MAX_BREAKPOINTS = 4;

type CacheControl = { type: "ephemeral"; ttl?: "1h" };

const cacheControl = (request: ModelRequest): CacheControl =>
  request.cacheTtl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };

/** The system's breakpoints: what is left after the automatic one and the stable tools' one. */
const room = (request: ModelRequest) => ({
  control: cacheControl(request),
  max: MAX_BREAKPOINTS - 1 - (request.tools?.some((t) => t.stable) ? 1 : 0),
});

/**
 * The system as blocks, a breakpoint after each one marked `cache` (the latest `max` of them, so the request stays
 * within the 4 allowed). Without `breakpoints` (another company's endpoint) they stay plain 5-minute ones.
 */
function toSystem(request: ModelRequest, breakpoints?: { control: CacheControl; max: number }): BetaTextBlockParam[] {
  const control = breakpoints?.control ?? { type: "ephemeral" as const };
  if (typeof request.system === "string") {
    return [{ type: "text", text: request.system, cache_control: control }];
  }
  const blocks = request.system.filter((b) => b.text.length > 0);
  const marked = blocks.filter((b) => b.cache);
  const kept = new Set(breakpoints ? marked.slice(Math.max(0, marked.length - breakpoints.max)) : marked);
  return blocks.map((b) => ({
    type: "text" as const,
    text: b.text,
    ...(kept.has(b) ? { cache_control: control } : {}),
  }));
}

/**
 * The stable tools first, then the others, each part by name; `control`: a breakpoint after the last stable tool
 * (another company's endpoint gets none).
 */
function toTools(tools: ToolSpec[], eager: boolean, control?: CacheControl): BetaTool[] {
  const ordered = stableToolsFirst(tools);
  const last = ordered.filter((t) => t.stable).length - 1;
  return ordered.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as BetaTool["input_schema"],
    ...(eager ? { eager_input_streaming: true } : {}),
    ...(control && i === last ? { cache_control: control } : {}),
  }));
}

const isThinking = (data: Record<string, unknown>) => data.type === "thinking" || data.type === "redacted_thinking";

/**
 * The messages as sent: the thinking before the last `restart` is left out, and all of it without
 * `withThinking`. A message left empty goes too (the API merges the turns around it).
 */
function toMessageParams(messages: ModelMessage[], provider: string, withThinking = true): BetaMessageParam[] {
  let from = 0;
  messages.forEach((m, i) => {
    if (typeof m.content !== "string" && m.content.some((b) => b.restart === provider)) from = i;
  });
  return messages
    .map((m, i) => toMessageParam(m, provider, withThinking && i >= from))
    .filter((m) => typeof m.content === "string" || m.content.length > 0);
}

function toMessageParam(message: ModelMessage, provider: string, thinking: boolean): BetaMessageParam {
  if (typeof message.content === "string") return { role: message.role, content: message.content };
  return { role: message.role, content: message.content.flatMap((b) => toBlockParam(b, provider, thinking)) };
}

function toBlockParam(block: ContentBlock, provider: string, thinking: boolean): BetaContentBlockParam[] {
  switch (block.type) {
    case "text":
      return [{ type: "text", text: block.text }];
    case "tool_use":
      return [{ type: "tool_use", id: block.id, name: block.name, input: block.input }];
    case "tool_result":
      return [
        {
          type: "tool_result",
          tool_use_id: block.toolUseId,
          content: block.content,
          ...(block.isError ? { is_error: true } : {}),
        },
      ];
    case "opaque":
      // Replayed exactly as received (thinking keeps its signature); another provider's would be refused.
      if (block.provider !== provider || (!thinking && isThinking(block.data))) return [];
      return [block.data as unknown as BetaContentBlockParam];
  }
}

function fromContentBlock(block: BetaContentBlock, provider: string): ContentBlock {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "tool_use")
    return { type: "tool_use", id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> };
  return { type: "opaque", provider, data: block as unknown as Record<string, unknown> };
}

/** A 400 about the thinking sent back (a signature it can't verify, a block out of place): worth a call without it. */
const refusesThinking = (error: unknown) =>
  error instanceof Anthropic.BadRequestError && /thinking|signature/i.test(error.message);

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
    const body = error.error as { error?: { message?: unknown } } | undefined;
    const said =
      typeof body?.error?.message === "string"
        ? body.error.message.replace(/\s+/g, " ").trim().slice(0, API_ERROR_CHARS)
        : "";
    const what = [status ?? "?", error.type].filter(Boolean).join(" ");
    return new ProviderError(
      `provider rejected the request (${what})${said ? `: ${said}` : ""}`,
      status === 529,
      status,
    );
  }
  // With eager input streaming a tool input can arrive as unparseable JSON: retrying the turn is the fix.
  if (error instanceof Anthropic.AnthropicError || error instanceof SyntaxError) {
    return new ProviderError(`could not read the model's reply: ${error.message}`, true);
  }
  return new ProviderError(error instanceof Error ? error.message : String(error), false);
}
