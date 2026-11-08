import { expect, test } from "bun:test";
import { atRule, builtCss, declarations, topLevel } from "./built-css";

const css = await builtCss("src/styles.css");
const top = topLevel(css);
const last = (sheet: string, selector: string, property: string) =>
  declarations(sheet, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

test("a settings row's control taller than its name's line stays clear of the hairline above, never in a 22px box", () => {
  const help = ":has(>.settings-row__text>.settings-row__help)";
  for (const [sheet, selector] of [
    [top, `.settings-row--lead${help}>.settings-row__end`],
    [atRule(css, "@media (min-width: 761px)"), `.settings-row${help}>:is(.settings-row__control,.settings-row__end)`],
  ] as const) {
    expect([selector, last(sheet, selector, "height")]).toEqual([selector, undefined]);
    // On the name's line, risen no closer to the hairline than `--action-clear`.
    const rise = last(sheet, selector, "translate")?.replace(/\s+/g, "") ?? "";
    expect(rise).toContain("max(calc(var(--action-clear)-var(--row-py)),calc(11px-50%))");
  }
  // On a phone every control but a switch goes under the words, from their edge, and sits where it falls.
  const phone = atRule(css, "@media (max-width: 760px)");
  const under = ".settings-row--lead>.settings-row__end:not(:has(>.ac-switch))";
  expect(last(phone, under, "flex-basis")).toBe("100%");
  expect(last(phone, under, "padding-left")).toBe("44px");
  // Never wider than the row: a select or a field shrinks into it instead of running past the card's edge.
  expect(last(phone, under, "min-width")).toBe("0");
  expect(last(phone, `.settings-row--lead${help}>.settings-row__end:not(:has(>.ac-switch))`, "translate")).toBe("none");
  expect(last(phone, ".settings-row--lead>.settings-row__end:has(>.ac-seg)", "flex-basis")).toBeUndefined();
  // The agent's panel beside a narrow conversation lays a row with an icon out as a phone does.
  const panel = atRule(css, "@container agp-side (max-width: 479px)");
  expect(last(panel, ".agp-card .settings-row--lead", "flex-wrap")).toBe("wrap");
  expect(last(panel, ".agp-card .settings-row--lead>.settings-row__end:not(:has(>.ac-switch))", "translate")).toBe(
    "none",
  );
  expect(last(panel, ".agp-card .settings-row", "flex-direction")).toBeUndefined();
});
