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
