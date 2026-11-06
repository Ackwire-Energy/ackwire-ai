import { describe, expect, test } from "bun:test";
import { compare, coverage, edgesOf, keyOf } from "./check";

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
});
