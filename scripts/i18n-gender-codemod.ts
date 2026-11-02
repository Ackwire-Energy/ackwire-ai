/**
 * One-shot (ADR 0121): the agent's gender fragments ({{The}} {{article}} {{of}} {{to}} {{she}} {{She}} {{pronoun}}
 * {{hers}} {{for}}) become i18next context: each string is written out twice, `key` (masculine) and `key_female`.
 */
import { readFileSync, writeFileSync } from "node:fs";

const PT = {
  article: ["o", "a"],
  The: ["O", "A"],
  of: ["do", "da"],
  to: ["ao", "à"],
  she: ["ele", "ela"],
  She: ["Ele", "Ela"],
  pronoun: ["ele", "ela"],
  hers: ["dele", "dela"],
  for: ["para o", "para a"],
};
const EN = {
  article: ["", ""],
  The: ["", ""],
  of: ["their", "their"],
  to: ["", ""],
  she: ["he", "she"],
  She: ["He", "She"],
  pronoun: ["him", "her"],
  hers: ["his", "her"],
  for: ["for", "for"],
};

const FILES: [string, typeof PT][] = [
  ["packages/i18n/src/pt-BR.ts", PT],
  ["packages/i18n/src/en.ts", EN],
  ["apps/mobile/src/features/i18n/keys.pt-BR.ts", PT],
  ["apps/mobile/src/features/i18n/keys.en.ts", EN],
  ["apps/mobile/src/i18n/keys.pt-BR.ts", PT],
  ["apps/mobile/src/i18n/keys.en.ts", EN],
  ["apps/desktop/src/i18n/keys.pt-BR.ts", PT],
  ["apps/desktop/src/i18n/keys.en.ts", EN],
];

const FRAG =
  /\{\{(The|article|she|She|pronoun|hers|for)\}\}|\{\{of\}\}(?=(?: |\\u00a0)(?:<b>)?\{\{(?:name|executor|from)\}\})|\{\{to\}\}(?= (?:<b>)?\{\{name\}\})/g;
const EN_OF = /\{\{of\}\}/g;

function render(lit: string, words: typeof PT, female: number, en: boolean) {
  const re = en ? new RegExp(`${FRAG.source}|${EN_OF.source}`, "g") : new RegExp(FRAG.source, "g");
  return lit.replace(new RegExp(`(${re.source})( |\\\\u00a0)?`, "g"), (_m, frag: string, _a, space = "") => {
    const name = frag.slice(2, -2) as keyof typeof PT;
    const word = words[name][female] ?? "";
    return word ? word + space : "";
  });
}

let total = 0;
for (const [file, words] of FILES) {
  const en = words === EN;
  const src = readFileSync(file, "utf8");
  const out = src.replace(
    /(\b[\w$]+|"[^"\n]+"):(\s*)("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g,
    (all, key: string, ws: string, lit: string) => {
      const test = en ? new RegExp(`${FRAG.source}|${EN_OF.source}`) : new RegExp(FRAG.source);
      if (!test.test(lit)) return all;
      total++;
      const m = render(lit, words, 0, en);
      const f = render(lit, words, 1, en);
      if (m === f) return `${key}:${ws}${m}`;
      const plural = key.match(/_(zero|one|two|few|many|other)$/);
      const fKey = plural ? `${key.slice(0, -plural[0].length)}_female${plural[0]}` : `${key}_female`;
      return `${key}:${ws}${m}, ${fKey}: ${f}`;
    },
  );
  writeFileSync(file, out);
  const left = [
    ...out.matchAll(
      /\{\{(The|article|she|She|pronoun|hers|for|of|toArticle|theFrom|theTo|articleFrom|articleTo|the)\}\}/g,
    ),
  ].length;
  console.log(file, "left:", left);
}
console.log("strings split:", total);
