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

describe("proposal evidence", () => {
  test("every evidence type has a label (mirror of ContextEvidence in packages/db/src/schema/context.ts)", () => {
    for (const tree of [ptBR, en]) {
      expect(Object.keys(tree.proposals.evidence).sort()).toEqual(["agent", "app", "human", "outcome", "self"]);
    }
  });
});

describe("menu paths", () => {
  test("a path to a setting stays on one line: no-break spaces around its ›", () => {
    for (const tree of [ptBR, en]) {
      const paths = leaves(tree)
        .map(([, v]) => String(v))
        .filter((s) => s.includes("›"));
      expect(paths.length).toBeGreaterThanOrEqual(4);
      for (const s of paths)
        expect({ s, alone: s.split("\u00a0›\u00a0").join("").includes("›") }).toEqual({ s, alone: false });
    }
  });
});

describe("closing words", () => {
  test("the chat's no-AI lines end on two words held together, never on one alone", () => {
    for (const tree of [ptBR, en])
      for (const s of [tree.noAi.agent, tree.noAi.signedOut, tree.noAi.banner.org, tree.noAi.card.stillMissing])
        expect({ s, together: /\u00a0\S+$/.test(s) }).toEqual({ s, together: true });
  });
});

describe("examples in one-line fields", () => {
  test("fit a 360px phone's field: one email address, a short database address", () => {
    for (const tree of [ptBR, en]) {
      for (const s of [tree.onboarding.team.placeholder, tree.members.emailsPlaceholder]) expect(s).not.toContain(",");
      // The database field holds about 38 characters of its 16px text at 360px.
      expect(tree.database.urlPlaceholder.length).toBeLessThanOrEqual(36);
    }
  });
});

describe("resources", () => {
  test("one i18next namespace per locale", () => {
    expect(Object.keys(resources)).toEqual(["pt-BR", "en"]);
    expect(resources["pt-BR"].translation).toBe(ptBR);
    expect(resources.en.translation).toBe(en);
  });
});
