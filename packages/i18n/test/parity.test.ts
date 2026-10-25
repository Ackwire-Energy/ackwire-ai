import { describe, expect, test } from "bun:test";
import { en, ptBR, resources } from "../src/index";
import { leaves } from "./leaves";

/** Plural forms differ by language ("_one"/"_other" vs others): compare the base key. */
const base = (k: string) => k.replace(/_(zero|one|two|few|many|other)$/, "");

describe("locales", () => {
  test("pt-BR and en have the same keys, and no empty values", () => {
    const pt = leaves(ptBR);
    const enLeaves = leaves(en);
    const ptKeys = new Set(pt.map(([k]) => base(k)));
    const enKeys = new Set(enLeaves.map(([k]) => base(k)));
    expect([...ptKeys].filter((k) => !enKeys.has(k))).toEqual([]);
    expect([...enKeys].filter((k) => !ptKeys.has(k))).toEqual([]);
    // Empty on purpose: English has no gendered articles; the custom role starts with no instructions.
    const EMPTY_OK = [/^grammar\./, /^newAgent\.roles\.custom\.instructions$/];
    const empty = [...pt, ...enLeaves]
      .filter(([k, v]) => typeof v !== "string" || (v.trim() === "" && !EMPTY_OK.some((re) => re.test(k))))
      .map(([k]) => k);
    expect(empty).toEqual([]);
  });
});

describe("resources", () => {
  test("one i18next namespace per locale", () => {
    expect(Object.keys(resources)).toEqual(["pt-BR", "en"]);
    expect(resources["pt-BR"].translation).toBe(ptBR);
    expect(resources.en.translation).toBe(en);
  });
});
