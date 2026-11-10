import { expect, test } from "bun:test";
import { join } from "node:path";
import { atRule, declarations, topLevel } from "./built-css";

const css = await Bun.file(join(import.meta.dir, "../src/layout.css")).text();
const last = (sheet: string, selector: string, property: string) =>
  declarations(sheet, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1];

test("the activity bar's room opens and closes in a glide (from 0, not from auto), still with reduced motion", () => {
  const idle = '.channel__composer > .ac-typing:not([data-active="true"])';
  expect(last(topLevel(css), idle, "height")).toBe("0");
  expect(last(topLevel(css), '.ac-typing[data-active="true"]', "height")).toBe("28px");
  const motion = atRule(css, "@media (prefers-reduced-motion: no-preference)");
  const glide = last(motion, ".channel__composer > .ac-typing", "transition") ?? "";
  expect(glide).toContain("height 180ms");
  expect(glide).toContain("margin 180ms");
  expect(last(topLevel(css), ".channel__composer > .ac-typing", "transition")).toBeUndefined();
});

test("an image alone on a message keeps its loading size too (the lone tile's height: auto doesn't win)", () => {
  // The lone picture's `height: auto` would collapse it until the picture decodes: it needs its own loading rule.
  const lone = ".artifact-cards > .artifact-tile[data-media]:only-child .artifact-tile__picture[data-loading]";
  expect(last(topLevel(css), lone, "height")).toBe("180px");
  expect(last(topLevel(css), lone, "width")).toBe("240px");
});

test("a file's name wraps whole, never ending in …; on a phone a file takes the row, pictures two to a row (#51)", () => {
  for (const part of [".artifact-tile__title", ".artifact-tile__meta"]) {
    expect(last(topLevel(css), part, "overflow-wrap")).toBe("anywhere");
    expect(last(topLevel(css), part, "text-overflow")).toBeUndefined();
    expect(last(topLevel(css), part, "white-space")).toBeUndefined();
  }
  const phone = atRule(css, "@media (max-width: 640px)");
  expect(last(phone, ".artifact-tile", "--tile-w")).toBe("calc(50% - 5px)");
  expect(last(phone, ".artifact-tile:not([data-media], .artifact-tile--loading)", "--tile-w")).toBe("100%");
});

test("two tiles to a row on a small phone: a document's cover is drawn smaller, its lines keeping their words", () => {
  // At 120px (a 320px phone) a document's words at their size wrap one or two a line.
  const cover = ".artifact-tile__cover:has(> :is(.artifact-tile__doc, .artifact-tile__text))";
  expect(last(topLevel(css), cover, "container")).toBe("tile-cover / inline-size");
  const narrow = atRule(css, "@container tile-cover (max-width: 150px)");
  expect(last(narrow, ":is(.artifact-tile__doc, .artifact-tile__text)", "zoom")).toBe("0.75");
});

test("the newest rows are never skipped: a message I send is its own height when the glide down reads the end", () => {
  // A row that just came in would start skipped, at the 56px placeholder: the glide would stop short of its real
  // height, and the list jump up the rest once it ends.
  const newest = ".channel__messages > .ac-msg:nth-last-of-type(-n + 3)";
  expect(last(topLevel(css), newest, "content-visibility")).toBe("visible");
  expect(last(topLevel(css), ".channel__messages .ac-msg", "content-visibility")).toBe("auto");
});
