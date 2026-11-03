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
  // `.artifact-tile:only-child .file-thumb` (0,3,0) beats `.file-thumb[data-loading]` (0,2,0): the lone tile needs its own rule.
  const lone = ".artifact-tile:only-child .file-thumb[data-loading]";
  expect(last(topLevel(css), lone, "height")).toBe("180px");
  expect(last(topLevel(css), lone, "width")).toBe("240px");
});
