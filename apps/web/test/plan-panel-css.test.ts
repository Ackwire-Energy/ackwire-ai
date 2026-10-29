import { expect, test } from "bun:test";
import { builtCss, declarations, topLevel } from "./built-css";

/** A colour's alpha as the minifier writes it (#rgba, #rrggbbaa) or as rgba(). */
const alphaOf = (color: string) => {
  const hex = /^#([0-9a-f]+)$/i.exec(color)?.[1] ?? "";
  if (hex.length === 4) return Number.parseInt(hex.slice(3).repeat(2), 16) / 255;
  if (hex.length === 8) return Number.parseInt(hex.slice(6), 16) / 255;
  const a = /rgba\(([^)]*)\)/.exec(color)?.[1]?.split(",")[3];
  return a === undefined ? 1 : Number.parseFloat(a);
};

/** A box-shadow's layers: what shapes each (inset, offsets, blur) and its colour's alpha. */
const layers = (shadow = "") =>
  shadow.split(/,(?![^(]*\))/).map((layer) => {
    const color = /(#[0-9a-f]+|rgba?\([^)]*\))/i.exec(layer)?.[1] ?? "";
    return { shape: layer.replace(color, "").trim().replace(/\s+/g, " "), alpha: alphaOf(color) };
  });

/** A hex colour's first channel (the greys here are neutral). */
const level = (hex = "") => Number.parseInt(hex.replace("#", "").slice(0, 2), 16);

test("what ships keeps dark's chosen press visible, the ready line apart from the account, the key's note on its steps' columns", async () => {
  const css = await builtCss();
  const shipped = topLevel(css);
  const last = (selector: string, property: string) =>
    declarations(shipped, selector)
      .filter(([p]) => p === property)
      .at(-1)?.[1];
  const light = '[data-theme="light"]';
  const dark = '[data-theme="dark"]';

  // Dark sinks a chosen option into a face that isn't black, between the page and a card, under light's shadow made
  // deeper: the same layers, each at least three times as dark. Light stays as it was.
  expect(level(last(dark, "--chosen-bg"))).toBeGreaterThan(level(last(dark, "--bg")));
  expect(level(last(dark, "--chosen-bg"))).toBeLessThan(level(last(dark, "--raised")));
  const darkPress = layers(last(dark, "--chosen-press"));
  const lightPress = layers(last(light, "--chosen-press"));
  expect(darkPress.map((l) => l.shape)).toEqual(lightPress.map((l) => l.shape));
  expect(darkPress.map((l, i) => l.alpha >= 3 * (lightPress[i]?.alpha ?? 1))).toEqual([true, true]);
  expect(last(light, "--chosen-bg")).toBe("var(--sunken)");
  expect(lightPress.map((l) => +l.alpha.toFixed(2))).toEqual([0.16, 0.12]);
  // Only the two theme blocks give the face: no later rule hands dark light's again.
  const giving = [...shipped.matchAll(/([^{}]+)\{[^{}]*--chosen-bg:/g)].map((m) =>
    (m[1] ?? "").replace(/\s+/g, "").replace(/"/g, ""),
  );
  expect(giving).toEqual([":root,[data-theme=light]", "[data-theme=dark]"]);

  // The computer ready, in a plan's panel: a group of its own over a hairline edge to edge. Its zero margin comes
  // after every margin a panel's note gets, @supports blocks included, so the account's words keep the group's gap.
  const ready = ".ai-panel--plan > .ai-panel__ready";
  expect(last(ready, "border-bottom")).toBe("1px solid var(--line)");
  expect(last(ready, "margin-inline")).toBe("calc(-1 * var(--card-pad))");
  expect(last(ready, "margin-bottom")).toBe("0");
  const at = (pattern: RegExp) => [...css.matchAll(pattern)].map((m) => m.index ?? -1);
  const noteMargins = at(/\.ai-panel--plan\s*>\s*\.ac-setnote\s*\{[^}]*margin/g);
  const readyRule = at(/\.ai-panel--plan\s*>\s*\.ai-panel__ready\s*\{[^}]*margin-bottom:\s*0/g);
  expect(noteMargins.length).toBeGreaterThan(0);
  expect(readyRule).toHaveLength(1);
  expect(Math.max(...noteMargins)).toBeLessThan(readyRule[0] ?? -1);
  expect(css).toMatch(/\.ai-panel--plan\s*>\s*\.ai-panel__ready\s*\{\s*padding-bottom:\s*calc\([^}]*lh\)/);

  // Under the key's steps its note keeps their columns: the icon centred in the 20px numbers', the words on the text's.
  expect(last(".ai-panel > .agp-addacct__step ~ .ac-setnote", "gap")).toBe("12px");
  expect(last(".ai-panel > .agp-addacct__step ~ .ac-setnote > :first-child", "margin-inline")).toBe("3px");
});
