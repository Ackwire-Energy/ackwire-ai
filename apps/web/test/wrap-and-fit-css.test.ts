import { expect, test } from "bun:test";
import { atRule, builtCss, declarations, topLevel } from "./built-css";

const css = await builtCss("src/styles.css", "src/pages/routines.css", "src/components/plan-usage.css");
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

test("what a row says wraps instead of losing its end to an ellipsis", () => {
  for (const selector of [
    ".routine-row__when-text b",
    ".routine-row__when-text small",
    ".plan-acct__sub",
    ".settings__org>span",
  ]) {
    expect([selector, last(top, selector, "text-overflow")]).toEqual([selector, undefined]);
    expect([selector, last(top, selector, "white-space")]).toEqual([selector, undefined]);
  }
  // An agent's and a connector's names wrap by words, never a letter a line; a level stays whole.
  expect(last(top, ".level-matrix th", "white-space")).toBe("normal");
  expect(last(top, ".level-matrix th", "overflow-wrap")).toBe("break-word");
  expect(last(top, ".level-matrix td", "white-space")).toBe("nowrap");
});

test("usage on a phone: the figures under the name, as wide as the row, not squeezed into a column beside it", () => {
  const phone = atRule(css, "@media (max-width: 720px)");
  expect(last(phone, ".plan-api__row", "grid-template-columns")?.replace(/\s+/g, "")).toBe("28pxminmax(0,1fr)");
  expect(last(phone, ".plan-api__value", "grid-column")?.replace(/\s+/g, "")).toBe("1/-1");
  expect(last(phone, ".plan-api__value", "text-align")).toBe("left");
  expect(last(phone, ".plan-source", "grid-template-columns")?.replace(/\s+/g, "")).toBe("minmax(0,1fr)");
  expect(last(phone, ".plan-source__n", "align-items")).toBe("flex-start");
});

test("a long workspace name never widens the settings' nav", () => {
  expect(last(top, ".settings__nav", "min-width")).toBe("0");
});

test("an agent's identity on a phone: its card as wide as the page, a long role wrapping inside its tag", () => {
  for (const sheet of [atRule(css, "@media (max-width: 640px)"), atRule(css, "@container agp-side (max-width: 640px)")])
    expect(last(sheet, ".agp-id__fields", "align-self")).toBe("stretch");
  expect(last(top, ".agp-roletag", "height")).toBeUndefined();
  expect(last(top, ".agp-roletag", "min-height")).toBe("28px");
  expect(last(top, ".agp-roletag__text", "white-space")).toBeUndefined();
  expect(last(top, ".agp-roletag__text", "text-overflow")).toBeUndefined();
  // The field it turns into keeps the tag's one line.
  expect(last(top, ".agp-roletag.agp-roletag--edit", "height")).toBe("28px");
  // A name that wraps keeps its pencil on its first line.
  expect(last(top, ".agp-inplace", "align-items")).toBe("flex-start");
  expect(last(atRule(css, "@supports (top: 1lh)"), ".agp-inplace__pen", "height")).toBe("1lh");
});
