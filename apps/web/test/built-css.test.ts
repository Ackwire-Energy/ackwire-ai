import { expect, test } from "bun:test";
import { join } from "node:path";
import { Glob } from "bun";
import { build } from "vite";

const WEB = join(import.meta.dir, "..");
const ROOT = join(WEB, "../..");

/** The app's stylesheet as the production build writes it: Vite's own CSS pipeline (its minifier and targets). */
async function builtCss() {
  const out = await build({
    configFile: false,
    logLevel: "silent",
    root: WEB,
    build: { write: false, rollupOptions: { input: join(WEB, "src/styles.css") } },
  });
  return (Array.isArray(out) ? out : [out])
    .flatMap((o) => ("output" in o ? o.output : []))
    .flatMap((o) => (o.type === "asset" && o.fileName.endsWith(".css") ? [String(o.source)] : []))
    .join("\n");
}

const normal = (selector: string) =>
  selector
    .replace(/\s*([>+~,])\s*/g, "$1")
    .replace(/="([^"]*)"/g, "=$1")
    .replace(/\s+/g, " ")
    .trim();

/** The declarations of every rule whose selector list holds `selector`, in order, as [property, value]. */
function declarations(css: string, selector: string) {
  const wanted = normal(selector);
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) =>
      normal(m[1] ?? "")
        .split(",")
        .includes(wanted),
    )
    .flatMap((m) =>
      (m[2] ?? "")
        .split(";")
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()] as const),
    );
}

/** A `translateY()`'s offset as its px and % parts ("calc(4px - 50%)" → 4px and -50%). */
function offsetY(transform: string | undefined) {
  const inner = transform?.match(/^translateY\((.*)\)$/)?.[1] ?? "";
  const terms = inner
    .replace(/^calc\((.*)\)$/, "$1")
    .replace(/\s+-\s+/g, " +-")
    .split(/\s+\+/);
  const sum = (unit: string) =>
    terms.filter((t) => t.trim().endsWith(unit)).reduce((n, t) => n + Number.parseFloat(t.replace(/\s/g, "")), 0);
  return { px: sum("px"), pct: sum("%") };
}

test("the built stylesheet keeps the hover bar placed by its middle, 4px lower at rest, and the hint line's flow", async () => {
  const css = await builtCss();
  // At rest and shown, as the kit declares them (components.test.tsx): a translate beside the transform would be
  // dropped by the minifier, and the bar would hang half its height lower.
  const transform = (selector: string) =>
    declarations(css, selector)
      .filter(([p]) => p === "transform")
      .at(-1)?.[1];
  expect(offsetY(transform(".ac-msg__actions"))).toEqual({ px: 4, pct: -50 });
  for (const shown of [
    ".ac-msg:hover .ac-msg__actions",
    ".ac-msg:focus-within .ac-msg__actions",
    '.ac-msg__actions[data-open="true"]',
    '.ac-msg__actions:has([aria-expanded="true"])',
  ])
    expect(offsetY(transform(shown))).toEqual({ px: 0, pct: -50 });
  expect(declarations(css, ".ac-msg__actions").filter(([p]) => p === "translate")).toEqual([]);
  // Every declaration of the hint line's rules is in the build as the kit wrote it.
  const kit = await Bun.file(join(ROOT, "packages/ui/src/styles/components.css")).text();
  for (const selector of [
    ".ac-hintline",
    ".ac-hintline:not(:has(> .ac-hint))",
    ".ac-hintline > :first-child:not(.ac-hint)",
    ".ac-hintline > .ac-hint",
  ]) {
    const source = declarations(kit, selector);
    expect(source.length).toBeGreaterThan(0);
    expect(declarations(css, selector)).toEqual(expect.arrayContaining(source));
  }
});

test("no rule sets translate, rotate or scale beside transform: the build's minifier drops or merges them", async () => {
  const pairs: string[] = [];
  for (const dir of ["apps/web/src", "packages/ui/src", "apps/desktop/src"])
    for await (const file of new Glob("**/*.css").scan(join(ROOT, dir))) {
      const css = await Bun.file(join(ROOT, dir, file)).text();
      for (const m of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const props = [...(m[2] ?? "").matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)].map((p) => p[1]);
        if (props.includes("transform") && props.some((p) => p === "translate" || p === "rotate" || p === "scale"))
          pairs.push(`${dir}/${file}: ${(m[1] ?? "").trim()}`);
      }
    }
  expect(pairs).toEqual([]);
});
