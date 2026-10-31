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

export interface ProviderInfo {
  label: string;
  /** The API it speaks, which picks its adapter (`createModelProviders`). */
  protocol: "anthropic" | "openai" | "gemini" | "openrouter";
  /** Replaces the SDK's default host. */
  baseURL?: string;
  /**
   * Another company's Anthropic-compatible endpoint, sent only what it takes
   * (`createAnthropicProvider`). `toolChoiceAny`: it honors `tool_choice: any`,
   * so structured output can force its tool.
   */
  compat?: { toolChoiceAny: boolean };
}

/**
 * Model providers agentes.chat can talk to. Adding one is an entry here,
 * catalog rows with its prices, and an adapter for its protocol; the database
 * stores the provider id as text, so no migration is needed.
 */
export const PROVIDERS = {
  anthropic: { label: "Claude", protocol: "anthropic" },
  openai: { label: "OpenAI", protocol: "openai" },
  gemini: { label: "Gemini", protocol: "gemini" },
  deepseek: {
    label: "DeepSeek",
    protocol: "anthropic",
    baseURL: "https://api.deepseek.com/anthropic",
    compat: { toolChoiceAny: true },
  },
  moonshot: {
    label: "Kimi",
    protocol: "anthropic",
    baseURL: "https://api.moonshot.ai/anthropic",
    compat: { toolChoiceAny: true },
  },
  // Z.ai documents only `tool_choice: auto`. MiniMax documents `any` too, untried here, so its tool isn't forced yet.
  zai: {
    label: "Z.ai",
    protocol: "anthropic",
    baseURL: "https://api.z.ai/api/anthropic",
    compat: { toolChoiceAny: false },
  },
  minimax: {
    label: "MiniMax",
    protocol: "anthropic",
    baseURL: "https://api.minimax.io/anthropic",
    compat: { toolChoiceAny: false },
  },
  // Its models come from its public list at run time (`openrouter.ts`), never from this catalog.
  openrouter: { label: "OpenRouter", protocol: "openrouter" },
} as const satisfies Record<string, ProviderInfo>;

export type ProviderId = keyof typeof PROVIDERS;
export const PROVIDER_IDS = Object.keys(PROVIDERS) as [ProviderId, ...ProviderId[]];

export const isKnownProvider = (id: string): id is ProviderId => Object.hasOwn(PROVIDERS, id);

export interface ModelInfo {
  provider: ProviderId;
  label: string;
  prices: TokenPrices;
  /** Lower prices the provider charges until a day (UTC, exclusive): `prices` apply from then on. */
  intro?: { until: string; prices: TokenPrices };
  /** Prices for the whole request when its prompt exceeds `aboveInputTokens`. */
  longContext?: { aboveInputTokens: number; prices: TokenPrices };
  /** Ask the API to retry a refused request on a fallback model (Anthropic `fallbacks: "default"`). */
  serverSideFallback: boolean;
  /** Takes a reasoning `effort` (OpenAI reasoning models). */
  reasoning?: boolean;
  /** The provider's small, cheap model (summaries, reflection). */
  cheap?: boolean;
  /**
   * The provider's pick for routing and the judge (`routerModelOf`): its fastest model with the least thinking,
   * at about US$ 0.0006 a call or less. Not always its `cheap` one: one that always thinks is slower for the same cost.
   */
  router?: boolean;
  /**
   * The least thinking the model allows, which `effort: "none"` asks for: `off` turns it off, `minimal` keeps
   * a little (it can't be turned off). Absent: `none` goes as `low`.
   */
  leastThinking?: "off" | "minimal";
  /** Suggested for new agents of that provider. */
  recommended?: boolean;
  /** Its size in the provider's line, for "Automático": each run picks a tier, mapped back to a model. */
  tier?: ModelTier;
  /** Context window in tokens (prompt + output); absent = `DEFAULT_CONTEXT_WINDOW`. */
  contextWindow?: number;
  /** The most output tokens one call may ask for; the gateway caps each call at it. */
  maxOutputTokens?: number;
  /** The reasoning efforts it takes, highest first: a request's effort goes as the nearest. Absent: any. */
  efforts?: readonly string[];
  /** It can't follow an `outputSchema`: never a pick for routing, the judge or summaries. */
  structuredOutput?: false;
  /** In a long list (OpenRouter's): `true` is a good pick, shown first. Absent: a catalog model. */
  pick?: boolean;
}

/** The sizes "Automático" chooses between: a fast cheap model, the everyday one, the strongest. */
export type ModelTier = "small" | "medium" | "large";
export const MODEL_TIERS: readonly ModelTier[] = ["small", "medium", "large"];

