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
