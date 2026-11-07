import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare, coverage, edgesOf, keyOf, playwrightChromes, SELF_TESTED } from "./check";

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

  test("every rule the run checks has an offender and a sound twin in the fixture, the docked panes, cards' sides, icon gaps and square icon buttons too", () => {
    const fixture = readFileSync(join(import.meta.dir, "fixture.html"), "utf8");
    const rules = readFileSync(join(import.meta.dir, "rules.js"), "utf8");
    for (const rule of ["docked", "inset", "icongap", "square"]) expect(SELF_TESTED).toContain(rule);
    for (const rule of SELF_TESTED) {
      expect(fixture).toContain(`bad-${rule}`);
      expect(fixture).toContain(`good-${rule}`);
      expect(rules).toContain(`rule: "${rule}"`);
    }
  });
});
