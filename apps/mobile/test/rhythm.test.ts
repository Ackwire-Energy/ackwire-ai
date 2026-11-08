import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CARD_PAD, GROUPED_ROW, SCREEN_X, TOOL_H, TOUCH } from "../src/ui/rhythm";

const SRC = join(import.meta.dir, "../src");
const source = (file: string) => readFileSync(new URL(`../src/ui/${file}`, import.meta.url), "utf8");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
  });

test("the phone's page rhythm is the web's: sides 16, cards 16 inside, a toolbar's controls 32 with a 44 target, grouped rows 44", () => {
  expect(SCREEN_X).toBe(16);
  expect(CARD_PAD).toBe(16);
  expect(TOOL_H).toBe(32);
  expect(TOUCH).toBe(44);
  // A wrapping row's label starts where a one-line row's does: its 22-point line centred in 44.
  expect(GROUPED_ROW).toEqual({ minHeight: 44, padX: 16, padY: 8, tallPadY: 11 });
});

test("the kit's screens, grouped rows and toolbar controls read those numbers instead of their own", () => {
  const grouped = source("Grouped.tsx");
  expect(grouped).not.toMatch(/minHeight: 50|paddingHorizontal: 14|\b14 \+ LEAD/);
  expect(grouped).toContain("minHeight: GROUPED_ROW.minHeight");
  expect(source("Segmented.tsx")).toContain("minHeight: TOOL_H - 2 * PAD");
  expect(source("Filters.tsx")).toContain("minHeight: TOOL_H");
  expect(source("Filters.tsx")).toContain("gap: 8");
  expect(source("LargeTitleScreen.tsx")).toContain("paddingHorizontal: SCREEN_X");
  expect(source("SectionHeader.tsx")).toContain("paddingHorizontal: SCREEN_X");
  expect(source("Row.tsx")).toContain("paddingHorizontal: CARD_PAD");
});

test("no screen keeps a 20-point side of its own: screens read SCREEN_X and cards CARD_PAD", () => {
  // A button's own padding isn't a screen's side.
  const NOT_A_SIDE = new Set(["ui/Button.tsx"]);
  const offenders = files(SRC)
    .filter((path) => !NOT_A_SIDE.has(relative(SRC, path)))
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          /\b(padding|paddingHorizontal|marginHorizontal): 20\b/.test(line) ? [`${relative(SRC, path)}:${i + 1}`] : [],
        ),
    );
  expect(offenders).toEqual([]);
});

test("a group's header can carry an ⓘ for the whole group, its text under the header", () => {
  const grouped = source("Grouped.tsx");
  expect(grouped).toMatch(/export function GroupedHeader\(\{ children, aside, hint \}/);
  expect(grouped).toContain('useInfoHint({ ...hint, variant: "footnote" })');
});

test("a row's ⓘ sits right after its label, and a short fact about its value goes on the value's line", () => {
  const grouped = source("Grouped.tsx");
  expect(grouped).toContain("<Row {...props} said={hint.text} labelAfter={info.button} />");
  expect(grouped).toMatch(/<View style=\{styles\.labelLine\}>\s*<Text variant="body"/);
  expect(grouped).toMatch(/\{valueNote \? \(\s*<Text variant="footnote" tone="faint" numberOfLines=\{1\}>/);
});