/**
 * An agent's model setting that is no model: each run picks the tier and the
 * effort (`packages/engine/src/auto-model.ts`). Never sent to a provider.
 */
export const AUTO_MODEL = "auto";
export const isAutoModel = (model: string | null | undefined) => model === AUTO_MODEL;

/** Context window assumed for a model without one in the catalog: the smallest current one, so runs stay inside it. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

export const MODEL_CATALOG: Record<string, ModelInfo> = {
  "claude-opus-5-5": {
    provider: "anthropic",
    label: "Claude Opus 5.5",
    prices: { input: 4000, output: 20000, cacheRead: 200, cacheWrite: 5000 },
    contextWindow: 1_000_000,
    serverSideFallback: true,
    tier: "large",
  },
  "claude-sonnet-5-5": {
    provider: "anthropic",
    label: "Claude Sonnet 5.5",
    prices: { input: 2000, output: 10000, cacheRead: 100, cacheWrite: 2500 },
    contextWindow: 1_000_000,
    serverSideFallback: true,
    recommended: true,
    tier: "medium",
  },
  "claude-haiku-5-5": {
    provider: "anthropic",
    label: "Claude Haiku 5.5",
    prices: { input: 100, output: 500, cacheRead: 10, cacheWrite: 125 },
    longContext: { aboveInputTokens: 100_000, prices: { input: 500, output: 2500, cacheRead: 50, cacheWrite: 625 } },
    contextWindow: 1_000_000,
    serverSideFallback: false,
    cheap: true,
    router: true,
    leastThinking: "off",
    tier: "small",
  },
  // OpenAI, Standard tier, checked on developers.openai.com/api/docs/pricing (2026-10-20); cache writes
  // at the 30-minute rate. Above 272K prompt tokens, input, cached input and cache writes cost 2×, output 1.5×.
  // Context windows from each model's page (2026-10-26).
  "gpt-6.1-sol": {
    provider: "openai",
    label: "GPT-6.1 Sol",
    prices: { input: 2000, output: 10000, cacheRead: 100, cacheWrite: 2500 },
    longContext: {
      aboveInputTokens: 272_000,
      prices: { input: 4000, output: 15000, cacheRead: 200, cacheWrite: 5000 },
    },
    contextWindow: 1_050_000,
    serverSideFallback: false,
    reasoning: true,
    recommended: true,
    tier: "medium",
  },
  "gpt-6-sol": {
    provider: "openai",
    label: "GPT-6 Sol",
    prices: { input: 2000, output: 10000, cacheRead: 200, cacheWrite: 2500 },
    longContext: {
      aboveInputTokens: 272_000,
      prices: { input: 4000, output: 15000, cacheRead: 400, cacheWrite: 5000 },
    },
    contextWindow: 1_050_000,
    serverSideFallback: false,
    reasoning: true,
  },
  "gpt-6-luna": {
    provider: "openai",
    label: "GPT-6 Luna",
    prices: { input: 100, output: 500, cacheRead: 10, cacheWrite: 125 },
    longContext: { aboveInputTokens: 272_000, prices: { input: 200, output: 750, cacheRead: 20, cacheWrite: 250 } },
    contextWindow: 1_050_000,
    serverSideFallback: false,
    reasoning: true,
    cheap: true,
    router: true,
    leastThinking: "off",
    tier: "small",
  },
  // Gemini (Interactions API), Standard tier, from ai.google.dev/gemini-api/docs/pricing (2026-10-27). Thinking is
  // billed as output. Caching is implicit, with no write charge, so a cache write costs the input rate (none is ever
  // reported). Argon and 3.8 Flash cost half until the day in `intro`.
  "gemini-4-argon": {
    provider: "gemini",
    label: "Gemini 4 Argon",
    prices: { input: 4000, output: 20000, cacheRead: 200, cacheWrite: 4000 },
    intro: { until: "2026-12-01", prices: { input: 2000, output: 10000, cacheRead: 100, cacheWrite: 2000 } },
    contextWindow: 1_048_576,
    serverSideFallback: false,
    tier: "large",
  },
  "gemini-3.8-flash": {
    provider: "gemini",
    label: "Gemini 3.8 Flash",
    prices: { input: 1500, output: 7500, cacheRead: 150, cacheWrite: 1500 },
    intro: { until: "2027-01-01", prices: { input: 750, output: 3750, cacheRead: 75, cacheWrite: 750 } },
    contextWindow: 1_048_576,
    serverSideFallback: false,
    recommended: true,
    tier: "medium",
  },
  // It can't stop thinking: `minimal` is the least.
  "gemini-3.5-flash-lite": {
    provider: "gemini",
    label: "Gemini 3.5 Flash-Lite",
    prices: { input: 300, output: 2500, cacheRead: 30, cacheWrite: 300 },
    contextWindow: 1_048_576,
    serverSideFallback: false,
    cheap: true,
    router: true,
    leastThinking: "minimal",
    tier: "small",
  },
  // Anthropic-compatible providers, from each one's pricing page (2026-10-24). A cache write costs the
  // input rate. DeepSeek stores its peak rates (off-peak is half), so budgets err high. `deepseek-flash` is
  // served by DeepSeek-V4.1-Flash-1017.
  "deepseek-flash": {
    provider: "deepseek",
    label: "DeepSeek Flash",
    prices: { input: 300, output: 1200, cacheRead: 6, cacheWrite: 300 },
    contextWindow: 1_000_000,
    serverSideFallback: false,
    cheap: true,
    router: true,
    leastThinking: "off",
    recommended: true,
    tier: "small",
  },
  "deepseek-v4-pro": {
    provider: "deepseek",
    label: "DeepSeek V4 Pro",
    prices: { input: 1320, output: 3960, cacheRead: 44, cacheWrite: 1320 },
    contextWindow: 1_000_000,
    serverSideFallback: false,
    tier: "large",
  },
  // K3.1 Pro is Kimi's strongest and cheapest; K3 (previous flagship) stays choosable, never picked by "Automático".
  "kimi-k3.1-pro": {
    provider: "moonshot",
    label: "Kimi K3.1 Pro",
    prices: { input: 2000, output: 10000, cacheRead: 200, cacheWrite: 2000 },
    contextWindow: 1_048_576,
    serverSideFallback: false,
    recommended: true,
    tier: "medium",
  },
  "kimi-k3": {
    provider: "moonshot",
    label: "Kimi K3",
    prices: { input: 3000, output: 15000, cacheRead: 300, cacheWrite: 3000 },
    contextWindow: 1_048_576,
    serverSideFallback: false,
  },
  "glm-5.3": {
    provider: "zai",
    label: "GLM-5.3",
    prices: { input: 1400, output: 4400, cacheRead: 260, cacheWrite: 1400 },
    contextWindow: 1_000_000,
    serverSideFallback: false,
    recommended: true,
    tier: "medium",
  },
  // Always thinks (Z.ai: it "cannot be disabled"), still the line's fastest for routing.
  "glm-5.3-flash": {
    provider: "zai",
    label: "GLM-5.3 Flash",
    prices: { input: 150, output: 500, cacheRead: 30, cacheWrite: 150 },
    contextWindow: 1_000_000,
    serverSideFallback: false,
    cheap: true,
    router: true,
    tier: "small",
  },
  // Routes for MiniMax: thinking off by default, while M3.1 Flash always thinks (at `max` unless told) for the
  // same cost a call.
  "MiniMax-M3": {
    provider: "minimax",
    label: "MiniMax M3",
    prices: { input: 300, output: 1200, cacheRead: 60, cacheWrite: 300 },
    longContext: { aboveInputTokens: 512_000, prices: { input: 600, output: 2400, cacheRead: 120, cacheWrite: 600 } },
    contextWindow: 1_000_000,
    serverSideFallback: false,
    router: true,
    leastThinking: "off",
    recommended: true,
    tier: "medium",
  },
  "MiniMax-M3.1-Flash": {
    provider: "minimax",
    label: "MiniMax M3.1 Flash",
    prices: { input: 150, output: 600, cacheRead: 15, cacheWrite: 150 },
    contextWindow: 1_000_000,
    serverSideFallback: false,
    cheap: true,
    tier: "small",
  },
};

/** Models a provider lists at run time (OpenRouter's, `openrouter.ts`), beside the fixed catalog. */
let listed = new Map<string, ModelInfo>();

