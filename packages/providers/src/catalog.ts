import type { ModelUsage } from "./types";

/**
 * Prices in nano-USD per token (1e-9 USD), i.e. USD per million tokens × 1000,
 * so every cost is an exact integer. First-party Anthropic API list prices,
 * checked on Anthropic's pricing page (2026-10-20); cache reads are listed per
 * model (Opus 5.5: $0.20/MTok, Sonnet 5.5: $0.10/MTok), cache writes use the
 * 5-minute rate (1.25 × input).
 * Update this table when prices change: usage records store the computed cost,
 * so history is never repriced.
 */
export interface TokenPrices {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Model providers agentes.chat can talk to. Adding one (e.g. `openai`) is an
 * entry here, catalog rows with its prices, and an adapter implementing
 * `ModelProvider`; the database stores the provider id as text, so no
 * migration is needed.
 */
export const PROVIDERS = {
  anthropic: { label: "Anthropic" },
  openai: { label: "OpenAI" },
} as const satisfies Record<string, { label: string }>;

export type ProviderId = keyof typeof PROVIDERS;

export const isKnownProvider = (id: string): id is ProviderId => Object.hasOwn(PROVIDERS, id);

export interface ModelInfo {
  provider: ProviderId;
  label: string;
  prices: TokenPrices;
  /** Prices for the whole request when its prompt exceeds `aboveInputTokens`. */
  longContext?: { aboveInputTokens: number; prices: TokenPrices };
  /** Ask the API to retry a refused request on a fallback model (Anthropic `fallbacks: "default"`). */
  serverSideFallback: boolean;
  /** Takes a reasoning `effort` (OpenAI reasoning models). */
  reasoning?: boolean;
  /** The provider's small, cheap model (router fallback, summaries, reflection). */
  cheap?: boolean;
  /** Suggested for new agents of that provider. */
  recommended?: boolean;
  /** Context window in tokens (prompt + output); absent = `DEFAULT_CONTEXT_WINDOW`. */
  contextWindow?: number;
}

/** Context window assumed for a model without one in the catalog: the smallest current one, so runs stay inside it. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export const MODEL_CATALOG: Record<string, ModelInfo> = {
  "claude-opus-5-5": {
    provider: "anthropic",
    label: "Claude Opus 5.5",
    prices: { input: 4000, output: 20000, cacheRead: 200, cacheWrite: 5000 },
    contextWindow: 1_000_000,
    serverSideFallback: true,
  },
  "claude-sonnet-5-5": {
    provider: "anthropic",
    label: "Claude Sonnet 5.5",
    prices: { input: 2000, output: 10000, cacheRead: 100, cacheWrite: 2500 },
    contextWindow: 1_000_000,
    serverSideFallback: true,
    recommended: true,
  },
  "claude-haiku-5-5": {
    provider: "anthropic",
    label: "Claude Haiku 5.5",
    prices: { input: 100, output: 500, cacheRead: 10, cacheWrite: 125 },
    longContext: { aboveInputTokens: 100_000, prices: { input: 500, output: 2500, cacheRead: 50, cacheWrite: 625 } },
    contextWindow: 1_000_000,
    serverSideFallback: false,
    cheap: true,
  },
  // OpenAI, Standard tier, checked on developers.openai.com/api/docs/pricing (2026-10-20); cache writes
  // at the 30-minute rate. Above 272K prompt tokens, input, cached input and cache writes cost 2×, output 1.5×.
  // TODO: `contextWindow` not checked yet; they use `DEFAULT_CONTEXT_WINDOW` until then.
  "gpt-6.1-sol": {
    provider: "openai",
    label: "GPT-6.1 Sol",
    prices: { input: 2000, output: 10000, cacheRead: 100, cacheWrite: 2500 },
    longContext: {
      aboveInputTokens: 272_000,
      prices: { input: 4000, output: 15000, cacheRead: 200, cacheWrite: 5000 },
    },
    serverSideFallback: false,
    reasoning: true,
    recommended: true,
  },
  "gpt-6-sol": {
    provider: "openai",
    label: "GPT-6 Sol",
    prices: { input: 2000, output: 10000, cacheRead: 200, cacheWrite: 2500 },
    longContext: {
      aboveInputTokens: 272_000,
      prices: { input: 4000, output: 15000, cacheRead: 400, cacheWrite: 5000 },
    },
    serverSideFallback: false,
    reasoning: true,
  },
  "gpt-6-luna": {
    provider: "openai",
    label: "GPT-6 Luna",
    prices: { input: 100, output: 500, cacheRead: 10, cacheWrite: 125 },
    longContext: { aboveInputTokens: 272_000, prices: { input: 200, output: 750, cacheRead: 20, cacheWrite: 250 } },
    serverSideFallback: false,
    reasoning: true,
    cheap: true,
  },
};

/** The cheap model of a provider (router fallback, summaries), from the catalog. */
export const cheapModelOf = (provider: string) =>
  Object.entries(MODEL_CATALOG).find(([, m]) => m.provider === provider && m.cheap)?.[0] ?? null;

/** The model's context window in tokens (`DEFAULT_CONTEXT_WINDOW` when the catalog doesn't say). */
export const contextWindowOf = (model: string) => MODEL_CATALOG[model]?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;

export const isKnownModel = (model: string) => Object.hasOwn(MODEL_CATALOG, model);

/** Cost of one call in nano-USD. Throws for models outside the catalog (we never make a call we can't price). */
export function costNanoUsd(model: string, usage: ModelUsage): number {
  const info = MODEL_CATALOG[model];
  if (!info) throw new Error(`unknown model ${model}`);
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const p = info.longContext && prompt > info.longContext.aboveInputTokens ? info.longContext.prices : info.prices;
  return (
    usage.inputTokens * p.input +
    usage.outputTokens * p.output +
    usage.cacheReadTokens * p.cacheRead +
    usage.cacheWriteTokens * p.cacheWrite
  );
}

/**
 * Upper bound of a call's cost, for budget reservations: every prompt token at
 * the most expensive input rate (a cache write), every allowed output token
 * at the output rate, long-context prices when the prompt may cross the threshold.
 */
export function maxCostNanoUsd(model: string, promptTokens: number, maxOutputTokens: number): number {
  const info = MODEL_CATALOG[model];
  if (!info) throw new Error(`unknown model ${model}`);
  const p =
    info.longContext && promptTokens > info.longContext.aboveInputTokens ? info.longContext.prices : info.prices;
  return promptTokens * Math.max(p.input, p.cacheWrite) + maxOutputTokens * p.output;
}

/** Output tokens that fit in `nanoUsd` after paying for the prompt (worst case), or 0. */
export function outputTokensWithin(model: string, promptTokens: number, nanoUsd: number): number {
  const info = MODEL_CATALOG[model];
  if (!info) throw new Error(`unknown model ${model}`);
  const p =
    info.longContext && promptTokens > info.longContext.aboveInputTokens ? info.longContext.prices : info.prices;
  const left = nanoUsd - promptTokens * Math.max(p.input, p.cacheWrite);
  return left <= 0 ? 0 : Math.floor(left / p.output);
}

export const nanoUsdToUsd = (nano: number) => nano / 1e9;
export const usdToNanoUsd = (usd: number) => Math.round(usd * 1e9);
