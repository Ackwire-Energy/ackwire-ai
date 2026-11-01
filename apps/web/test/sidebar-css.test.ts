import { expect, test } from "bun:test";
import { join } from "node:path";
import { declarations } from "./built-css";

const css = await Bun.file(join(import.meta.dir, "../src/layout.css")).text();
const value = (selector: string, property: string) =>
  declarations(css, selector).findLast(([p]) => p === property)?.[1];

test("a channel's # is no louder than a category's chevron, in its column, and every name starts in one column", () => {
  const mark = '.sidebar:not([data-rail="true"]) .sidebar__item > .sidebar__channel-icon';
  const chevron = ".sidebar__section-chevron";
  // The chevron's 14px and faint ink, in the 18px icons' place (2px each side).
  expect([value(mark, "width"), value(mark, "height"), value(mark, "color"), value(mark, "margin")]).toEqual([
    "14px",
    "14px",
    "var(--faint)",
    "0 2px",
  ]);
  expect([value(chevron, "color"), value(chevron, "margin")]).toEqual(["var(--faint)", "0 2px"]);
  // A category's header starts and spaces its chevron and name as a row does its icon and name.
  const row = '.sidebar:not([data-rail="true"]) .sidebar__item';
  const header = ".sidebar__section-toggle";
  expect([value(header, "padding"), value(header, "gap")]).toEqual([value(row, "padding"), value(row, "gap")]);
  // No step in under a header: a category's rows line up with the ones outside it.
  expect(value('.sidebar:not([data-rail="true"]) .sidebar__section-body', "padding-left")).toBeUndefined();
});

test("the lines between the sidebar's parts never shrink to nothing in a list that scrolls", () => {
  expect(value(".sidebar__divider", "flex")).toBe("none");
});

test("an agent's role sits under its name, up to two lines, with the face at the top and gone in the rail", () => {
  const role = ".sidebar__item-role";
  expect([value(role, "-webkit-line-clamp"), value(role, "font-size"), value(role, "color")]).toEqual([
    "2",
    "12px",
    "var(--ink-muted)",
  ]);
  expect([value(".sidebar__item-text", "flex-direction"), value(".sidebar__item-text", "min-width")]).toEqual([
    "column",
    "0",
  ]);
  const twoLines = '.sidebar:not([data-rail="true"]) .sidebar__item:has(> .sidebar__item-text > .sidebar__item-role)';
  expect(value(twoLines, "align-items")).toBe("flex-start");
  // A 30px row's 4px above the face, so the list keeps even gaps.
  expect(value(twoLines, "padding-block")).toBe("4px");
  expect(value('.sidebar[data-rail="true"] .sidebar__item-text', "display")).toBe("contents");
  expect(value('.sidebar[data-rail="true"] .sidebar__item-role', "display")).toBe("none");
});
