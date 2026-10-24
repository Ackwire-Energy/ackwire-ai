import { createAnthropicProvider } from "./anthropic";
import { PROVIDERS, type ProviderInfo } from "./catalog";
import { createOpenAIProvider } from "./openai";
import type { ModelProvider } from "./types";

export * from "./anthropic";
export * from "./catalog";
export * from "./embeddings";
export * from "./openai";
export * from "./types";

/** One adapter per entry of `PROVIDERS`, by the protocol it speaks: the server's defaults (modules may replace any). */
export function createModelProviders(): Record<string, ModelProvider> {
  return Object.fromEntries(
    (Object.entries(PROVIDERS) as [string, ProviderInfo][]).map(([id, p]) => [
      id,
      p.protocol === "openai"
        ? createOpenAIProvider()
        : createAnthropicProvider({ id, baseURL: p.baseURL, compat: p.compat }),
    ]),
  );
}
