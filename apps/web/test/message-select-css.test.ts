import { describe, expect, test } from "bun:test";

const ROOT = new URL("../../../", import.meta.url).pathname;

/** Each rule's selectors and its `user-select`, comments left out. */
async function userSelect(path: string) {
  const css = (await Bun.file(ROOT + path).text()).replace(/\/\*[\s\S]*?\*\//g, "");
  const out = new Map<string, string>();
  for (const [, list = "", body = ""] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const value = /(?:^|;)\s*user-select\s*:\s*([a-z]+)/.exec(body)?.[1];
    if (!value) continue;
    for (const selector of list.split(",")) out.set(selector.trim(), value);
  }
  return out;
}

describe("copying a message gives its text, never blank lines after it", () => {
  test("the row selects nothing but its words (and code, and what is typed into it)", async () => {
    const rules = await userSelect("packages/ui/src/styles/components.css");
    expect(rules.get(".ac-msg")).toBe("none");
    for (const selector of [".ac-msg .ac-msg__text", ".ac-msg pre", ".ac-msg input", ".ac-msg textarea"])
      expect([selector, rules.get(selector)]).toEqual([selector, "text"]);
  });
});
