import { expect, test } from "bun:test";
import { join } from "node:path";
import { atRule, builtCss, declarations, topLevel } from "./built-css";

const SRC = join(import.meta.dir, "../src");
const COMPUTER = "components/computer/computer.css";
const DESKTOP = "components/desktop/desktop.css";
const WINDOW = "@media (min-width: 721px)";
const PHONE = "@media (max-width: 720px)";

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
 * What `file` (under src) declares for `selector`, at every width or inside `block` (`@media …`, `@supports …`), all of
 * it in the build of `input` too, but for what `except` names, which a test checks by its own measure. Returns what
 * ships.
 */
async function ships(file: string, input: string, selector: string, block?: string, except: string[] = []) {
  const only = (css: string) => (block ? atRule(css, block) : topLevel(css));
  const written = squeeze(declarations(only(await Bun.file(join(SRC, file)).text()), selector));
  const shipped = squeeze(declarations(only(await built(input)), selector));
  const kept = written.filter((d) => !except.some((p) => d.startsWith(`${p}:`)));
  expect({ selector, written: written.length > 0 }).toEqual({ selector, written: true });
  expect({ selector, shipped }).toEqual({ selector, shipped: expect.arrayContaining(kept) });
  return shipped;
}

test("the window's foot is as deep as its sides: the line steps aside over the wait and a cover that stays, whose box is its stage", async () => {
  for (const selector of [
    ".cmp-body:has(> .dsk) > .cmp-steps-row:empty",
    ".cmp-body:has(> :is(.cmp-stage, .cmp-prep, .dsk.is-final)) > .cmp-steps-row",
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
  // A cover's words and a fix to run there keep to its width.
  expect(await ships(COMPUTER, `src/${COMPUTER}`, ".cmp-body .brw-dim")).toContain(
    "grid-template-columns:minmax(0,1fr)",
  );
  expect(await ships(COMPUTER, `src/${COMPUTER}`, ".cmp-body .brw-dim__box")).toContain(
    "max-width:min(420px,100%-32px)",
  );
  expect(await ships(COMPUTER, `src/${COMPUTER}`, ".cmp-body .brw-dim__box > *")).toContain("max-width:100%");
  // The line under the screen is as tall as the room the window keeps for it, a tablet's 40 px too, with its words on
  // its middle where no Keyboard button leads them, and so are the steps in its place.
  const line = await ships(DESKTOP, `src/${DESKTOP}`, ".cmp-dialog:not(.is-screen-only) .dsk-line", WINDOW);
  expect(line).toContain("min-height:var(--cmp-line)");
  const middle = "margin-top:calc((var(--cmp-line)-22px)/2)";
  const words = ".cmp-dialog:not(.is-screen-only) .dsk-line > :first-child:not(.ac-btn)";
  expect(await ships(DESKTOP, `src/${DESKTOP}`, words, WINDOW)).toContain(middle);
  const steps = ".cmp-body:has(> .dsk) > .cmp-steps-row > .cmp-steps";
  expect(await ships(COMPUTER, `src/${COMPUTER}`, steps, WINDOW)).toContain(middle);
});

test("the window ships on a whole pixel where the browser can round: its width even, the same size unrounded elsewhere", async () => {
  const frame = ".ac-dialog.cmp-dialog:where(:has(.dsk, .cmp-stage, .cmp-prep, .brw-ac.is-surface))";
  const rounded = await ships(COMPUTER, `src/${COMPUTER}`, frame, "@supports (width: round(down, 1px, 1px))");
  expect(rounded).toEqual(["--cmp-screen:round(down,min(96vw-40px,1280px,var(--cmp-room)*1280/900),2px)"]);
  expect(await ships(COMPUTER, `src/${COMPUTER}`, frame)).toContain(
    "--cmp-screen:min(96vw-40px,1280px,var(--cmp-room)*1280/900)",
  );
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
  // On a phone they stand as far under the sheet's edge as the body's sides are in (16 px): the head's top holds the
  // half of them that rises past the name's 24 px line and the capitals' lift.
  const phone = await ships(
    COMPUTER,
    `src/${COMPUTER}`,
    ".cmp-dialog:not(.is-screen-only) .ac-dialog__head",
    "@media (max-width: 640px)",
  );
  expect(phone).toContain("padding-top:calc(16px+(var(--cmp-button)-24px)/2+var(--title-cap-mid,var(--cap-mid)))");
});

/** `(a·cqh − b·cqw) / 2` for a body `w` × `h` px, as written or as the minifier folds it. */
function half(value: string, w: number, h: number) {
  const v = value.replace(/\s+/g, "");
  if (v === "calc((100cqh-100cqw*900/1280)/2)") return (h - (w * 900) / 1280) / 2;
  const folded = v.match(/^calc\(([\d.]+)cqh-([\d.]+)cqw\)$/);
  return folded ? (Number(folded[1]) * h - Number(folded[2]) * w) / 100 : Number.NaN;
}

test("on a phone the screen and its covers ship as one box, one block with what goes under it in the sheet's middle, risen while the keyboard is up", async () => {
  expect(await ships(COMPUTER, `src/${COMPUTER}`, ".cmp-dialog:not(.is-screen-only) > .cmp-body", PHONE)).toContain(
    "container-type:size",
  );
  for (const selector of [
    ".cmp-body > .cmp-stage > .cmp-stage__box",
    '.cmp-body > .dsk:not([data-state="live"]) .dsk-screen',
  ]) {
    const shipped = await ships(COMPUTER, `src/${COMPUTER}`, selector, PHONE);
    expect(shipped).toEqual(expect.arrayContaining(["width:100%", "aspect-ratio:1280/900", "place-self:auto"]));
  }
  // A cover shares the box's cell: words taller than the box grow it instead of spilling over the head.
  for (const selector of [
    ".cmp-body > .cmp-stage > :is(.cmp-stage__box, .brw-dim)",
    ".cmp-body > .dsk > .dsk-stage > :is(.dsk-screen, .brw-dim)",
  ]) {
    expect(await ships(COMPUTER, `src/${COMPUTER}`, selector, PHONE)).toContain("grid-area:1/1");
  }
  for (const selector of [".cmp-body > .cmp-stage", ".cmp-body > .dsk > .dsk-stage"]) {
    expect(await ships(COMPUTER, `src/${COMPUTER}`, selector, PHONE, ["flex", "container-type"])).toContain(
      "grid-template-columns:minmax(0,1fr)",
    );
  }
  for (const selector of [".cmp-body > .cmp-stage > .brw-dim", ".cmp-body > .dsk > .dsk-stage > .brw-dim"]) {
    const shipped = await ships(COMPUTER, `src/${COMPUTER}`, selector, PHONE);
    expect(shipped).toEqual(expect.arrayContaining(["position:relative", "place-self:stretch"]));
  }
  // Over the box and under what goes under it (its line, the steps, a banner, after which it comes), the same room that
  // gives, so they sit in the middle as one block, rising where they wouldn't fit. The room over never passes half of
  // what the box alone leaves (243 px on a 390 × 844 phone's body, none where the box fills it), the bound the
  // keyboard's none glides from. Neither adds a gap of its own.
  const under = await ships(
    COMPUTER,
    `src/${COMPUTER}`,
    ".cmp-dialog:not(.is-screen-only) > .cmp-body:has(> :is(.dsk, .cmp-stage))::after",
    PHONE,
  );
  expect(under).toEqual(expect.arrayContaining(['content:""', "order:1", "flex:110", "margin-top:-8px"]));
  expect(
    await ships(COMPUTER, `src/${COMPUTER}`, ".cmp-dialog:not(.is-screen-only) .cmp-body > .cmp-banner", PHONE),
  ).toContain("order:1");
  // Ended by a line of words, the room under the block starts at their ink, about 4 px over the line's foot; a banner
  // or the hand-back note ends it at its own edge.
  const inked = await ships(
    COMPUTER,
    `src/${COMPUTER}`,
    ".cmp-dialog:not(.is-screen-only) > .cmp-body:has(.dsk-line):not(:has(> .cmp-banner, .brw-ac__foot))::after",
    PHONE,
  );
  expect(inked).toEqual(["margin-top:-12px"]);
  const over = await ships(
    COMPUTER,
    `src/${COMPUTER}`,
    ".cmp-dialog:not(.is-screen-only) > .cmp-body:has(> :is(.dsk, .cmp-stage))::before",
    PHONE,
    ["max-height"],
  );
  expect(over).toEqual(expect.arrayContaining(['content:""', "flex:110", "margin-bottom:-8px"]));
  const most = over.find((d) => d.startsWith("max-height:"))?.slice("max-height:".length) ?? "";
  expect(half(most, 358, 738)).toBeCloseTo((738 - (358 * 900) / 1280) / 2, 1);
  expect(half(most, 358, 200)).toBeLessThan(0);
  // The phone's keyboard up: none, the box at the sheet's top; it glides there unless less motion is asked.
  const typing = await ships(
    COMPUTER,
    `src/${COMPUTER}`,
    ".cmp-dialog:not(.is-screen-only) > .cmp-body:has(:is(.dsk-keys, .brw-ac__note):focus)::before",
    "@media (max-width: 720px) and (pointer: coarse)",
  );
  expect(typing).toContain("max-height:0");
  const glide = await ships(
    COMPUTER,
    `src/${COMPUTER}`,
    ".cmp-body::before",
    "@media (max-width: 720px) and (prefers-reduced-motion: no-preference)",
    ["transition"],
  );
  expect(glide.some((d) => d.startsWith("transition:max-height"))).toBe(true);
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

test("the window's wait with no bar to set its column ships each line in the middle, its icon on its first words' capitals", async () => {
  const none = ".cmp-prep .setup-wait:not(:has(.ac-steps))";
  const wait = await ships(COMPUTER, `src/${COMPUTER}`, none);
  expect(wait).toEqual(expect.arrayContaining(["text-align:center", "padding-inline-end:0"]));
  // The icon flows with the words, so it leads the first line wherever that line starts once centred.
  expect(await ships(COMPUTER, `src/${COMPUTER}`, `${none} > .ac-iconline`)).toContain("display:block");
  const lead = await ships(COMPUTER, `src/${COMPUTER}`, `${none} > .ac-iconline > :first-child`);
  expect(lead).toEqual(
    expect.arrayContaining([
      "margin-inline-end:8px",
      "translate:none",
      "vertical-align:calc(var(--cap-top)-var(--cap-mid)-7px)",
    ]),
  );
  // The time left leads with nothing: no column to start in.
  expect(await ships(COMPUTER, `src/${COMPUTER}`, `${none} > .setup-eta`)).toContain("margin-left:0");
});
