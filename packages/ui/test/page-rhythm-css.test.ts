import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const kit = readFileSync(new URL("../src/styles/components.css", import.meta.url).pathname, "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** A selector list's selectors, split on its top-level commas only (`:is(a, b)` stays one). */
const split = (list: string) => {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth++;
    else if (list[i] === ")") depth--;
    else if (list[i] === "," && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  return [...out, list.slice(start)].map((s) => s.replace(/\s+/g, " ").trim());
};

/** The bodies of every rule whose selector list holds exactly `selector`, inside `@media` blocks too. */
const body = (selector: string, css = kit) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => split(m[1] ?? "").includes(selector))
    .map((m) => m[2])
    .join("\n");

/** What a `@media` block holds, every block with that exact query. */
const media = (query: string) => {
  const out: string[] = [];
  for (let at = kit.indexOf(`@media ${query} {`); at >= 0; at = kit.indexOf(`@media ${query} {`, at + 1)) {
    let depth = 0;
    let end = kit.indexOf("{", at);
    for (; end < kit.length; end++) {
      if (kit[end] === "{") depth++;
      else if (kit[end] === "}" && --depth === 0) break;
    }
    out.push(kit.slice(kit.indexOf("{", at) + 1, end));
  }
  return out.join("\n");
};

describe("one page top and side", () => {
  test("every page's room is two tokens: the title's line on the sidebar's workspace row, 20 on a phone, 16 at the side under 640", () => {
    expect(body(":root")).toContain("--page-top: calc(38px - var(--control-h-md) / 2);");
    expect(body(":root")).toContain("--page-x: 24px;");
    expect(body(":root", media("(max-width: 760px)"))).toContain("--page-top: 20px;");
    expect(body(":root", media("(max-width: 640px)"))).toContain("--page-x: 16px;");
  });

  test("the title's line and the buttons beside it are as tall as a page's buttons, so they centre on it", () => {
    expect(body(".ac-pagehead__title")).toContain("line-height: var(--control-h-md);");
    expect(body(".ac-pagehead__actions")).toContain("min-height: var(--control-h-md);");
  });
});

describe("cards and rows", () => {
  test("a card is 16 inside, a list row 8 above and below (12 under a finger)", () => {
    const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url).pathname, "utf8");
    expect(tokens).toContain("--row-py: var(--space-2);");
    expect(body(":root", media("(pointer: coarse)"))).toContain("--row-py: var(--space-3);");
    expect(body(".ac-card")).toContain("--card-pad: var(--space-4);");
    expect(body(".ac-card__foot")).toContain("padding: var(--row-py) var(--card-pad, 16px);");
    expect(body(".ac-list__row")).toContain("padding: var(--row-py) var(--space-4);");
  });
});

describe("one group heading", () => {
  test("one 20px line on the list's outer edge, 8 over its rows; groups 24 apart", () => {
    const head = body(".ac-grouphead");
    expect(head).toContain("margin: 0 0 8px;");
    expect(head).toContain("padding: 0;");
    expect(head).toContain("line-height: 20px;");
    expect(head).toContain("min-height: 20px;");
    expect(body(".ac-grouphead__aside")).toContain("margin-left: auto;");
    expect(body(".ac-groups")).toContain("gap: 24px;");
  });
});

describe("one menu rhythm", () => {
  test("rows of 32 (40 on touch), a description adding its line to the same room, Mais 2 apart as menus are", () => {
    expect(body(":root")).toContain("--menu-item-h: 32px;");
    expect(body(":root", media("(pointer: coarse)"))).toContain("--menu-item-h: 40px;");
    expect(body(".ac-menu__item:has(> .ac-menu__label > .ac-menu__desc)")).toBe("");
    expect(kit).not.toContain(".ac-menu:has(.ac-menu__desc) .ac-menu__item {");
    expect(body(".ac-popover:has(> .ac-menu__item)")).toContain("gap: 2px;");
  });

  test("a search's list, a filter's and the workspace menu take the same rows", () => {
    for (const row of [".ac-tz__option", ".ac-filter__option"]) {
      expect(body(row)).toContain("min-height: var(--menu-item-h);");
      expect(body(row)).toContain("padding: calc((var(--menu-item-h) - 20px) / 2) var(--menu-item-px);");
      expect(body(row)).toContain("line-height: 20px;");
    }
    expect(body(".ac-tz__list")).toContain("gap: 2px;");
    expect(body(".ac-tz__list > div")).toContain("gap: 2px;");
    expect(body(".ac-filter__list")).toContain("gap: 2px;");
    expect(body(':is(.ac-menu--select, .ac-menu--dropdown) [role="group"]:not(.ac-menu__reactions)')).toContain(
      "gap: 2px;",
    );
    expect(body(".ac-mo__group")).toContain("--menu-pad: var(--space-2);");
    // The full-screen menu's 15px rows are the touch ones under any pointer: 20px of line and 10 above and below.
    expect(body(".ac-mo__item")).toContain("padding: 10px 14px;");
    expect(body(".ac-suggest__item")).not.toContain("min-height");
  });

  test("a face list keeps its own rows over the menu's", () => {
    expect(body(":is(.ac-menu, .ac-palette__list):has(.ac-menu__leading > .ac-avatar) .ac-menu__item")).toContain(
      "min-height: var(--option-h);",
    );
  });
});

