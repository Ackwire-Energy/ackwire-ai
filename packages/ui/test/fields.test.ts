import { describe, expect, test } from "bun:test";

const read = (path: string) => Bun.file(new URL(path, import.meta.url).pathname).text();

/** CSS rules as [selector, body], comments removed. */
const rules = (css: string) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    (m) => [(m[1] ?? "").trim(), m[2] ?? ""] as const,
  );

const FIELD =
  /ac-input|ac-select__trigger|ac-search|ac-option|ac-pill|ac-composer|textarea|input|\.field|segmented|\.pill\b/;
const INK_BORDER = /border(-[a-z]+)?(-color)?\s*:[^;]*var\(--ink\)/;

describe("fields are v2 (no black borders)", () => {
  for (const [name, path] of [
    ["packages/ui components.css", "../src/styles/components.css"],
    ["apps/web layout.css", "../../../apps/web/src/layout.css"],
  ] as const) {
    test(`${name}: inputs, selects, search, radio cards and pills never use an ink border`, async () => {
      const offending = rules(await read(path))
        .filter(([selector, body]) => FIELD.test(selector) && INK_BORDER.test(body))
        .map(([selector]) => selector);
      expect(offending).toEqual([]);
    });
  }

  test("inputs, textareas and select triggers rest on the soft field surface with a hairline", async () => {
    const css = await read("../src/styles/components.css");
    const body = (selector: string) => rules(css).find(([s]) => s === selector)?.[1] ?? "";
    for (const selector of [".ac-input", ".ac-select__trigger", ".ac-input-affix"]) {
      expect(body(selector)).toContain("background: var(--field-bg)");
      expect(body(selector)).toContain("border: 1px solid var(--field-line)");
    }
    expect(body(".ac-input:focus")).toContain("var(--field-ring)");
    // Radio cards: chosen = raised + a 1.5px ink ring, never a gray fill.
    const chosen = rules(css).find(([s]) => s.includes('.ac-option[data-state="checked"]') && !s.includes(":has"))?.[1];
    expect(chosen).toContain("0 0 0 1.5px var(--ink)");
    expect(chosen).toContain("background: var(--raised)");
  });
});
