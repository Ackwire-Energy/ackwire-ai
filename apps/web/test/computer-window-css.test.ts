import { expect, test } from "bun:test";
import { join } from "node:path";
import { atMedia, builtCss, declarations, topLevel } from "./built-css";

const SRC = join(import.meta.dir, "../src");
const COMPUTER = "components/computer/computer.css";
const DESKTOP = "components/desktop/desktop.css";

/**
 * Declarations as `property:value`, spaces out, as the minifier may write them: it drops what it may, and writes a
 * `place-self` with its value twice.
 */
const squeeze = (list: (readonly [string, string])[]) =>
  list.map(([p, v]) => `${p}:${v.replace(/\s+/g, "")}`.replace(/^(place-self:)(\w+)\2$/, "$1$2"));

const builds = new Map<string, Promise<string>>();
const built = (input: string) => {
  if (!builds.has(input)) builds.set(input, builtCss(input));
  return builds.get(input) as Promise<string>;
};

/**
 * What `file` (under src) declares for `selector`, at every width or inside `media`, all of it in the build of `input`
 * too, but for what `except` names, which a test checks by its own measure. Returns what ships.
 */
async function ships(file: string, input: string, selector: string, media?: string, except: string[] = []) {
  const only = (css: string) => (media ? atMedia(css, media) : topLevel(css));
  const written = squeeze(declarations(only(await Bun.file(join(SRC, file)).text()), selector));
  const shipped = squeeze(declarations(only(await built(input)), selector));
  const kept = written.filter((d) => !except.some((p) => d.startsWith(`${p}:`)));
  expect({ selector, written: written.length > 0 }).toEqual({ selector, written: true });
  expect({ selector, shipped }).toEqual({ selector, shipped: expect.arrayContaining(kept) });
  return shipped;
}

test("the window's foot is as deep as its sides: the line steps aside over a cover and the wait, whose box is its stage", async () => {
  for (const selector of [
    ".cmp-body:has(> .dsk) > .cmp-steps-row:empty",
    '.cmp-body:has(> :is(.cmp-stage, .cmp-prep, .dsk:not([data-state="live"]))) > .cmp-steps-row',
    ".cmp-body:has(> .cmp-steps-row > .cmp-steps) > .dsk:not(.is-control) > .dsk-line",
  ]) {
    expect(await ships(COMPUTER, `src/${COMPUTER}`, selector)).toContain("display:none");
  }
  for (const selector of [
    ".cmp-body > .cmp-stage > .cmp-stage__box",
    '.cmp-body > .dsk:not([data-state="live"]) .dsk-screen',
  ]) {
    const shipped = await ships(COMPUTER, `src/${COMPUTER}`, selector);
    expect(shipped).toEqual(expect.arrayContaining(["place-self:stretch", "aspect-ratio:auto", "contain:size"]));
  }
  // The line under a live screen is as tall as the room the window keeps for it, a tablet's 40 px too.
  const line = await ships(
    DESKTOP,
    `src/${DESKTOP}`,
    ".cmp-dialog:not(.is-screen-only) .dsk-line",
    "(min-width: 721px)",
  );
  expect(line).toContain("min-height:var(--cmp-line)");
});

test("the head's controls ship on the name's capitals, full screen's bar's in its middle, the raised ones with their room", async () => {
  const head = await ships(COMPUTER, `src/${COMPUTER}`, ".cmp-dialog .ac-dialog__acts");
  expect(head).toContain("margin-top:calc((24px-var(--cmp-button))/2-var(--title-cap-mid,var(--cap-mid)))");
  const bar = await ships(COMPUTER, `src/${COMPUTER}`, ".cmp-dialog.is-screen-only .ac-dialog__acts");
  expect(bar).toContain("margin-top:calc((24px+18px-var(--cmp-button))/2)");
  expect(await ships(COMPUTER, `src/${COMPUTER}`, ".cmp-acts > :is(.cmp-take, .cmp-back)")).toContain(
    "margin-inline:1.5px",
  );
  expect(await ships(COMPUTER, `src/${COMPUTER}`, '[data-theme="dark"] .cmp-acts > .cmp-back')).toContain(
    "margin-inline:1px",
  );
});

