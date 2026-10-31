import { expect, test } from "bun:test";
import { builtCss, declarations, topLevel } from "./built-css";

test("what ships keeps the bar above the composer one low width: the words take what is left, the clock ticks in place", async () => {
  const css = topLevel(await builtCss());
  const last = (selector: string, property: string) =>
    declarations(css, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];
  const bar = '.ac-typing[data-active="true"]';
  // One width whatever it says or shows (a turning phrase, the seconds, "Ver" or the stop coming and going): no width
  // of its own, so it fills the composer, up to 400px.
  expect(last(bar, "width")).toBeUndefined();
  expect(last(bar, "max-width")).toBe("400px");
  expect(last(bar, "height")).toBe("28px");
  // The words never size it: they take the room left and end in "…".
  const words = `${bar} .ac-typing__text`;
  expect(last(words, "flex")).toBe("1 1 0");
  expect(last(words, "min-width")).toBe("0");
  expect(last(words, "white-space")).toBe("nowrap");
  expect(last(words, "text-overflow")).toBe("ellipsis");
  // Its round buttons fit the low pill.
  expect(last(".ac-typing .stop-run", "height")).toBe("24px");
  expect(last(".ac-typing__browser.ac-btn", "height")).toBe("24px");
  // The clock's figures are all one width (`ac-num`), so the seconds never nudge it.
  expect(last(".ac-num", "font-variant-numeric")).toBe("tabular-nums");
});