/** Replaces the models listed at run time. A catalog id is never shadowed. */
export function setListedModels(models: Record<string, ModelInfo>) {
  listed = new Map(Object.entries(models).filter(([id]) => !Object.hasOwn(MODEL_CATALOG, id)));
}

/** A model of the catalog or of a list read at run time; undefined for any other id. */
export const modelInfo = (model: string): ModelInfo | undefined =>
  Object.hasOwn(MODEL_CATALOG, model) ? MODEL_CATALOG[model] : listed.get(model);

/** Every model: the catalog's, then the listed ones in their list's order. */
export const listedModels = (): [string, ModelInfo][] => [...Object.entries(MODEL_CATALOG), ...listed];

/**
 * The model a provider's system tasks use (summaries, reflection): its cheap
 * one, else its recommended one (a line with no small model, like Kimi's).
 */
export function cheapModelOf(provider: string): string | null {
  const own = listedModels().filter(([, m]) => m.provider === provider);
  return (own.find(([, m]) => m.cheap) ?? own.find(([, m]) => m.recommended))?.[0] ?? null;
}

/** The provider's model for routing and the judge, never a large one: null for a line with none (Kimi). */
export function routerModelOf(provider: string): string | null {
  return listedModels().find(([, m]) => m.provider === provider && m.router)?.[0] ?? null;
}

