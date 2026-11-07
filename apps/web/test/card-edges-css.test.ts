import { expect, test } from "bun:test";
import path from "node:path";
import { atRule, declarations } from "./built-css";

const ROOT = path.join(import.meta.dir, "../../..");
const sheet = (file: string) => Bun.file(path.join(ROOT, file)).text();
const last = (pairs: (readonly [string, string])[], property: string) => pairs.findLast(([p]) => p === property)?.[1];

test("a narrow task card wraps its chips onto the next line, whole, never past its edge", async () => {
  const issues = await sheet("apps/web/src/pages/issues.css");
  // "Pergunta algo" and "PR #109" side by side ran off a board card's right edge.
  expect(last(declarations(issues, ".issue-card__foot"), "flex-wrap")).toBe("wrap");
  expect(last(declarations(issues, ".issue-card__top"), "flex-wrap")).toBe("wrap");
  // Whole chips: a state or a link is never cut to "Pergu…".
  expect(last(declarations(issues, ".issue-card .ac-chip"), "flex")).toBe("none");
});

test("on a phone a task row wraps its chips under its title and its face, never past the row's edge", async () => {
  const issues = await sheet("apps/web/src/pages/issues.css");
  // "Pede aprovação" beside the face ran 23px past its column and 9px past the row at 390px.
  const narrow = atRule(issues, "@media (max-width: 720px)");
  for (const cell of [".issue-list__title", ".issue-list__who"])
    expect(last(declarations(narrow, cell), "flex-wrap")).toBe("wrap");
});
