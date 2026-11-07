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

test("a version's note longer than its line breaks instead of running past its card", async () => {
  const kit = await sheet("packages/ui/src/styles/components.css");
  const drive = await sheet("apps/web/src/pages/drive.css");
  // "alerta confirmado15:15:57Brasília,link/ts/ação" ran past the version card's right edge, in the file viewer's
  // versions and in the Drive's. break-word, not anywhere: no box sizes itself differently for it.
  expect(last(declarations(kit, ".ac-navcard"), "overflow-wrap")).toBe("break-word");
  expect(last(declarations(drive, ".drive-versions__text"), "overflow-wrap")).toBe("break-word");
  // The wiki's versions and an agent's quoted reason on a browser request: text in a flex row, which only anywhere
  // lets shrink below its longest word.
  const wiki = await sheet("apps/web/src/pages/wiki.css");
  const browser = await sheet("apps/web/src/components/browser/browser.css");
  expect(last(declarations(wiki, ".wiki-history__item"), "overflow-wrap")).toBe("anywhere");
  expect(last(declarations(browser, ".brw-rq__why"), "overflow-wrap")).toBe("anywhere");
  // A toast's names and titles (a setor someone named) ran under its × and past its edge.
  expect(last(declarations(kit, ".ac-toast__text"), "overflow-wrap")).toBe("break-word");
  // Not the whole app: a word in an already squeezed box would break letter by letter.
  expect(last(declarations(kit, "body"), "overflow-wrap")).toBeUndefined();
});