/**
 * A provider's model for a tier: that tier, else the nearest smaller one (a
 * line without a large model answers with its medium one), else the nearest
 * larger. Null when the provider has no tiered model.
 */
export function modelForTier(provider: string, tier: ModelTier): string | null {
  const own = listedModels().filter(([, m]) => m.provider === provider && m.tier);
  const at = MODEL_TIERS.indexOf(tier);
  const order = [...MODEL_TIERS.slice(0, at + 1).reverse(), ...MODEL_TIERS.slice(at + 1)];
  for (const t of order) {
    const hit = own.find(([, m]) => m.tier === t);
    if (hit) return hit[0];
  }
  return null;
}

/** The model's context window in tokens (`DEFAULT_CONTEXT_WINDOW` when the catalog doesn't say). */
export const contextWindowOf = (model: string) => modelInfo(model)?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;

export const isKnownModel = (model: string) => modelInfo(model) !== undefined;

/** The catalog id of a model a CLI named (`claude-opus-5-5[1m]`, a dated `…-20261001`); null when it has no price. */
export function catalogModelOf(model: string | null | undefined): string | null {
  const base = model?.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
  return base && isKnownModel(base) ? base : null;
}

/** A model's prices, or a throw: we never make a call we can't price. */
function infoOf(model: string): ModelInfo {
  const info = modelInfo(model);
  if (!info) throw new Error(`unknown model ${model}`);
  return info;
}

const tokensCost = (p: TokenPrices, u: ModelUsage) =>
  u.inputTokens * p.input +
  u.outputTokens * p.output +
  u.cacheReadTokens * p.cacheRead +
  u.cacheWriteTokens * p.cacheWrite;

/**
 * What a call made at `at` pays per token: the introductory prices before their day. Budget reservations
 * (`maxCostNanoUsd`, `outputTokensWithin`) keep the list prices on purpose, so they err high while a lower price
 * lasts; give them `at` too if that ever stops agents early.
 */
export const pricesAt = (info: ModelInfo, at = new Date()) =>
  info.intro && at.getTime() < Date.parse(info.intro.until) ? info.intro.prices : info.prices;

/**
 * Cost in nano-USD of one call made at `at`. Throws for models outside the catalog (we never make a call we
 * can't price).
 */
export function costNanoUsd(model: string, usage: ModelUsage, at = new Date()): number {
  const info = infoOf(model);
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return tokensCost(
    info.longContext && prompt > info.longContext.aboveInputTokens ? info.longContext.prices : pricesAt(info, at),
    usage,
  );
}

/**
 * Many calls' tokens added up, at the base prices: a sum's prompt says nothing about any one call's, so it
 * never crosses a long-context threshold. Throws for models outside the catalog.
 */
export function summedCostNanoUsd(model: string, usage: ModelUsage): number {
  return tokensCost(infoOf(model).prices, usage);
}

/**
 * Upper bound of a call's cost, for budget reservations: every prompt token at
 * the most expensive input rate (a cache write), every allowed output token
 * at the output rate, long-context prices when the prompt may cross the threshold.
 */
export function maxCostNanoUsd(model: string, promptTokens: number, maxOutputTokens: number): number {
  const info = infoOf(model);
  const p =
    info.longContext && promptTokens > info.longContext.aboveInputTokens ? info.longContext.prices : info.prices;
  return promptTokens * Math.max(p.input, p.cacheWrite) + maxOutputTokens * p.output;
}

/** Output tokens that fit in `nanoUsd` after paying for the prompt (worst case), or 0. */
export function outputTokensWithin(model: string, promptTokens: number, nanoUsd: number): number {
  const info = infoOf(model);
  const p =
    info.longContext && promptTokens > info.longContext.aboveInputTokens ? info.longContext.prices : info.prices;
  const left = nanoUsd - promptTokens * Math.max(p.input, p.cacheWrite);
  return left <= 0 ? 0 : Math.floor(left / p.output);
}

export const nanoUsdToUsd = (nano: number) => nano / 1e9;
export const usdToNanoUsd = (usd: number) => Math.round(usd * 1e9);