describe("the toolbar", () => {
  test("from 761px a page's toolbar keeps one row: the search giving way down to 160, the rest at the end", () => {
    const wide = media("(min-width: 761px)");
    expect(body(".ac-toolbar:has(> .ac-toolbar__search):not([data-stack])", wide)).toContain("flex-wrap: nowrap;");
    expect(body(".ac-toolbar > .ac-toolbar__search", wide)).toContain("min-width: 160px;");
    expect(body(".ac-toolbar__search")).toContain("flex: 0 1 280px;");
    expect(body(".ac-toolbar > .ac-toolbar__search + *", wide)).toContain("margin-left: auto;");
    expect(body(".ac-toolbar > .ac-toolbar__search + .ac-toolbar__filters + .ac-toolbar__actions", wide)).toContain(
      "margin-left: 0;",
    );
    expect(body(".ac-toolbar:has(> .ac-toolbar__search):not([data-stack]) > .ac-toolbar__filters", wide)).toContain(
      "flex: none;",
    );
  });

  test("two rows on a phone and when one doesn't fit: the search and the actions, then the filters in one scroller", () => {
    const phone = media("(max-width: 760px)");
    expect(body(".ac-toolbar:has(> .ac-toolbar__search) > .ac-toolbar__actions", phone)).toContain("order: 1;");
    expect(body(".ac-toolbar:has(> .ac-toolbar__search) > .ac-toolbar__filters", phone)).toContain("order: 2;");
    expect(body(".ac-toolbar[data-stack] > .ac-toolbar__actions")).toContain("order: 1;");
    const stacked = body(".ac-toolbar[data-stack] > .ac-toolbar__filters");
    expect(stacked).toContain("order: 2;");
    expect(stacked).toContain("flex: 1 1 100%;");
    expect(stacked).toContain("overflow-x: auto;");
    // The filter bar inside the row doesn't scroll on its own, so the row's 4px keep its controls' rings whole.
    expect(kit).not.toMatch(/\.ac-filterbar[^{}]*\{[^}]*overflow-x: auto/);
    expect(body(".ac-toolbar__filters", phone)).toContain("padding: 2px 4px;");
  });

  test("an empty search field gives the hidden hint's room back to its words", () => {
    expect(
      body(".ac-searchfield:not(:has(> .ac-searchfield__clear, > .ac-searchfield__hint)) .ac-searchfield__input"),
    ).toContain("padding-right: var(--control-px-sm);");
    expect(
      body(
        ".ac-searchfield:not(:has(> .ac-searchfield__clear)) .ac-searchfield__input",
        media("(max-width: 760px), (pointer: coarse)"),
      ),
    ).toContain("padding-right: var(--control-px-sm);");
  });

  test("a filter's option ends with its count, then the check", () => {
    expect(body(".ac-filter__option > .ac-countchip")).toContain("margin-left: auto;");
    expect(body(".ac-filter__option > .ac-countchip + .ac-tz__check")).toContain("margin-left: var(--space-2);");
  });
});

describe("a pill on a name's first line", () => {
  test("doesn't rise with .ac-captop, on the line or ending the row on it", () => {
    for (const selector of [
      ".ac-captop:has(.ac-chip)",
      ":is(.ac-list__row, .ac-faceline):has(> .ac-captail > .ac-chip) .ac-captop",
      ".ac-captail.ac-captop:has(> .ac-chip)",
    ])
      expect(body(selector)).toContain("margin-block-start: 0;");
  });
});
