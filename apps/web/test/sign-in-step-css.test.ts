import { expect, test } from "bun:test";
import { join } from "node:path";
import { builtCss, declarations, topLevel } from "./built-css";

const LAYOUT = join(import.meta.dir, "../src/layout.css");

/** What places a step's button, and a failed sign-in's: under its words, on their column, at every width. */
const PLACEMENT = [
  ".agp-addacct__step",
  ".agp-addacct__step.ac-iconline > .agp-addacct__text",
  ".agp-addacct__step.ac-iconline > :not(i, .agp-addacct__text)",
  ".agp-addacct__step:not(.ac-iconline) > .agp-addacct__text",
  ".ai-panel--plan .agp-addacct__step.ac-iconline > .agp-addacct__text",
  ".ai-panel--plan .agp-addacct__step.ac-iconline > :not(i, .agp-addacct__text)",
  ".ai-panel--plan .agp-addacct > .agp-addacct__step:not(.ac-iconline)",
  ".ai-panel--plan .ai-panel__row > .ac-setnote",
  ".ai-panel--plan .ai-panel__row > :not(.ac-setnote)",
];

test("the built stylesheet keeps a step's button under its words at every width, as the source writes it", async () => {
  const source = topLevel(await Bun.file(LAYOUT).text());
  const css = await builtCss();
  const shipped = topLevel(css);
  for (const selector of PLACEMENT) {
    const written = squeeze(declarations(source, selector));
    expect({ selector, written: written.length > 0 }).toEqual({ selector, written: true });
    expect({ selector, shipped: squeeze(declarations(shipped, selector)) }).toEqual({
      selector,
      shipped: expect.arrayContaining(written),
    });
  }
  // The words take the row, so whatever follows them wraps under: in the build too, outside any media query.
  expect(declarations(shipped, ".agp-addacct__step")).toContainEqual(["flex-wrap", "wrap"]);
  // Nothing in what ships pulls a step's words down to a button beside them, at any width.
  expect(css).not.toMatch(/agp-addacct__step:has\(/);
});

/** Declarations as `property:value`, spaces out: the minifier drops the ones it may. */
const squeeze = (list: (readonly [string, string])[]) => list.map(([p, v]) => `${p}:${v.replace(/\s+/g, "")}`);
