import { expect, test } from "bun:test";
import { atRule, builtCss, declarations, topLevel } from "./built-css";

test("the channel header's icons never get a plate, sit 14px apart, and a phone keeps the search as an icon", async () => {
  const css = await builtCss("src/styles.css", "src/components/channel-header.css", "src/components/search/search.css");
  const shipped = topLevel(css);
  const phone = atRule(css, "@media (max-width: 760px)");
  const last = (sheet: string, selector: string, property: string) =>
    declarations(sheet, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];

  expect(last(shipped, ".channel__acts", "gap")).toBe("14px");
  // Hover, a press or an open popover only change the icon's color, as Discord's header does.
  for (const state of ["", ":hover", ":active", "[aria-pressed=true]", "[aria-expanded=true]"]) {
    const selector = `.channel__icon.ac-btn${state}`;
    // The minifier writes `background: none` as `0 0`.
    expect([selector, last(shipped, selector, "background")]).toEqual([selector, "0 0"]);
    expect([selector, last(shipped, selector, "box-shadow")]).toEqual([selector, "none"]);
  }
  expect(last(shipped, ".channel__icon.ac-btn", "color")).toBe("var(--muted)");
  expect(last(shipped, ".channel__icon.ac-btn:hover", "color")).toBe("var(--ink)");
  expect(last(shipped, ".channel__icon.ac-btn", "width")).toBe("24px");
  expect(last(shipped, ".channel__icon.ac-btn", "margin")).toBe("0 -6px");

  // The field grows while it is used.
  expect(last(shipped, ".channel__search.search-box", "width")).toBe("248px");
  expect(last(shipped, ".channel__search.search-box:focus-within", "width")).toBe("320px");

  // A phone: the topic, pins, settings and the field go; the search is an icon that opens a sheet.
  expect(last(phone, ".channel__head-text .channel__topic", "display")).toBe("none");
  expect(last(phone, ".channel__acts>.channel__search", "display")).toBe("none");
  expect(last(phone, ".channel__acts>.channel__cog", "display")).toBe("none");
  expect(last(shipped, ".channel__search-icon.ac-btn", "display")).toBe("none");
  expect(last(phone, ".channel__search-icon.ac-btn", "display")).toBe("inline-flex");

  // A search hit has its own cool mark, from the info color, never a mention's tan.
  expect(last(shipped, "[data-theme=light]", "--search-hit")).toContain("var(--info)");
  expect(last(shipped, "[data-theme=dark]", "--search-hit")).toContain("var(--info)");
  expect(last(shipped, ".search-hit__mark", "background")).toBe("var(--search-hit)");
});
