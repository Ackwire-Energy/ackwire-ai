import { expect, test } from "bun:test";
import { atRule, builtCss, declarations, topLevel } from "./built-css";

test("what ships wraps a hold from its top, its lead on the first line and its button in the middle; the other notices are one-line strips, and on phones all share the hold's top line", async () => {
  const css = await builtCss();
  const shipped = topLevel(css);
  const phone = atRule(css, "@media (max-width: 640px)");
  const last = (sheet: string, selector: string, property: string) =>
    declarations(sheet, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];

  // The bold line takes the whole width and wraps.
  expect(last(shipped, ".hold-banner .outage__text", "flex-wrap")).toBe("wrap");
  expect(last(shipped, ".hold-banner .outage__text b", "max-width")).toBe("none");
  expect(last(phone, ".outage__text b", "max-width")).toBe("none");

  // From the top, 11px over the first line and under the last: one 22px line is the 44px strip, at every width.
  expect(last(shipped, ".outage.hold-banner", "align-items")).toBe("flex-start");
  expect(last(shipped, ".outage.hold-banner", "padding-block")).toBe("11px");
  // The lead's middle on the first line's capitals' middle, as an `.ac-iconline` lead's: the 22px line without lh.
  expect(last(shipped, ".hold-banner>:first-child", "translate")).toBe("0 calc(11px - var(--cap-mid) - 50%)");
  expect(css).toContain(
    "@supports (top:1lh){.hold-banner>:first-child{translate:0 calc(.5lh - var(--cap-mid) - 50%)}}",
  );
  // The button in the middle of the lines, as tall as one line to the row; on phones, on a row of its own.
  expect(last(shipped, ".hold-banner>.outage__acts", "align-self")).toBe("center");
  expect(last(shipped, ".hold-banner>.outage__acts", "margin-block")).toBe("calc(11px - var(--control-h-sm) / 2)");
  expect(last(phone, ".hold-banner>.outage__acts", "margin-block")).toBe("0");

  // The offline computer and setup notices keep their centred one-line strip, the × at the buttons' own gap.
  expect(last(shipped, ".outage", "align-items")).toBe("center");
  expect(last(shipped, ".outage", "min-height")).toBe("44px");
  expect(last(shipped, ".outage", "padding")).toBe("6px 10px 6px 16px");
  expect(last(shipped, ".outage__close", "margin-left")).toBe("-6px");

  // On phones every notice reads from the top: the lead and the × on the title's line, whatever wraps under it.
  expect(last(phone, ".outage", "display")).toBe("grid");
  expect(last(phone, ".outage", "align-items")).toBe("start");
  expect(last(phone, ".outage", "padding")).toBe("11px 12px");
  expect(declarations(phone, ".outage>:first-child").map(([, value]) => value)).toEqual([
    "0 calc(11px - var(--cap-mid) - 50%)",
    "0 calc(.5lh - var(--cap-mid) - 50%)",
  ]);
  expect(last(phone, ".outage__close", "margin")).toBe(
    "calc(11px - var(--cap-mid) - var(--control-h-sm) / 2) -12px 0 0",
  );
  // A ghost's words start under the words above, and no button stretches.
  expect(last(phone, ".outage__acts>.ac-btn--ghost:first-child", "margin-left")).toBe("-12px");
  expect(phone).not.toContain(".outage__acts>.ac-btn:not(.ac-btn--icon)");
});
