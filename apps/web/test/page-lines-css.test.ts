import { expect, test } from "bun:test";
import { join } from "node:path";
import { builtCss, declarations, topLevel } from "./built-css";

const ROOT = join(import.meta.dir, "../../..");
const LAYOUT = join(ROOT, "apps/web/src/layout.css");
const KIT = join(ROOT, "packages/ui/src/styles/components.css");

/** The rules of every `@media` block for the phone layout (760px and under), in order, as one sheet. */
const phoneRules = (css: string) =>
  [
    ...css
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/@media\s*\((?:max-width:\s*760px|width\s*<=\s*760px)\)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g),
  ]
    .map((m) => m[1] ?? "")
    .join("\n");

/** Declarations as `property:value`, spaces out: the minifier drops the ones it may. */
const squeeze = (list: (readonly [string, string])[]) => list.map(([p, v]) => `${p}:${v.replace(/\s+/g, "")}`);

test("the built stylesheet keeps what places the Settings header, the bucket's hints and the card heads' keys", async () => {
  const css = await builtCss();
  const shipped = topLevel(css);
  // Over the phone's strip the header leaves the desktop nav's inset: it starts on the gutter, as the page's title does.
  expect(declarations(phoneRules(css), ".settings__head")).toContainEqual(["padding", "0"]);
  expect(declarations(phoneRules(await Bun.file(LAYOUT).text()), ".settings__head")).toContainEqual(["padding", "0"]);
  // Every declaration the source writes for these ships as written.
  const sources: [string, string[]][] = [
    [LAYOUT, [".grid-fields--wide", ".page__header > p"]],
    [
      KIT,
      [
        ".ac-card__lead",
        ".ac-card__key",
        ".ac-card__head:not(:has(.ac-card__sub)) .ac-card__key",
        ".ac-card__head:not(:has(.ac-card__sub)) .ac-card__key + .ac-card__heading",
        ".ac-optrow__desc",
        ".ac-card__sub",
      ],
    ],
  ];
  for (const [file, selectors] of sources) {
    const source = topLevel(await Bun.file(file).text());
    for (const selector of selectors) {
      const written = squeeze(declarations(source, selector));
      expect({ selector, written: written.length > 0 }).toEqual({ selector, written: true });
      expect({ selector, shipped: squeeze(declarations(shipped, selector)) }).toEqual({
        selector,
        shipped: expect.arrayContaining(written),
      });
    }
  }
  // A key keeps its title's first line, however the title wraps: lifted by the capitals' middle from a 22px box.
  expect(declarations(shipped, ".ac-card__head:not(:has(.ac-card__sub)) .ac-card__key")).toContainEqual([
    "translate",
    "0 calc(-1 * var(--cap-mid))",
  ]);
  // Two columns of at least 280px: the endpoint's hint keeps two even lines beside the region.
  expect(declarations(shipped, ".grid-fields--wide")).toContainEqual([
    "grid-template-columns",
    "repeat(auto-fit,minmax(min(100%,280px),1fr))",
  ]);
  // A tile beside a name leads it as a face does, from the name's capitals, however the line under it wraps.
  expect(declarations(shipped, ".newag__role--blank")).toContainEqual(["align-items", "flex-start"]);
  // No word alone on a description's last line.
  for (const selector of [
    ".ac-optrow__desc",
    ".ac-card__sub",
    ".catalog-feat__desc",
    ".catalog-tile__desc",
    ".newag__role-desc",
    ".newag__role--blank .newag__role-name span",
    ".page-sub",
    ".page__header > p",
  ])
    expect({ selector, wrap: declarations(shipped, selector).find(([p]) => p === "text-wrap")?.[1] }).toEqual({
      selector,
      wrap: "pretty",
    });
});
