import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

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
        const source = readFileSync(f, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
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
