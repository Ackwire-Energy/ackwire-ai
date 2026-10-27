import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../../../", import.meta.url).pathname;
const SOURCES = ["apps/web/src", "packages/ui/src", "apps/desktop/src"];

function files(dir: string, ext: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name), ext) : e.name.endsWith(ext) ? [join(dir, e.name)] : [],
  );
}

/** Every rule as [file, selector, body], comments removed; rules inside @media and @supports included. */
async function allRules() {
  const out: [string, string, string][] = [];
  for (const file of SOURCES.flatMap((d) => files(join(ROOT, d), ".css"))) {
    const css = (await Bun.file(file).text()).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g))
      for (const selector of (m[1] ?? "").split(","))
        out.push([relative(ROOT, file), selector.replace(/\s+/g, " ").trim(), m[2] ?? ""]);
  }
  return out;
}

/** A selector for a line's lead: an icon, a maker's mark, a bare svg, a row's first child, or a part named so. */
const LEAD = /(?:\.ac-icon|\.ac-brand[\w-]*|__[\w-]*(?:icon|avatar|mark|dot)|(?:^|[\s>+~])(?:svg|:first-child))$/;
const PX = String.raw`-?[1-4](?:\.\d+)?px`;
/** The hand-tuned nudges `.ac-iconline` replaces: a top margin (alone or the shorthand's first value), an offset. */
const NUDGE = new RegExp(
  String.raw`(?:^|;)\s*(?:margin(?:-top)?|top|vertical-align):\s*${PX}|(?:^|;)\s*translate:\s*0\s+${PX}|translateY\(\s*${PX}`,
);

/** A placement that adds part of an em under a line's middle: the x-height's middle, lower than where the eye centres. */
const X_HEIGHT_AIM = /(?:^|;)\s*(?:translate|top|margin(?:-top)?|vertical-align):[^;]*\+\s*[\d.]+em\b/;

/** Leads still placed by hand, and why. An entry leaves when its rule does. */
const PLACED_BY_HAND: Record<string, string> = {
  "packages/ui/src/styles/components.css .ac-menu__item .ac-icon":
    "menu items are one line (no wrapping) of 14px text on their own 20px line, which the 16px icon sits on",
  "apps/web/src/components/browser/browser.css .brw-note > .ac-icon":
    "the browser and desktop-use notes (MachineDesktopUseCard.tsx) are not on .ac-iconline yet",
  "apps/web/src/components/import-flow.css .imp-row__mark":
    "an import plan row's 18px check column centres on the row's 26px lead tile (.imp-row__lead), not on its text",
};

/** Where the opening tag that starts at `start` ends: braces are skipped, so an `=>` in an attribute doesn't end it. */
function openingEnd(src: string, start: number) {
  for (let i = start, depth = 0; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    else if (src[i] === ">" && depth === 0) return i;
  }
  return src.length;
}

