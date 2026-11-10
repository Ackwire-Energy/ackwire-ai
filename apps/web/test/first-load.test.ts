import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "../src");
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );
const SOURCES = files(SRC).map((f) => ({ path: relative(SRC, f), code: readFileSync(f, "utf8") }));
/** The source files that import `name` (a module's file name, by its alias or a relative path). */
const importers = (name: string) =>
  SOURCES.filter((s) => new RegExp(`from "(?:@/[\\w/-]+|\\.{1,2}(?:/[\\w-]+)*)/${name}"`).test(s.code))
    .map((s) => s.path)
    .sort();

test("the computers' screens and the import load with their own pages, never with the app (#1)", () => {
  expect(importers("Machines")).toEqual(["components/devices/DevicePage.tsx", "components/devices/DevicesSection.tsx"]);
  expect(importers("DevicePage")).toEqual(["pages/SettingsPage.tsx"]);
  expect(importers("DevicesSection")).toEqual(["components/devices/DevicePage.tsx", "pages/SettingsPage.tsx"]);
  expect(importers("ImportFlow")).toEqual(["pages/NewAgentPage.tsx", "pages/SettingsPage.tsx"]);
  // Pages only routes import, which the router splits out of the first load.
  for (const page of ["SettingsPage", "NewAgentPage"])
    for (const by of importers(page)) expect({ page, by }).toEqual({ page, by: expect.stringMatching(/^routes\//) });
});
