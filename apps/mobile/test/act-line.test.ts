import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "../src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });

test("words and their actions wrap as the web's .ac-actline: the words from their one-line width, the action under them", () => {
  const line = readFileSync(join(SRC, "ui/ActLine.ts"), "utf8");
  expect(line).toContain('row: { flexWrap: "wrap", justifyContent: "flex-start" }');
  expect(line).toContain('text: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", minWidth: 0 }');
  // The old row (an action at the row's end under words kept to 170) is gone everywhere.
  const old = files(SRC).filter((f) => /\bACT_ROW\b|from "\.\/ActRow"/.test(readFileSync(f, "utf8")));
  expect(old.map((f) => relative(SRC, f))).toEqual([]);
  for (const user of ["features/chat/TeamChecks.tsx", "features/chat/Receipts.tsx"])
    expect(readFileSync(join(SRC, user), "utf8")).toContain("ACT_LINE.row");
});
