import type { TFunction } from "i18next";
import { capitalize } from "./format";
import { providerOf } from "./providers";

/**
 * An agent's grammatical gender, for its articles in Portuguese ("a Ada", "o Theo") and its pronouns in both
 * languages (she/ela, he/ele): one agent is never "it" in one line and "her" in the next. Agents don't store one,
 * so we infer it from the name: names ending in "a" are feminine. English ignores the articles.
 */
export function isFeminineName(name: string) {
  return /a$/i.test(name.trim().normalize("NFD").replace(/[̀-ͯ]/g, ""));
}

export function agentGrammar(t: TFunction, name: string) {
  const f = isFeminineName(name);
  const she = t(f ? "grammar.sheF" : "grammar.sheM");
  return {
    name,
    article: t(f ? "grammar.articleF" : "grammar.articleM"),
    The: t(f ? "grammar.theF" : "grammar.theM"),
    of: t(f ? "grammar.ofF" : "grammar.ofM"),
    to: t(f ? "grammar.toF" : "grammar.toM"),
    /** The agent as a subject: "she", "ela". */
    she,
    She: capitalize(she),
    /** As an object: "her", "ela" ("com ela"). */
    pronoun: t(f ? "grammar.pronounF" : "grammar.pronounM"),
    /** Its possessive: "her", "dela". */
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
