import { expect, test } from "bun:test";
import { join } from "node:path";
import { atRule, declarations, topLevel } from "./built-css";

const SRC = join(import.meta.dir, "../src");
const UI = join(import.meta.dir, "../../../packages/ui/src/styles");
const read = (path: string) => Bun.file(path).text();
const last = (sheet: string, selector: string, property: string) =>
  declarations(sheet, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];
const px = (tokens: string, name: string) => {
  const raw = last(tokens, ":root", name);
  const ref = raw?.match(/^var\((--[\w-]+)\)$/)?.[1];
  return Number.parseFloat((ref ? last(tokens, ":root", ref) : raw) ?? "NaN");
};

test("a menu's rows have the same room at its ends as at its sides, a select's too", async () => {
  const kit = topLevel(await read(join(UI, "components.css")));
  expect(last(kit, ".ac-menu", "padding")).toBe("var(--menu-pad)");
  // A select's room at its ends is its viewport's (kept when scrolled), never the menu's on top of it.
  expect(last(kit, ".ac-menu--select", "padding-block")).toBe("0");
  expect(last(kit, ".ac-menu--select [data-radix-select-viewport]", "padding-block")).toBe("var(--menu-pad)");
  // A row's top and bottom are one value; a row with a face or a description is as deep as its sides.
  expect(last(kit, ".ac-menu__item", "padding")).toBe("calc((var(--menu-item-h) - 20px) / 2) var(--menu-item-px)");
  expect(last(kit, ".ac-menu__item:has(>.ac-menu__label>.ac-menu__desc)", "padding-block")).toBe("var(--menu-item-px)");
  expect(last(kit, ".ac-menu--select:has(.ac-menu__leading>.ac-avatar) .ac-menu__item", "padding-block")).toBe(
    "var(--space-2)",
  );
  expect(last(kit, ":root", "--menu-item-px")).toBe("8px");
  expect(last(kit, ".ac-option", "padding")).toBe("var(--space-3)");
});

test("a rounded thing near a rounded box's edge has the box's radius less the room between them", async () => {
  const kit = await read(join(UI, "components.css"));
  const top = topLevel(kit);
  const tokens = topLevel(await read(join(UI, "tokens.css")));
  // Menus, selects and popovers: the box is its rows' radius plus its room.
  expect(last(top, ".ac-menu", "border-radius")).toBe("calc(var(--radius-item) + var(--menu-pad))");
  expect(last(top, ".ac-menu__item", "border-radius")).toBe("var(--radius-item)");
  expect(last(top, ".ac-menu__reaction", "border-radius")).toBe("var(--radius-item)");
  // The emoji picker: 8px of room, and its search, tabs, segmented tabs and cells on the rows' radius.
  expect(last(top, ".ac-emoji-popover", "--menu-pad")).toBe("var(--space-2)");
  expect(last(top, ".ac-emoji-popover", "padding")).toBe("var(--menu-pad)");
  for (const inner of [".ac-emoji__search", ".ac-emoji__tab"])
    expect(last(top, inner, "border-radius")).toBe("var(--control-r-sm)");
  expect(last(top, ".ac-picker .ac-tabs--seg", "--seg-r")).toBe("var(--control-r-sm)");
  expect(px(tokens, "--control-r-sm")).toBe(px(tokens, "--radius-item"));
  expect(px(tokens, "--radius-item") + px(tokens, "--space-2")).toBeLessThanOrEqual(px(tokens, "--radius-xl"));
  // The message's hover bar, with a mouse and under a finger.
  expect(last(top, ".ac-msg__actions", "padding")).toBe("var(--bar-pad)");
  expect(last(top, ".ac-msg__actions", "border-radius")).toBe("var(--bar-r)");
  const inBar = "calc(var(--bar-r) - var(--bar-pad))";
  expect(last(top, ".ac-msg__actions .ac-btn--sm", "border-radius")).toBe(inBar);
  expect(last(atRule(kit, "@media (pointer: coarse)"), ".ac-msg__actions .ac-btn--sm", "border-radius")).toBe(inBar);
  // Segmented controls, and the command palette's rows in its list.
  expect(last(top, ".ac-seg__item", "border-radius")).toBe("calc(var(--seg-r) - var(--seg-in))");
  expect(last(top, ".ac-palette__list", "padding")).toBe("var(--palette-pad)");
  expect(last(top, ".ac-palette__item", "border-radius")).toBe("calc(var(--radius-section) - var(--palette-pad))");
  // Menus whose search row and list hold the room themselves: the corner follows that room, not the default.
  for (const menu of [".ac-tz__menu.ac-menu", ".ac-filter__menu.ac-menu"]) {
    expect(last(top, menu, "--menu-pad")).toBe("6px");
    expect(last(top, menu, "padding")).toBe("0");
  }
  for (const inner of [".ac-tz__searchrow", ".ac-tz__list", ".ac-filter__list"])
    expect(last(top, inner, "padding")).toBe("var(--menu-pad)");
  // The phone-style menu overlay: 8px of room inside a section's corner.
  expect(last(top, ".ac-mo__group", "padding")).toBe("var(--space-2)");
  expect(last(top, ".ac-mo__item", "border-radius")).toBe("calc(var(--radius-section) - var(--space-2))");
  // Popovers with their own room set it as the menu's, so their corner follows.
  const layout = topLevel(await read(join(SRC, "layout.css")));
  expect(last(layout, ".agp-changes.ac-popover", "padding")).toBe("var(--menu-pad)");
  expect(last(layout, ".agp-changes__item", "border-radius")).toBe("var(--radius-item)");
  expect(last(layout, ".agp-changes__jump", "border-radius")).toBe("calc(var(--radius-item) - 4px)");
  const calendar = topLevel(await read(join(SRC, "pages/calendar.css")));
  expect(last(calendar, ".cal-more.ac-popover", "padding")).toBe("var(--menu-pad)");
});

