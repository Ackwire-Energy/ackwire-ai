import { expect, test } from "bun:test";
import { join } from "node:path";
import { atRule, declarations, topLevel } from "./built-css";

const sheet = (file: string) => Bun.file(join(import.meta.dir, "../src", file)).text();

test("a role card's padding is one length all round: as much above the face as under its last line", async () => {
  const padding = declarations(topLevel(await sheet("layout.css")), ".newag__role").filter(([p]) =>
    p.startsWith("padding"),
  );
  expect(padding.map(([p]) => p)).toEqual(["padding"]);
  expect(padding[0]?.[1]).toMatch(/^\d+px$/);
});

test("on a narrow screen, where the preview sits above the form, it waits for the step after the role's", async () => {
  const narrow = atRule(await sheet("pages/new-agent.css"), "@media (max-width: 1100px)");
  expect(declarations(narrow, '.newag__aside[data-step="role"]')).toEqual([["display", "none"]]);
});