/** `max(0px, a·cqh − b·cqw)` for a body `w` × `h` px, as written or as the minifier folds it. */
function centred(value: string, w: number, h: number) {
  const v = value.replace(/\s+/g, "");
  if (v === "max(0px,(100cqh-100cqw*900/1280)/2)") return Math.max(0, (h - (w * 900) / 1280) / 2);
  const folded = v.match(/^max\(0px,(?:calc\()?([\d.]+)cqh-([\d.]+)cqw\)?\)$/);
  return folded ? Math.max(0, (Number(folded[1]) * h - Number(folded[2]) * w) / 100) : Number.NaN;
}

test("on a phone the screen and its covers ship as one box in the sheet's middle, risen while the keyboard is up", async () => {
  const phone = "(max-width: 720px)";
  expect(await ships(COMPUTER, `src/${COMPUTER}`, ".cmp-dialog:not(.is-screen-only) > .cmp-body", phone)).toContain(
    "container-type:size",
  );
  for (const selector of [
    ".cmp-body > .cmp-stage > .cmp-stage__box",
    '.cmp-body > .dsk:not([data-state="live"]) .dsk-screen',
  ]) {
    const shipped = await ships(COMPUTER, `src/${COMPUTER}`, selector, phone);
    expect(shipped).toEqual(expect.arrayContaining(["width:100%", "aspect-ratio:1280/900", "place-self:auto"]));
  }
  // The box's top as far under the body's top as its foot is over the body's foot: 243 px on a 390 px phone.
  for (const selector of [
    ".cmp-dialog:not(.is-screen-only) .cmp-body > .cmp-stage",
    ".cmp-dialog:not(.is-screen-only) .cmp-body > .dsk > .dsk-stage",
  ]) {
    const shipped = await ships(COMPUTER, `src/${COMPUTER}`, selector, phone, ["margin-top"]);
    const margin = shipped.find((d) => d.startsWith("margin-top:"))?.slice("margin-top:".length) ?? "";
    expect(centred(margin, 358, 738)).toBeCloseTo((738 - (358 * 900) / 1280) / 2, 1);
    expect(centred(margin, 358, 200)).toBe(0);
  }
  const typing = await ships(
    COMPUTER,
    `src/${COMPUTER}`,
    ".cmp-dialog:not(.is-screen-only) .cmp-body:has(:is(.dsk-keys, .brw-ac__note):focus) > .dsk > .dsk-stage",
    "(max-width: 720px) and (pointer: coarse)",
  );
  expect(typing).toContain("margin-top:0");
});

test("the keys line's ⓘ ships with its first sentence, the keys clearly further on", async () => {
  const shipped = await ships(DESKTOP, `src/${DESKTOP}`, ".dsk-words > .ac-hintline:not(:last-child)");
  expect(shipped).toContain("margin-inline-end:8px");
});

test("the wait's bar ships as far from the right as from the left: setup's well and Settings' card", async () => {
  const well = await ships("layout.css", "src/styles.css", ".onb__wait");
  expect(well).toContain("padding:12px36px12px14px");
  const card = await ships(
    "layout.css",
    "src/styles.css",
    ".setup-card > :is(.setup-progress, .setup-eta, .setup-line)",
  );
  expect(card).toContain("margin-right:22px");
  // Both start the bar 22 px into the words' column, as the window's wait does.
  const start = await ships(
    "layout.css",
    "src/styles.css",
    ":is(.setup-wait, .setup-card) > :is(.setup-progress:not(.ac-iconline), .setup-eta)",
  );
  expect(start).toContain("margin-left:22px");
});
