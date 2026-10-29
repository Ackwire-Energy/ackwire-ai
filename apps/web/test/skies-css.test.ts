import { expect, test } from "bun:test";
import { join } from "node:path";
import { builtCss, declarations, topLevel } from "./built-css";

const SRC = join(import.meta.dir, "../src");

/** Declarations as `property:value`, spaces out: the minifier drops the ones it may. */
const squeeze = (list: (readonly [string, string])[]) => list.map(([p, v]) => `${p}:${v.replace(/\s+/g, "")}`);

const builds = new Map<string, Promise<string>>();
const built = (input: string) => {
  if (!builds.has(input)) builds.set(input, builtCss(input).then(topLevel));
  return builds.get(input) as Promise<string>;
};

/** What `file` (under src) declares for `selector` at every width, all of it in the build of `input` too. */
async function ships(file: string, input: string, selector: string) {
  const written = squeeze(declarations(topLevel(await Bun.file(join(SRC, file)).text()), selector));
  const shipped = squeeze(declarations(await built(input), selector));
  expect({ selector, written: written.length > 0 }).toEqual({ selector, written: true });
  expect({ selector, shipped }).toEqual({ selector, shipped: expect.arrayContaining(written) });
  return shipped;
}

test("the setup rail's horizon ships in the rail's column, under its steps, never laid over them", async () => {
  const shipped = await ships("layout.css", "src/styles.css", ".onb__horizon");
  expect(shipped).toContain("max-height:46dvh");
  expect(shipped.some((d) => /^(position:absolute|inset:|top:|z-index:)/.test(d))).toBe(false);
});

test("a service's × ships in the full ink on its sky", async () => {
  const selector = ".catalog-svc .ac-dialog__acts > .ac-btn--glyph";
  expect(await ships("layout.css", "src/styles.css", selector)).toContain("color:var(--ink)");
});

test("a closed browser's sky takes the line's room in the computer window, steps or not, at every width", async () => {
  // Not only while the line is empty: a run's first step comes before the frame that ends the closed state.
  const selector = ".cmp-body:has(> .brw-ac.is-surface.is-closed) > .cmp-steps-row";
  const file = "components/computer/computer.css";
  expect(await ships(file, `src/${file}`, selector)).toContain("display:none");
});
