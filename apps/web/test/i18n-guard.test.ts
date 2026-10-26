import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { en, ptBR } from "@agenteschat/i18n";
import { legalDocuments } from "@agenteschat/i18n/legal";
import { leaves } from "../../../packages/i18n/test/leaves";

const REPO = join(import.meta.dir, "..", "..", "..");
const ROOTS = [join(import.meta.dir, "..", "src"), join(REPO, "packages", "ui", "src")];
const files = (dir: string, ext = /\.tsx$/): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "locales" ? [] : files(path, ext);
    return ext.test(path) ? [path] : [];
  });
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
/** The dev-only component gallery shows sample content on purpose. */
const SKIP_FILES = ["GalleryPage.tsx"];
/** Brand names, keys, symbols and code that stay as they are. */
const ALLOWED = [
  /^(agentes|chat|agentes\.chat|GitHub|MCP|Drive|Sentry|Linear|Slack|Claude Code|Codex|US\$|UTC)$/,
  /^[A-Z]$/,
  /^@\w+$/,
  /^https?:/,
  /^[a-z]+[-_]…$/,
];
const allowed = (s: string) => ALLOWED.some((re) => re.test(s));

describe("no hardcoded UI text", () => {
  test("JSX text and aria-label / title / placeholder / alt literals go through t()", () => {
    const offenders: string[] = [];
    for (const root of ROOTS)
      for (const f of files(root)) {
        if (SKIP_FILES.some((s) => f.endsWith(s))) continue;
        const source = withoutComments(readFileSync(f, "utf8"));
        const where = (i: number) => `${relative(root, f)}:${source.slice(0, i).split("\n").length}`;
        for (const m of source.matchAll(/>([^<>{}]*[A-Za-zÀ-ÿ][^<>{}]*)</g)) {
          const text = (m[1] ?? "").trim();
          // `=> Promise<…>`, `->`: types and arrows, not markup; a prop list after `<b />,`; one generic type joined
          // to the next (`Pick<…> & Partial<…>`, `Map<…> | Set<…>`).
          const prev = source[(m.index ?? 0) - 1];
          if (prev === "=" || prev === "-" || /^[,;]/.test(text) || /^[&|] *[\w.]+$/.test(text)) continue;
          // Code between generics/operators, not JSX text.
          if (!text || /=>|;|\(|\)|&&|\|\||=|\bconst\b|\breturn\b|\bnew\b|\*/.test(text) || allowed(text)) continue;
          offenders.push(`${where(m.index ?? 0)} text "${text}"`);
        }
        for (const m of source.matchAll(/\b(aria-label|title|placeholder|alt)="([^"]*[A-Za-zÀ-ÿ][^"]*)"/g)) {
          if (allowed(m[2] ?? "")) continue;
          offenders.push(`${where(m.index ?? 0)} ${m[1]}="${m[2]}"`);
        }
      }
    expect(offenders).toEqual([]);
  });
});

describe("Claude, never Anthropic, in what a person reads", () => {
  /** A legal text names the company, once, beside the product people know. */
  const MAKER = { en: "Anthropic, which makes Claude", "pt-BR": "a Anthropic, que faz o Claude" } as const;

  test("the copy, the terms and the apps' own words", () => {
    const copy = [
      ...leaves(en).map(([k, v]) => [`en ${k}`, v] as const),
      ...leaves(ptBR).map(([k, v]) => [`pt-BR ${k}`, v] as const),
    ]
      .filter(([, v]) => /anthropic/i.test(String(v)))
      .map(([k]) => k);
    const legal = Object.entries(legalDocuments).flatMap(([kind, byLocale]) =>
      Object.entries(byLocale)
        .filter(([lng, doc]) => /anthropic/i.test(JSON.stringify(doc).replaceAll(MAKER[lng as keyof typeof MAKER], "")))
        .map(([lng]) => `${kind} ${lng}`),
    );
    // Code keeps the provider's id, `anthropic`; a capitalized "Anthropic" outside comments is words.
    const words = ["apps/web/src", "packages/ui/src", "packages/client/src", "apps/mobile/src", "apps/desktop/src"]
      .flatMap((dir) => files(join(REPO, dir), /\.tsx?$/))
      .filter((f) => withoutComments(readFileSync(f, "utf8")).includes("Anthropic"))
      .map((f) => relative(REPO, f));
    expect([...copy, ...legal, ...words]).toEqual([]);
  });
});
