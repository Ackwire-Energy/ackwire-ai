import { expect, test } from "bun:test";
import { atRule, builtCss, declarations, topLevel } from "./built-css";

test("what ships gives the emoji popover one scroll, the menu's two lines one length, and a phone's placeholder its …", async () => {
  const css = await builtCss();
  const last = (sheet: string, selector: string, property: string) =>
    declarations(sheet, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];
  const shipped = topLevel(css);

  // Held to a menu's 280px, the picker gives up height through its grid alone, the one that scrolls.
  expect(last(shipped, ".ac-menu", "max-height")).toBe("280px");
  expect(last(shipped, ".ac-emoji", "min-height")).toBe("0");
  expect(last(shipped, ".ac-emoji__search", "flex")).toBe("none");
  expect(last(shipped, ".ac-emoji__tabs", "flex")).toBe("none");
  // Never sideways, up and down only: the minifier joins overflow-x and overflow-y into one shorthand.
  expect(last(shipped, ".ac-emoji__scroll", "overflow")).toBe("hidden auto");

  // The line under the reactions stops 8px in from each side, where a separator does.
  expect(last(shipped, ".ac-menu__separator", "margin")).toBe("4px var(--menu-item-px)");
  expect(last(shipped, ":root", "--menu-item-px")).toBe("8px");
  expect(last(shipped, ".ac-menu__reactions", "border-bottom")).toBeUndefined();
  expect(last(shipped, ".ac-menu__reactions", "background")).toContain("calc(100% - 16px) 1px no-repeat");

  // Chrome ends a textarea's placeholder in "…" only when the textarea has the ellipsis too.
  const phone = atRule(css, "@media (max-width: 640px)");
  expect(last(phone, ".ac-composer textarea::placeholder", "text-overflow")).toBe("ellipsis");
  expect(last(phone, ".ac-composer textarea:placeholder-shown", "text-overflow")).toBe("ellipsis");
});