test("every hairline between a card's rows, and over its foot, has one step of room on each side", async () => {
  const kit = topLevel(await read(join(UI, "components.css")));
  const tokens = topLevel(await read(join(UI, "tokens.css")));
  expect(last(tokens, ":root", "--row-py")).toBe("var(--space-3)");
  expect(last(kit, ".ac-card", "gap")).toBe("var(--space-3)");
  expect(last(kit, ".ac-card__foot", "padding")).toBe("var(--row-py) var(--card-pad, 20px)");
  const layout = topLevel(await read(join(SRC, "layout.css")));
  expect(last(layout, ".settings-row", "padding")).toBe("var(--row-py) var(--card-pad)");
  expect(last(layout, ".voice-engine__body", "padding")).toBe("var(--row-py) var(--card-pad)");
  // Over a foot, the rows give back the card's gap: the last row's padding is all that's over the foot's hairline.
  expect(last(layout, ".settings-rows:has(+.ac-card__foot)", "margin-bottom")).toBe("calc(-1 * var(--space-3))");
  const roles = topLevel(await read(join(SRC, "components/roles/roles.css")));
  expect(last(roles, ".roles-row", "padding")).toBe("var(--row-py) 20px");
  expect(last(roles, ".roles-area", "padding")).toBe("var(--row-py) 0");
  expect(last(roles, ".roles-look__row", "padding")).toBe("var(--row-py) 0");
  const people = topLevel(await read(join(SRC, "components/people-usage.css")));
  expect(last(people, ".pu-limits__row", "padding")).toBe("var(--row-py) 0");
  const plan = topLevel(await read(join(SRC, "components/plan-usage.css")));
  expect(last(plan, ".plan-block", "padding")).toBe("var(--row-py) 0");
});

test("the settings sidebar's links are the ruler's compact step, the default one under a finger", async () => {
  const css = await read(join(SRC, "layout.css"));
  const top = topLevel(css);
  expect(last(top, ".settings__link", "min-height")).toBe("var(--control-h-sm)");
  expect(last(top, ".settings__link", "border-radius")).toBe("var(--control-r-sm)");
  expect(last(top, ".settings__groups", "gap")).toBe("var(--space-4)");
  const touch = atRule(css, "@media (pointer: coarse)");
  expect(last(touch, ".settings__link", "min-height")).toBe("var(--control-h-md)");
});
