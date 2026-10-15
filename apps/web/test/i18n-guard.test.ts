import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { en } from "@/i18n/locales/en";
import { ptBR } from "@/i18n/locales/pt-BR";

/** Every leaf key ("chat.work.steps_one") and its value. */
function leaves(obj: unknown, prefix = ""): [string, unknown][] {
  if (obj === null || typeof obj !== "object") return [[prefix, obj]];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}
/** Plural forms differ by language ("_one"/"_other" vs others): compare the base key. */
const base = (k: string) => k.replace(/_(zero|one|two|few|many|other)$/, "");

describe("locales", () => {
  test("pt-BR and en have the same keys, and no empty values", () => {
    const pt = leaves(ptBR);
    const enLeaves = leaves(en);
    const ptKeys = new Set(pt.map(([k]) => base(k)));
    const enKeys = new Set(enLeaves.map(([k]) => base(k)));
    expect([...ptKeys].filter((k) => !enKeys.has(k))).toEqual([]);
    expect([...enKeys].filter((k) => !ptKeys.has(k))).toEqual([]);
    const empty = [...pt, ...enLeaves].filter(([, v]) => typeof v !== "string" || v.trim() === "").map(([k]) => k);
    expect(empty).toEqual([]);
  });
});

const ROOTS = [join(import.meta.dir, "..", "src"), join(import.meta.dir, "..", "..", "..", "packages", "ui", "src")];
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "locales" ? [] : files(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
/** The dev-only component gallery shows sample content on purpose. */
const SKIP_FILES = ["GalleryPage.tsx"];
/** Brand names, keys, symbols and code that stay as they are. */
const ALLOWED = [
  /^(agentes|chat|agentes\.chat|GitHub|MCP|Drive|Sentry|Linear|Slack|US\$|UTC)$/,
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
        const source = readFileSync(f, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
        const where = (i: number) => `${relative(root, f)}:${source.slice(0, i).split("\n").length}`;
        for (const m of source.matchAll(/>([^<>{}]*[A-Za-zÀ-ÿ][^<>{}]*)</g)) {
          const text = (m[1] ?? "").trim();
          // `=> Promise<…>`, `->`: types and arrows, not markup; a prop list after `<b />,`.
          const prev = source[(m.index ?? 0) - 1];
          if (prev === "=" || prev === "-" || /^[,;]/.test(text)) continue;
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
