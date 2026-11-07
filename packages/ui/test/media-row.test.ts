import { describe, expect, test } from "bun:test";

const css = (await Bun.file(new URL("../src/styles/components.css", import.meta.url).pathname).text()).replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
/** Every rule as [selector, body], at-rule blocks included. */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [(m[1] ?? "").trim(), m[2] ?? ""] as const);
const body = (selector: string) =>
  rules
    .filter(([s]) => s === selector)
    .map(([, b]) => b)
    .join(";");

describe("MediaRow", () => {
  test("the face, then the name and the role on its line, the rest under them at the row's full width", () => {
    expect(body(".ac-mediarow")).toContain("grid-template-columns: auto minmax(0, 1fr) auto;");
    expect(body(".ac-mediarow__face")).toContain("grid-area: 1 / 1;");
    expect(body(".ac-mediarow__head")).toContain("grid-area: 1 / 2;");
    expect(body(".ac-mediarow__end")).toContain("grid-area: 1 / 3;");
    expect(body(".ac-mediarow__body")).toContain("grid-column: 1 / -1;");
    // The name's line never pushes the row past its box: it wraps, its words too.
    expect(body(".ac-mediarow__head")).toContain("min-width: 0;");
    expect(body(".ac-mediarow__body")).toContain("min-width: 0;");
  });

  test("nothing puts the text in a column beside the face", () => {
    const beside = rules.filter(
      ([s, b]) => /\.ac-mediarow__body\b/.test(s) && /grid-(column|area)\s*:\s*(2|auto \/ 2)\b/.test(b),
    );
    expect(beside).toEqual([]);
  });

  test("a face of 32 in a card's head, 24 in a list row, 12 and 8 from the name", () => {
    expect(body(".ac-mediarow__face > :is(.ac-avatar, .ac-rolemark)")).toContain("width: 32px;");
    expect(body(".ac-mediarow--row > .ac-mediarow__face > :is(.ac-avatar, .ac-rolemark)")).toContain("width: 24px;");
    expect(body(".ac-mediarow")).toContain("column-gap: var(--space-3);");
    expect(body(".ac-mediarow--row")).toContain("column-gap: var(--space-2);");
    expect(body(".ac-mediarow")).toContain("row-gap: var(--space-2);");
  });

  test("in a box under 480px, what ends the head drops under the text, at its start", () => {
    const narrow = css.match(/@container \(max-width: 479px\)\s*\{([\s\S]*?\})\s*\}/)?.[1] ?? "";
    expect(narrow).toContain(".ac-mediarow__end--wrap");
    expect(narrow).toContain("grid-area: auto / 1 / auto / -1;");
    expect(narrow).toContain("order: 1;");
    expect(narrow).toContain("justify-self: start;");
  });

  test("a task's number reads inline in its title's words, muted, in even figures", () => {
    expect(body(".ac-mediarow__num")).toContain("font-variant-numeric: tabular-nums;");
    expect(body(".ac-mediarow__meta,\n.ac-mediarow__num")).toContain("color: var(--ink-muted);");
  });
});
