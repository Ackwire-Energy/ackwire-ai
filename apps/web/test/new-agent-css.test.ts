import { expect, test } from "bun:test";
import { join } from "node:path";
import { atRule, declarations, rules, topLevel } from "./built-css";

const sheet = (file: string) => Bun.file(join(import.meta.dir, "../src", file)).text();

test("a role card's padding is one length all round: as much above the face as under its last line", async () => {
  const layout = await sheet("layout.css");
  const padding = declarations(topLevel(layout), ".newag__role").filter(([p]) => p.startsWith("padding"));
  expect(padding.map(([p]) => p)).toEqual(["padding"]);
  expect(padding[0]?.[1]).toMatch(/^\d+px$/);
  // Its face row is a bare `.ac-faceline` (new-agent.test.tsx), and no rule that reaches it through the card gives it
  // room, at any width.
  const room = rules(`${layout}\n${await sheet("pages/new-agent.css")}`)
    .filter((r) =>
      r.declarations.some(([p]) => /^(padding|margin)(-top|-block(-start)?)?$|^min-(height|block-size)$/.test(p)),
    )
    .flatMap((r) => r.selectors.filter((s) => s.includes(".newag__role") && /\.ac-faceline[^ >+~]*$/.test(s)));
  expect(room).toEqual([]);
});

test("on a narrow screen, where the preview sits above the form, it waits for the step after the role's", async () => {
  const narrow = atRule(await sheet("pages/new-agent.css"), "@media (max-width: 1100px)");
  expect(declarations(narrow, '.newag__aside[data-step="role"]')).toEqual([["display", "none"]]);
});

test("the new agent's list rows are face lines: no rule centres a face against its two lines (ADR 0164)", async () => {
  const card = await sheet("components/new-agent/new-agent-card.css");
  const centred = rules(card).filter(
    (r) => r.selectors.some((s) => s.includes(".nac__item")) && r.declarations.some(([p]) => p === "align-items"),
  );
  expect(centred).toEqual([]);
});

test("the card's list and body fade at an edge only while there is more to scroll that way (ADR 0164)", async () => {
  const card = topLevel(await sheet("components/new-agent/new-agent-card.css"));
  for (const box of [".nac__list", ".nac__body"]) {
    const own = declarations(card, box);
    // No fade until the flags say so, and the scrollbar's strip stays clear.
    expect(own).toContainEqual(["--nac-fade-top", "0px"]);
    expect(own).toContainEqual(["--nac-fade-bottom", "0px"]);
    expect(own.find(([p]) => p === "mask-image")?.[1]).toContain("var(--scroll-strip)");
  }
  expect(declarations(card, ':is(.nac__list, .nac__body)[data-fade-top="true"]')).toEqual([["--nac-fade-top", "20px"]]);
  expect(declarations(card, ':is(.nac__list, .nac__body)[data-fade-bottom="true"]')).toEqual([
    ["--nac-fade-bottom", "28px"],
  ]);
});
