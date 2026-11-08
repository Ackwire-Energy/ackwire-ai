import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GROUPED_ROW, SCREEN_X, TOOL_H, TOUCH } from "../src/ui/rhythm";

const source = (file: string) => readFileSync(new URL(`../src/ui/${file}`, import.meta.url), "utf8");

test("the phone's page rhythm is the web's: sides 16, a toolbar's controls 32 with a 44 target, grouped rows 44", () => {
  expect(SCREEN_X).toBe(16);
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
});

test("a group's header can carry an ⓘ for the whole group, its text under the header", () => {
  const grouped = source("Grouped.tsx");
  expect(grouped).toMatch(/export function GroupedHeader\(\{ children, aside, hint \}/);
  expect(grouped).toContain('useInfoHint({ ...hint, variant: "footnote" })');
});
