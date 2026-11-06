import { createAnthropicProvider } from "./anthropic";
import { PROVIDERS, type ProviderInfo } from "./catalog";
import { createCustomProvider } from "./custom";
import { createGeminiProvider } from "./gemini";
import { createOpenAIProvider } from "./openai";
import { createOpenRouterProvider } from "./openrouter";
import type { ModelProvider } from "./types";

export * from "./anthropic";
export * from "./catalog";
export * from "./context-limits";
export * from "./custom";
export * from "./embeddings";
export * from "./gemini";
export * from "./openai";
export * from "./openrouter";
export * from "./types";

/**
 * One adapter per entry of `PROVIDERS`, by the protocol it speaks: the server's defaults (modules may replace any).
 * `endpointFetch`: how calls reach workspaces' own endpoints (the server's guarded fetch on agentes.chat Cloud).
 */
export function createModelProviders(options: { endpointFetch?: typeof fetch } = {}): Record<string, ModelProvider> {
  return Object.fromEntries(
    (Object.entries(PROVIDERS) as [string, ProviderInfo][]).map(([id, p]) => [
      id,
      p.protocol === "custom"
        ? createCustomProvider({ fetch: options.endpointFetch })
        : p.protocol === "openai"
          ? createOpenAIProvider()
          : p.protocol === "gemini"
            ? createGeminiProvider()
            : p.protocol === "openrouter"
              ? createOpenRouterProvider()
              : createAnthropicProvider({ id, baseURL: p.baseURL, compat: p.compat }),
    ]),
  );
}
