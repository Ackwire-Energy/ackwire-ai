import { expect, test } from "bun:test";
import { helpEn } from "../src/help/pages.en";
import { helpPtBR } from "../src/help/pages.pt-BR";
import { en, ptBR } from "../src/index";
import { unplainLeaves } from "./plain-marks";

test("the app's words and the help pages: no semicolon, no em dash", () => {
  expect([en, ptBR, helpEn, helpPtBR].flatMap((tree) => unplainLeaves(tree))).toEqual([]);
});

test("code keeps its marks, words don't", () => {
  const tree = { a: "Two; one", b: "Run `cd x; ls`", c: "Ana &amp; Bia", d: { code: "cd x; ls" }, e: "A — B" };
  expect(unplainLeaves(tree)).toEqual(["a: Two; one", "e: A — B"]);
});
