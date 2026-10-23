import type { Credential, Model } from "../api/types";

/**
 * Model providers the workspace can bring a key for. The backend catalog
 * starts with Anthropic and is adding OpenAI. Key formats are checked on the
 * client only to catch paste mistakes; the server validates for real.
 */
export const PROVIDERS = [
  { id: "anthropic", label: "Anthropic", placeholder: "sk-ant-…", pattern: /^sk-ant-[A-Za-z0-9_-]{16,}$/ },
  { id: "openai", label: "OpenAI", placeholder: "sk-…", pattern: /^sk-(?!ant-)[A-Za-z0-9_-]{16,}$/ },
] as const;

export type ProviderId = (typeof PROVIDERS)[number]["id"];

export const providerLabel = (id: string) => PROVIDERS.find((p) => p.id === id)?.label ?? id;
export const isProviderId = (id: string): id is ProviderId => PROVIDERS.some((p) => p.id === id);
export const keyLooksValid = (provider: ProviderId, key: string) =>
  (PROVIDERS.find((p) => p.id === provider)?.pattern ?? /.{8,}/).test(key.trim());

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
 * "Automático" (D83): the value an agent's model, a computer brain's model or
 * its effort holds when each run picks them (the server's `auto-model.ts`).
 */
export const AUTO = "auto";
export const isAuto = (value: string | null | undefined) => value === AUTO;
