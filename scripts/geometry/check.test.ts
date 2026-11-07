import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleCss, compare, coverage, cssSheets, edgesOf, keyOf, playwrightChromes, SELF_TESTED } from "./check";

describe("geometry check", () => {
  test("a new offender is new at its width, and words or size never make one", () => {
    const f = { rule: "edge", el: "a.ac-btn", box: "li.home-row", px: 1, text: "Abrir" };
    expect(keyOf(f, 320)).toBe("edge@320 a.ac-btn in li.home-row");
    expect(keyOf({ ...f, px: 5, text: "Responder" }, 320)).toBe(keyOf(f, 320));
    expect(keyOf(f, 1280)).not.toBe(keyOf(f, 320));
  });

  test("a finding named only by the kit's classes is keyed by its place too, so one entry can't excuse every screen", () => {
    const f = { rule: "edge", el: "button.ac-btn.ac-btn--sm", box: "section.ac-card", px: -93 };
    expect(keyOf({ ...f, at: "div.ai-panel" }, 320)).toBe(
      "edge@320 button.ac-btn.ac-btn--sm in section.ac-card at div.ai-panel",
    );
    expect(keyOf({ ...f, at: "div.home-row" }, 320)).not.toBe(keyOf({ ...f, at: "div.ai-panel" }, 320));
  });

  test("only what the baseline doesn't know fails; what got fixed is listed", () => {
    expect(compare(["a", "b", "b"], ["b", "c"])).toEqual({ fresh: ["a"], gone: ["c"] });
  });

  test("with no Chrome installed, Playwright's newest Chromium will do", () => {
    const home = mkdtempSync(join(tmpdir(), "geometry-home-"));
    for (const v of ["1200", "1248"]) {
      const dir = join(home, ".cache/ms-playwright", `chromium-${v}`, "chrome-linux");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "chrome"), "#!/bin/sh\n");
    }
    const was = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(playwrightChromes()[0]).toBe(join(home, ".cache/ms-playwright/chromium-1248/chrome-linux/chrome"));
    } finally {
      process.env.HOME = was;
    }
  });

  test("a pair is a parent and a child with their classes, void tags closing themselves", () => {
    const edges = edgesOf('<ul class="list"><li><input class="x"><b>a</b></li></ul>');
    expect([...edges]).toEqual(["root>ul.list", "ul.list>li.", "li.>input.x", "li.>b."]);
  });

  test("a screen that adds no new pair isn't laid out again, whatever order they came in", () => {
    const html: Record<string, string> = {
      a: '<div class="a"><span class="c"></span></div>',
      b: '<div class="a"><span class="c"></span></div><div class="a"></div>',
      c: '<div class="a"><em></em></div>',
    };
    expect(coverage(["c", "b", "a"], (name) => html[name] as string)).toEqual(["a", "c"]);
  });

  test("every rule the run checks has an offender and a sound twin in the fixture, the floating panes, cards' sides, icon gaps and square icon buttons too", () => {
    const fixture = readFileSync(join(import.meta.dir, "fixture.html"), "utf8");
    const rules = readFileSync(join(import.meta.dir, "rules.js"), "utf8");
    const check = readFileSync(join(import.meta.dir, "check.ts"), "utf8");
    for (const rule of ["floating", "inset", "icongap", "square"]) expect(SELF_TESTED).toContain(rule);
    for (const rule of ["squarecol", "rim", "inlinebase", "iconmid", "fieldwidth", "corner", "clip", "cascadeorder"])
      expect(SELF_TESTED).toContain(rule);
    for (const rule of SELF_TESTED) {
      expect(fixture).toContain(`bad-${rule}`);
      expect(fixture).toContain(`good-${rule}`);
      expect(`${rules}${check}`).toContain(`rule: "${rule}"`);
    }
  });

  test("the reverse CSS order holds the same sheets: the page sheets backwards, then the app's entry last", () => {
    const app = cssSheets("app");
    const reverse = cssSheets("reverse");
    expect(app[0]).toBe("src/styles.css");
    expect(reverse.at(-1)).toBe("src/styles.css");
    expect([...reverse].sort()).toEqual([...app].sort());
    expect(reverse.slice(0, -1)).toEqual(app.slice(1).reverse());
    expect(app.length).toBeGreaterThan(10);
  });

  test("cascadeorder's twin sheets: a tie that flips with the order, and a layered rule that loses either way", () => {
    const a = readFileSync(join(import.meta.dir, "fixture-a.css"), "utf8");
    const b = readFileSync(join(import.meta.dir, "fixture-b.css"), "utf8");
    expect(a).toMatch(/\.bad-cascadeorder \{\s*padding-left: 4px;/);
    expect(a).toMatch(/@layer base \{\s*\.good-cascadeorder \{\s*padding-left: 4px;/);
    expect(b).toMatch(/\.bad-cascadeorder \{\s*padding-left: 8px;/);
    expect(b).toMatch(/\.good-cascadeorder \{\s*padding-left: 8px;/);
  });

  test("the check's CSS keeps the kit and the app's base sheets in their layer, as the build does", async () => {
    const out = mkdtempSync(join(tmpdir(), "geometry-css-"));
    const css = readFileSync(join(out, await bundleCss(out)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const blocks: [string, number, number][] = [];
    for (const m of css.matchAll(/@layer\s+([\w-]+)\s*\{/g)) {
      let depth = 0;
      let end = m.index + m[0].length - 1;
      for (; end < css.length; end++) {
        if (css[end] === "{") depth++;
        else if (css[end] === "}" && --depth === 0) break;
      }
      blocks.push([m[1] as string, m.index, end]);
    }
    const layerOf = (selector: RegExp) => {
      const at = css.search(selector);
      expect(at).toBeGreaterThanOrEqual(0);
      return blocks.find(([, start, end]) => at > start && at < end)?.[0];
    };
    expect(layerOf(/\n\s*\.ac-card\s*\{/)).toBe("base");
    expect(layerOf(/\n\s*\.page-title\s*\{/)).toBe("base");
    expect(layerOf(/\n\s*\.roles-list\s*\{/)).toBeUndefined();
  });
});
