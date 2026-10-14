import type { TFunction } from "i18next";

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
