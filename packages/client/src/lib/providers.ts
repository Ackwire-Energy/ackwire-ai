import type { Credential, Model } from "../api/types";

interface ProviderEntry {
  id: string;
  label: string;
  /** How its keys start, as the key field's example; none where the provider publishes no prefix. */
  placeholder?: string;
  /** What its keys look like: only to catch paste mistakes (loose where the provider publishes no format). */
  pattern: RegExp;
  /** Where the provider hands out keys. */
  site: string;
  /** It also sells coding plans, whose keys only work in coding tools. */
  plans?: boolean;
  /** Its name is masculine in Portuguese ("do Claude"); the others are feminine ("da OpenAI"). */
  masculine?: boolean;
}

/**
 * Model providers the workspace can bring a key for, the same ids as the backend catalog
 * (`packages/providers/src/catalog.ts`). The server validates keys for real.
 */
export const PROVIDERS = [
  {
    id: "anthropic",
    label: "Claude",
    placeholder: "sk-ant-…",
    pattern: /^sk-ant-[A-Za-z0-9_-]{16,}$/,
    site: "platform.claude.com/settings/keys",
    masculine: true,
  },
  {
    id: "openai",
    label: "OpenAI",
    placeholder: "sk-…",
    pattern: /^sk-(?!ant-)[A-Za-z0-9_-]{16,}$/,
    site: "platform.openai.com/api-keys",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    placeholder: "sk-…",
    pattern: /^sk-[A-Za-z0-9]{16,}$/,
    site: "platform.deepseek.com/api_keys",
  },
  {
    id: "moonshot",
    label: "Kimi",
    placeholder: "sk-…",
    pattern: /^sk-[A-Za-z0-9]{16,}$/,
    site: "platform.kimi.ai/console/api-keys",
    plans: true,
  },
  {
    id: "zai",
    label: "Z.ai",
    pattern: /^(?!sk-)[A-Za-z0-9._-]{16,}$/,
    site: "z.ai/manage-apikey/apikey-list",
    plans: true,
  },
  {
    id: "minimax",
    label: "MiniMax",
    // `sk-cp-` keys are its coding plan's.
    pattern: /^(?!sk-ant-|sk-cp-)[A-Za-z0-9._-]{16,}$/,
    site: "platform.minimax.io/user-center/basic-information/interface-key",
    plans: true,
  },
] as const satisfies readonly ProviderEntry[];

export type ProviderId = (typeof PROVIDERS)[number]["id"];

/**
 * A provider's entry by its id, or by its label (run errors name the provider by label); undefined for one
 * this client doesn't know (it then shows what it was given).
 */
export const providerOf = (id: string): ProviderEntry | undefined =>
  PROVIDERS.find((p) => p.id === id || p.label === id);
export const providerLabel = (id: string) => providerOf(id)?.label ?? id;
export const isProviderId = (id: string): id is ProviderId => PROVIDERS.some((p) => p.id === id);
export const keyLooksValid = (provider: ProviderId, key: string) =>
  (providerOf(provider)?.pattern ?? /.{8,}/).test(key.trim());

/**
 * The providers whose keys look like this one. Often several (any `sk-` key could be OpenAI's, DeepSeek's,
 * Kimi's or MiniMax's), so the person says which instead of the app guessing.
 */
export const providersForKey = (key: string) => PROVIDERS.filter((p) => p.pattern.test(key.trim()));

/** Whose a pasted key is: the one provider whose keys look like it, else the one asked for, else the first that fits. */
export function providerGuess(key: string | undefined, asked?: string): ProviderId {
  const fits = key ? providersForKey(key) : [];
  const guess = (fits.length === 1 ? fits[0]?.id : undefined) ?? asked ?? fits[0]?.id;
  return guess && isProviderId(guess) ? guess : "anthropic";
}

/** Live keys per provider. */
export function providersWithKeys(credentials: Credential[]) {
  return new Set(credentials.filter((c) => !c.revokedAt).map((c) => c.provider as string));
}

export interface ModelChoice {
  model: Model;
  available: boolean;
}

/**
 * Models grouped by provider, each marked usable or not. Uses `model.available`
 * when the server sends it (expected on `GET …/models`); until then a model is
 * usable when the workspace has a key for its provider, or the platform key is on.
 */
export function modelChoices(models: Model[], credentials: Credential[], platform: boolean) {
  const withKey = providersWithKeys(credentials);
  const groups = new Map<string, ModelChoice[]>();
  for (const model of models) {
    const available = model.available ?? (platform || withKey.has(model.provider));
    groups.set(model.provider, [...(groups.get(model.provider) ?? []), { model, available }]);
  }
  return [...groups.entries()];
}

/**
 * "Automático": the value an agent's model, a computer brain's model or
 * its effort holds when each run picks them (the server's `auto-model.ts`).
 */
export const AUTO = "auto";
export const isAuto = (value: string | null | undefined) => value === AUTO;