/** The literal class names an opening tag gives (`className="…"`, or the strings of `className={…}`). */
function classesOf(opening: string) {
  const at = opening.indexOf("className=");
  if (at < 0) return [];
  const value = opening.slice(at + 10);
  const expr = value.startsWith('"') ? value.slice(0, value.indexOf('"', 1) + 1) : value.slice(0, openingEnd(value, 0));
  return [...expr.matchAll(/["'`]([^"'`]*)["'`]/g)].flatMap((m) =>
    (m[1] ?? "").split(/\s+/).filter((c) => /^[a-z][\w-]*$/.test(c)),
  );
}

/** Every JSX element with literal classes, in the apps' and the kit's TSX: [where, tag, classes, children's source]. */
async function elements() {
  const out: { where: string; classes: string[]; body: string }[] = [];
  for (const file of SOURCES.flatMap((d) => files(join(ROOT, d), ".tsx"))) {
    const src = await Bun.file(file).text();
    for (const m of src.matchAll(/<([A-Za-z][\w.]*)[\s>]/g)) {
      const start = m.index ?? 0;
      const end = openingEnd(src, start);
      const opening = src.slice(start, end + 1);
      const classes = classesOf(opening);
      if (classes.length === 0) continue;
      let body = "";
      if (!opening.endsWith("/>")) {
        // Its closing tag: tags of the same name nest.
        const tag = m[1] ?? "";
        const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, "g");
        re.lastIndex = end + 1;
        let depth = 1;
        for (let t = re.exec(src); t; t = re.exec(src)) {
          if (t[0].startsWith("</")) depth--;
          else if (!src.slice(t.index, openingEnd(src, t.index) + 1).endsWith("/>")) depth++;
          if (depth === 0) {
            body = src.slice(end + 1, t.index);
            break;
          }
        }
      }
      const line = src.slice(0, start).split("\n").length;
      out.push({ where: `${relative(ROOT, file)}:${line}`, classes, body });
    }
  }
  return out;
}

/** The tags of an element's own children: not their children's, nor JSX inside an attribute. */
function childTags(body: string) {
  const tags: string[] = [];
  const re = /<(\/?)([A-Za-z][\w.]*)/g;
  let depth = 0;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m[1]) {
      depth--;
      continue;
    }
    const end = openingEnd(body, m.index);
    if (depth === 0) tags.push(m[2] ?? "");
    if (!body.slice(m.index, end + 1).endsWith("/>")) depth++;
    re.lastIndex = end + 1;
  }
  return tags;
}

/** A lead that starts a line: an icon, a spinner, a maker's mark or a face. */
const LEADS_WITH = /^\s*(?:\{[^<{}]*)?<(?:Icon|Spinner|PixelSpinner|ProviderLogo|\w*Avatar)\b/;
/** A control as tall as a button. */
const CONTROL = /^\w*Button$/;

describe("an icon before text sits on the text's first line", () => {
  test("no lead is nudged by hand: rows take .ac-iconline", async () => {
    const nudged = (await allRules())
      .filter(([, selector, body]) => LEAD.test(selector) && NUDGE.test(body))
      .map(([file, selector]) => `${file} ${selector}`);
    expect(nudged.filter((rule) => !(rule in PLACED_BY_HAND))).toEqual([]);
    // A rule that no longer nudges leaves the list too.
    expect(Object.keys(PLACED_BY_HAND).filter((rule) => !nudged.includes(rule))).toEqual([]);
  });

  test("a row's class that .ac-iconline lays out carries it wherever a lead starts that row", async () => {
    const all = await elements();
    const rows = new Set(
      all
        .filter((e) => e.classes.includes("ac-iconline"))
        .flatMap((e) => e.classes)
        // Utilities (`small`, `muted`) go with any row.
        .filter((c) => c !== "ac-iconline" && /[-_]/.test(c)),
    );
    const bare = all.filter(
      (e) => !e.classes.includes("ac-iconline") && e.classes.some((c) => rows.has(c)) && LEADS_WITH.test(e.body),
    );
    expect(bare.map((e) => `${e.where} ${e.classes.join(" ")}`)).toEqual([]);
  });

  test("a row that ends with a button keeps the button out of its .ac-iconline, so the row centres them", async () => {
    const lines = (await elements()).filter(
      (e) => e.classes.includes("ac-iconline") && childTags(e.body).some((tag) => CONTROL.test(tag)),
    );
    expect(lines.map((e) => `${e.where} ${e.classes.join(" ")}`)).toEqual([]);
  });

  test("a lead and an ⓘ sit on the first line's capitals' middle (--cap-mid), a 22px-line fallback first", async () => {
    const rules = await allRules();
    const body = (selector: string) =>
      rules
        .filter(([file, s]) => file === "packages/ui/src/styles/components.css" && s === selector)
        .map(([, , b]) => b)
        .join("\n");
    const tokens = await Bun.file(join(ROOT, "packages/ui/src/styles/tokens.css")).text();
    expect(tokens).toMatch(/--cap-mid:\s*[\d.]+ex;/);
    expect(body(".ac-iconline")).toContain("align-items: flex-start");
    expect(body(".ac-iconline > :first-child")).toContain("flex: none");
    // The ⓘ's half is its 14px glyph's: its target's negative margins put the glyph's top on the line's.
    for (const [selector, half] of [
      [".ac-iconline > :first-child", "50%"],
      [".ac-hint", "7px"],
    ] as const) {
      const css = body(selector);
      const fallback = css.indexOf(`translate: 0 calc(11px - var(--cap-mid) - ${half})`);
      const lh = css.indexOf(`translate: 0 calc(0.5lh - var(--cap-mid) - ${half})`);
      expect(fallback).toBeGreaterThan(-1);
      expect(lh).toBeGreaterThan(fallback);
    }
    // A face keeps its initials' type but reads the row's line, its one row as tall as the face so a photo of any
    // shape fills it; a key centred with its title only rises.
    expect(body(".ac-iconline > .ac-avatar:first-child")).toContain("line-height: inherit");
    expect(body(".ac-iconline > .ac-avatar:first-child")).toContain("grid-template-rows: 100%");
    expect(body(".ac-card__head:not(:has(.ac-card__sub)) > .ac-card__key")).toContain("var(--cap-mid)");
  });

  // A declaration holding var() parses even where lh is unknown, so as the second of a pair it would replace the px
  // fallback there and then compute to nothing.
  test("the lh unit sits behind @supports (top: 1lh), so a browser without it keeps the px fallback", async () => {
    const bare: string[] = [];
    for (const file of SOURCES.flatMap((d) => files(join(ROOT, d), ".css"))) {
      const css = (await Bun.file(file).text())
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/@supports\s*\(\s*top:\s*1lh\s*\)\s*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
      for (const m of css.matchAll(/[^;{}]*\dlh\b[^;{}]*/g)) bare.push(`${relative(ROOT, file)}: ${m[0].trim()}`);
    }
    expect(bare).toEqual([]);
  });

  test("nothing beside text aims at the x-height's middle (part of an em under the line's middle)", async () => {
    const aimed = (await allRules())
      .filter(([, , body]) => X_HEIGHT_AIM.test(body))
      .map(([file, selector]) => `${file} ${selector}`);
    expect(aimed).toEqual([]);
  });
});
