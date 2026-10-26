import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../../../", import.meta.url).pathname;
const SOURCES = ["apps/web/src", "packages/ui/src", "apps/desktop/src"];

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? cssFiles(join(dir, e.name)) : e.name.endsWith(".css") ? [join(dir, e.name)] : [],
  );
}

/** Every rule as [file, selector, body], comments removed; rules inside @media and @supports included. */
async function allRules() {
  const out: [string, string, string][] = [];
  for (const file of SOURCES.flatMap((d) => cssFiles(join(ROOT, d)))) {
    const css = (await Bun.file(file).text()).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
      for (const selector of (m[1] ?? "").split(","))
        out.push([relative(ROOT, file), selector.replace(/\s+/g, " ").trim(), m[2] ?? ""]);
  }
  return out;
}

/** A selector for a line's lead: an icon, a maker's mark, a bare svg or a row's first child. */
const LEAD = /(?:\.ac-icon|\.ac-brand[\w-]*|(?:^|[\s>+~])(?:svg|:first-child))$/;
/** The hand-tuned nudge `.ac-iconline` replaces. */
const NUDGE = /(?:^|;)\s*margin-top:\s*[1-4](?:\.\d+)?px\s*(?:;|$)/;

/** Leads still placed by hand, and why. An entry leaves when its rule does. */
const PLACED_BY_HAND: Record<string, string> = {
  "packages/ui/src/styles/components.css .ac-menu__item .ac-icon":
    "menu items are one line (no wrapping) of 14px text on their own 20px line, which the 16px icon sits on",
  "apps/web/src/components/browser/browser.css .brw-note > .ac-icon":
    "the browser and desktop-use notes (MachineDesktopUseCard.tsx) are not on .ac-iconline yet",
  "apps/web/src/components/import-flow.css .imp-tip .ac-icon":
    "the import flow (ImportFlow.tsx) is not on .ac-iconline yet",
  "apps/web/src/components/import-flow.css .imp-note .ac-icon": "the import flow is not on .ac-iconline yet",
  "apps/web/src/components/import-flow.css .imp-todo .ac-icon": "the import flow is not on .ac-iconline yet",
  "apps/web/src/components/import-flow.css .imp-missed .ac-icon": "the import flow is not on .ac-iconline yet",
  "apps/web/src/components/import-flow.css .imp-export li .ac-icon": "the import flow is not on .ac-iconline yet",
};

describe("an icon before text sits on the text's first line", () => {
  test("no lead is nudged down by hand: rows take .ac-iconline", async () => {
    const nudged = (await allRules())
      .filter(([, selector, body]) => LEAD.test(selector) && NUDGE.test(body))
      .map(([file, selector]) => `${file} ${selector}`);
    expect(nudged.filter((rule) => !(rule in PLACED_BY_HAND))).toEqual([]);
    // A rule that no longer nudges leaves the list too.
    expect(Object.keys(PLACED_BY_HAND).filter((rule) => !nudged.includes(rule))).toEqual([]);
  });

  test(".ac-iconline centres its lead on the first line's reading middle, with a 22px fallback first", async () => {
    const rules = await allRules();
    const body = (selector: string) =>
      rules.find(([file, s]) => file === "packages/ui/src/styles/components.css" && s === selector)?.[2] ?? "";
    expect(body(".ac-iconline")).toContain("align-items: flex-start");
    const lead = body(".ac-iconline > :first-child");
    const fallback = lead.indexOf("translate: 0 calc(11px + 0.08em - 50%)");
    const lh = lead.indexOf("translate: 0 calc(0.5lh + 0.08em - 50%)");
    expect(fallback).toBeGreaterThan(-1);
    expect(lh).toBeGreaterThan(fallback);
    expect(lead).toContain("flex: none");
  });
});
