import { expect, test } from "bun:test";
import { atRule, builtCss, declarations, topLevel } from "./built-css";

test("the channel header's icons are 32px boxes with a plate only under the pointer, pressed or open, the threads count sits beside its icon, and a phone keeps the search as an icon", async () => {
  const css = await builtCss("src/styles.css", "src/components/channel-header.css", "src/components/search/search.css");
  const shipped = topLevel(css);
  const phone = atRule(css, "@media (max-width: 760px)");
  const last = (sheet: string, selector: string, property: string) =>
    declarations(sheet, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];

  expect(last(shipped, ".channel__acts", "gap")).toBe("2px");
  // At rest a bare icon in the header's gray (the minifier writes `background: none` as `0 0`).
  expect(last(shipped, ".channel__icon.ac-btn", "background")).toBe("0 0");
  expect(last(shipped, ".channel__icon.ac-btn", "box-shadow")).toBe("none");
  expect(last(shipped, ".channel__icon.ac-btn", "color")).toBe("var(--muted)");
  // Under the pointer, pressed or open: a plate and the text's ink, no ring.
  const on = '.channel__icon.ac-btn:is(:hover, :active, [aria-pressed="true"], [aria-expanded="true"])';
  expect(last(shipped, on, "background")).toBe("var(--plate)");
  expect(last(shipped, on, "box-shadow")).toBe("none");
  expect(last(shipped, on, "color")).toBe("var(--ink)");
  // One 32px box per icon, as wide as what it holds (a count widens it), no reach into its neighbours.
  expect(last(shipped, ".channel__icon.ac-btn", "width")).toBe("auto");
  expect(last(shipped, ".channel__icon.ac-btn", "min-width")).toBe("32px");
  expect(last(shipped, ".channel__icon.ac-btn", "height")).toBe("32px");
  expect(last(shipped, ".channel__icon.ac-btn", "margin")).toBe("0");
  expect(last(shipped, ".channel__icon.ac-btn", "padding")).toBe("0");
  expect(last(shipped, ".channel__icon.ac-btn", "border-radius")).toBe("10px");

  // The threads count: plain figures beside the icon, in the text's ink, never a badge over it.
  expect(last(shipped, ".channel__icon-count.ac-count", "position")).toBe("static");
  expect(last(shipped, ".channel__icon-count.ac-count", "background")).toBe("0 0");
  expect(last(shipped, ".channel__icon-count.ac-count", "color")).toBe("var(--ink)");
  expect(last(shipped, ".channel__icon-count.ac-count", "font-weight")).toBe("600");
  expect(last(shipped, ".channel__icon-count.ac-count", "font-size")).toBe("13.5px");
  expect(last(shipped, ".channel__icon-count.ac-count", "box-shadow")).toBe("none");

  // The field: a soft plate with no line at rest, and it grows while it is used.
  expect(last(shipped, ".channel__search.search-box", "width")).toBe("220px");
  expect(last(shipped, ".channel__search.search-box:focus-within", "width")).toBe("300px");
  expect(last(shipped, ".channel__search .search-box__field", "background")).toBe("var(--plate-soft)");
  expect(last(shipped, ".channel__search .search-box__field", "border-color")).toBe("transparent");
  // The topic follows the title with no line between them.
  expect(last(shipped, ".channel__head-text .channel__topic", "border-left")).toBeUndefined();
  expect(last(shipped, ".channel__head-text .channel__topic", "color")).toBe("var(--muted)");

  // A phone: the topic, pins, settings and the field go; the search is an icon that opens a sheet.
  expect(last(phone, ".channel__head-text .channel__topic", "display")).toBe("none");
  expect(last(phone, ".channel__acts>.channel__search", "display")).toBe("none");
  // The cog stays when there is no members sheet to move it into.
  expect(last(phone, ".channel__acts:has(.channel__members-toggle)>.channel__cog", "display")).toBe("none");
  expect(last(shipped, ".channel__search-icon.ac-btn", "display")).toBe("none");
  expect(last(phone, ".channel__search-icon.ac-btn", "display")).toBe("inline-flex");

  // A search hit has its own cool mark, from the info color, never a mention's tan.
  expect(last(shipped, "[data-theme=light]", "--search-hit")).toContain("var(--info)");
  expect(last(shipped, "[data-theme=dark]", "--search-hit")).toContain("var(--info)");
  expect(last(shipped, ".search-hit__mark", "background")).toBe("var(--search-hit)");
});
