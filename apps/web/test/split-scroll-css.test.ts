import { expect, test } from "bun:test";
import { join } from "node:path";
import { atRule, builtCss, declarations } from "./built-css";

const WIDE = "@media (min-width: 941px) and (min-height: 560px)";
const NARROW = "@media (max-width: 940px)";
const SPLIT_PAGES = ["src/pages/ApprovalsPage.tsx", "src/pages/ProposalsPage.tsx", "src/pages/SettingsPage.tsx"];

test("a list beside what it opens: the page never scrolls, each column does; narrower the columns stack, and shorter the page scrolls", async () => {
  const css = await builtCss("src/styles.css", "src/pages/approvals.css");
  const wide = atRule(css, WIDE);
  // The work area holding a split clips instead of scrolling; the height reaches the split; each column scrolls.
  expect(declarations(wide, ".shell__main:has(.page-split)")).toContainEqual(["overflow", "hidden"]);
  expect(declarations(wide, ".shell__main .page-split")).toContainEqual(["min-height", "0"]);
  const column = declarations(wide, ".shell__main .page-split>*");
  expect(column).toContainEqual(["overflow-y", "auto"]);
  expect(column).toContainEqual(["min-height", "0"]);
  expect(declarations(wide, ".shell__main .page-split>*>*")).toContainEqual(["flex-shrink", "0"]);
  // A short window (small or zoomed in) keeps the page's scroll: under the header the columns would have no room.
  expect(declarations(atRule(css, "@media (min-width: 941px)"), ".shell__main:has(.page-split)")).toEqual([]);
  // Below that width the pages stack their columns, so the page scrolls as one again.
  const narrow = atRule(css, NARROW);
  expect(declarations(narrow, ".ap-split")).toContainEqual(["grid-template-columns", "minmax(0,1fr)"]);
  expect(declarations(narrow, ".settings")).toContainEqual(["flex-direction", "column"]);
  // The old way, a list stuck to the top of a scrolling page, is gone.
  expect(declarations(css, ".ap-list").filter(([p]) => p === "position" || p === "max-height")).toEqual([]);
  for (const page of SPLIT_PAGES)
    expect(await Bun.file(join(import.meta.dir, "..", page)).text()).toContain("page-split");
});
