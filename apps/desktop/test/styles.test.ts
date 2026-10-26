import { describe, expect, test } from "bun:test";

describe("equal side padding", () => {
  test("blocks with visible edges span their column, so no cap leaves the right side wider than the left", async () => {
    const css = await Bun.file(new URL("../src/styles.css", import.meta.url).pathname).text();
    const rule = (selector: string) => css.split(`\n${selector} {`)[1]?.split("}")[0];
    for (const selector of [
      // First run: the server form, help card, found servers and problem line; Run here's form, ways, steps and bar.
      ".dk-fr__form",
      ".dk-fr__problem",
      ".dk-fr__found",
      ".dk-fr__none",
      ".dk-fr__ways",
      ".dk-fr__here",
      ".dk-fr__end[data-near]",
      ".dk-fr__steps",
      ".dk-fr__bar",
      // Preferences › Folders: the note under the cards.
      ".dk-note",
    ]) {
      expect(rule(selector)).toBeDefined();
      expect(rule(selector)).not.toContain("max-width");
    }
  });
});
