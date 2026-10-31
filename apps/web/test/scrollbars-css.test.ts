import { describe, expect, test } from "bun:test";
import path from "node:path";
import { Glob } from "bun";
import { atRule, declarations, rules, topLevel } from "./built-css";

const ROOT = path.join(import.meta.dir, "../../..");
const SOURCES = ["apps/web/src", "packages/ui/src", "apps/desktop/src"];
const KIT = "packages/ui/src/styles/components.css";
/** The only place for the standard properties: Chrome ignores the pseudo-elements on an element that sets them. */
const FIREFOX = "@supports not selector(::-webkit-scrollbar)";

const read = (file: string) => Bun.file(path.join(ROOT, file)).text();
/** Every stylesheet of the web app, the kit and the desktop app, as [path, text]. */
async function sheets() {
  const out: [string, string][] = [];
  for (const dir of SOURCES)
    for await (const file of new Glob("**/*.css").scan(path.join(ROOT, dir)))
      out.push([`${dir}/${file}`, await read(`${dir}/${file}`)]);
  return out;
}
/** The value a selector's rules end up giving a property. */
const value = (css: string, selector: string, property: string) =>
  declarations(css, selector)
    .filter(([p]) => p === property)
    .at(-1)?.[1] ?? "";
const px = (v: string) => Number.parseFloat(v);
/** `wide` matches whatever `selector` matches: the same, or its last part after a descendant or child combinator. */
const covers = (wide: string, selector: string) =>
  selector === wide || selector.endsWith(` ${wide}`) || selector.endsWith(`>${wide}`);

/** Selectors whose rules say `property: value`, across every stylesheet. */
async function selectorsWith(match: (property: string, value: string) => boolean) {
  const out: string[] = [];
  for (const [, css] of await sheets())
    for (const rule of rules(css)) if (rule.declarations.some(([p, v]) => match(p, v))) out.push(...rule.selectors);
  return out;
}

/**
 * Everything that scrolls sideways: a strip that scrolls by swipe hides its scrollbar, content read with a pointer
 * keeps the kit's. A new one goes here, one way or the other.
 */
const SIDEWAYS: Record<string, "strip" | "content"> = {
  ".agp-subnav": "strip",
  ".agp-toolbar .ac-seg": "strip",
  ".agp-tabs .ac-tabs": "strip",
  ".settings__groups": "strip",
  ".onb__steps": "strip",
  ".newag .onb__steps": "strip",
  ".newag__tips": "strip",
  ".issues-now__list": "strip",
  ".forum-fld .ac-seg": "strip",
  ".forum-seats": "strip",
  ".threads-tabs": "strip",
  ".nt-segwrap": "strip",
  ".mi-files__tabs": "strip",
  ".ac-seg": "strip",
  ".ac-composer__format": "strip",
  ".ac-toolbar__filters": "strip",
  ".ac-toolbar__filters>.ac-filterbar": "strip",
  ".ac-carousel__track": "strip",
  ".dk-orgpick": "strip",
  ".code-card__code": "content",
  ".level-matrix": "content",
  ".machine-command__code": "content",
  ".issues-boardwrap": "content",
  ".mi-log": "content",
  ".mi-cmd__line": "content",
  ".ac-msg__text pre": "content",
};

describe("our scrollbars, never the browser's", () => {
  test("the kit draws one for whatever scrolls: thin and rounded on a clear track, no arrows, in the theme's ink", async () => {
    const source = await read(KIT);
    const kit = topLevel(source);
    expect(px(value(kit, "::-webkit-scrollbar", "width"))).toBeLessThanOrEqual(10);
    expect(value(kit, "::-webkit-scrollbar", "height")).toBe(value(kit, "::-webkit-scrollbar", "width"));
    expect(value(kit, "::-webkit-scrollbar-track", "background")).toBe("transparent");
    expect(value(kit, "::-webkit-scrollbar-corner", "background")).toBe("transparent");
    expect(value(kit, "::-webkit-scrollbar-button", "display")).toBe("none");
    expect(value(kit, "::-webkit-scrollbar-thumb", "border-radius")).toBe("var(--radius-full)");
    expect(value(kit, "::-webkit-scrollbar-thumb", "background")).toStartWith("var(--scroll-thumb) ");
    expect(value(kit, "::-webkit-scrollbar-thumb:hover", "background-color")).toBe("var(--scroll-thumb-hover)");
    // Mixed from the ink on the page's root and on any subtree with its own theme; stronger under the pointer.
    const share = (token: string) => {
      const mix = value(kit, "[data-theme]", token);
      expect(value(kit, ":root", token)).toBe(mix);
      return Number(mix.match(/^color-mix\(in srgb, var\(--ink\) (\d+)%, transparent\)$/)?.[1]);
    };
    expect(share("--scroll-thumb")).toBeGreaterThan(0);
    expect(share("--scroll-thumb-hover")).toBeGreaterThan(share("--scroll-thumb"));
    expect(declarations(atRule(source, FIREFOX), "*")).toEqual([
      ["scrollbar-width", "thin"],
      ["scrollbar-color", "var(--scroll-thumb) transparent"],
    ]);
  });

  test("nothing brings the browser's back: the standard properties only for Firefox, a pseudo-element only to hide", async () => {
    const standard = (p: string, v: string) => p === "scrollbar-color" || (p === "scrollbar-width" && v !== "none");
    const stated = (css: string) =>
      rules(css).flatMap((r) =>
        r.selectors.flatMap((s) =>
          r.declarations.filter(([p, v]) => standard(p, v)).map(([p, v]) => `${s} {${p}: ${v}}`),
        ),
      );
    const found: string[] = [];
    for (const [file, css] of await sheets()) {
      const outside = stated(css);
      for (const allowed of stated(atRule(css, FIREFOX))) outside.splice(outside.indexOf(allowed), 1);
      found.push(...outside.map((d) => `${file}: ${d}`));
      for (const rule of rules(css))
        for (const s of rule.selectors.filter((s) => s.includes("::-webkit-scrollbar")))
          for (const [p, v] of rule.declarations)
            if (!(p === "display" && v === "none") && !(file === KIT && s.startsWith("::-webkit-scrollbar")))
              found.push(`${file}: ${s} {${p}: ${v}}`);
    }
    expect(found).toEqual([]);
  });

  test("a strip hides its scrollbar in every engine: `scrollbar-width: none` and `::-webkit-scrollbar` hidden", async () => {
    const hidden = (await selectorsWith((p, v) => p === "display" && v === "none"))
      .filter((s) => s.endsWith("::-webkit-scrollbar"))
      .map((s) => s.slice(0, -"::-webkit-scrollbar".length));
    const none = await selectorsWith((p, v) => p === "scrollbar-width" && v === "none");
    expect(none.filter((s) => !hidden.some((h) => covers(h, s)))).toEqual([]);
  });

  test("whatever scrolls sideways is a strip that hides its scrollbar or content that keeps ours", async () => {
    const sideways = await selectorsWith((p, v) => p === "overflow-x" && /auto|scroll/.test(v));
    expect([...new Set(sideways)].sort()).toEqual(Object.keys(SIDEWAYS).sort());
    const none = await selectorsWith((p, v) => p === "scrollbar-width" && v === "none");
    const kinds = Object.keys(SIDEWAYS).map((s) => [s, none.some((h) => covers(h, s)) ? "strip" : "content"]);
    expect(Object.fromEntries(kinds)).toEqual(SIDEWAYS);
  });
});
