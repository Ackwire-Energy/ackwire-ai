import type { TFunction } from "i18next";
import { providerOf } from "./providers";

/**
 * Portuguese needs the grammatical gender of an agent's name ("a Ada", "o
 * Theo"). Agents don't store one, so we infer it from the name: names ending
 * in "a" are feminine. English strings ignore these values.
 */
export function isFeminineName(name: string) {
  return /a$/i.test(name.trim().normalize("NFD").replace(/[̀-ͯ]/g, ""));
}

export function agentGrammar(t: TFunction, name: string) {
  const f = isFeminineName(name);
  return {
    name,
    article: t(f ? "grammar.articleF" : "grammar.articleM"),
    The: t(f ? "grammar.theF" : "grammar.theM"),
    of: t(f ? "grammar.ofF" : "grammar.ofM"),
    to: t(f ? "grammar.toF" : "grammar.toM"),
    pronoun: t(f ? "grammar.pronounF" : "grammar.pronounM"),
    hers: t(f ? "grammar.hersF" : "grammar.hersM"),
    for: t(f ? "grammar.forF" : "grammar.forM"),
  };
}

/** A provider in Portuguese copy: its label and the "do"/"da" before it ("chave do Claude", "da OpenAI"). */
export function providerGrammar(t: TFunction, provider: string) {
  const entry = providerOf(provider);
  return { provider: entry?.label ?? provider, of: t(entry?.masculine ? "grammar.ofM" : "grammar.ofF") };
}

/** A run error's params plus "do"/"da" before each provider they name (`of`, `modelOf`, `keyOf`). */
export function runErrorGrammar(t: TFunction, params: Record<string, string> = {}) {
  const of = (provider?: string) => (provider ? providerGrammar(t, provider).of : undefined);
  return { ...params, of: of(params.provider), modelOf: of(params.modelProvider), keyOf: of(params.keyProvider) };
}
