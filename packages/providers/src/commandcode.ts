import { createAnthropicProvider } from "./anthropic";
import { createOpenRouterProvider } from "./openrouter";
import { type ModelProvider, type ModelResult, ProviderError } from "./types";

export const COMMANDCODE_API = "https://api.commandcode.ai/provider";

const PREFIX = "commandcode:";

export const isCommandCodeModel = (id: string) => id.startsWith(PREFIX) && id.length > PREFIX.length;

export const commandCodeModelOf = (id: string) => (isCommandCodeModel(id) ? id.slice(PREFIX.length) : null);

// Command Code serves Claude only on Anthropic Messages, every other model only on Chat Completions.
const onMessages = (model: string) => model.startsWith("claude-");

/** Command Code's models (ADR 0174); the full `commandcode:` id comes back, so the catalog prices the call. */
export function createCommandCodeProvider(options: { fetch?: typeof fetch; maxRetries?: number } = {}): ModelProvider {
  const messages = createAnthropicProvider({
    id: "commandcode",
    baseURL: COMMANDCODE_API,
    compat: { toolChoiceAny: true },
    fetch: options.fetch,
    maxRetries: options.maxRetries,
  });
  const chat = createOpenRouterProvider({
    compatible: { id: "commandcode", baseURL: `${COMMANDCODE_API}/v1` },
    fetch: options.fetch,
    maxRetries: options.maxRetries,
  });
  return {
    id: "commandcode",
    async stream(request, streamOptions): Promise<ModelResult> {
      const model = commandCodeModelOf(request.model);
      if (!model) throw new ProviderError(`${request.model} isn't one of Command Code's models`, false);
      const inner = onMessages(model) ? messages : chat;
      const { costNanoUsd: _reported, ...result } = await inner.stream({ ...request, model }, streamOptions);
      return { ...result, model: request.model };
    },
  };
}
