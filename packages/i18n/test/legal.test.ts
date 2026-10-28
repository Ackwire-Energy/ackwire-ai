import { describe, expect, test } from "bun:test";
import { en, ptBR } from "../src/index";
import { legalDocuments, legalInline } from "../src/legal";

describe("legal pages", () => {
  for (const [kind, byLocale] of Object.entries(legalDocuments)) {
    test(`${kind}: pt-BR and en have the same sections, date and shape`, () => {
      const pt = byLocale["pt-BR"];
      const en = byLocale.en;
      expect(pt.updated).toBe(en.updated);
      expect(pt.sections.map((s) => s.id)).toEqual(en.sections.map((s) => s.id));
      pt.sections.forEach((s, i) => {
        const shape = (b: unknown) => (typeof b === "string" ? "p" : `list:${(b as { list: string[] }).list.length}`);
        expect(s.blocks.map(shape)).toEqual(en.sections[i]?.blocks.map(shape) ?? []);
      });
      expect(new Set(pt.sections.map((s) => s.id)).size).toBe(pt.sections.length);
    });
  }
});

describe("agentes.chat Cloud's restriction lines cite the Terms this server serves", () => {
  // The section each line rests on, by its id: when the Terms are renumbered, this fails until the lines follow.
  const RESTS_ON = {
    review: "acceptable-use",
    blockedAbuse: "acceptable-use",
    agentNetwork: "acceptable-use",
    agentOperator: "acceptable-use",
  };
  for (const [locale, lines] of [
    ["en", en.standing.cloud],
    ["pt-BR", ptBR.standing.cloud],
  ] as const) {
    test(locale, () => {
      const { sections } = legalDocuments.terms[locale];
      const cited = Object.entries(lines).flatMap(([key, line]) => {
        const number = line.match(/(?:section|seção) (\d+)/)?.[1];
        return number ? [[key, number]] : [];
      });
      const served = Object.entries(RESTS_ON).map(([key, id]) => [
        key,
        sections.find((s) => s.id === id)?.heading.match(/^(\d+)\./)?.[1],
      ]);
      expect(Object.fromEntries(cited)).toEqual(Object.fromEntries(served));
    });
  }
});

describe("legalInline", () => {
  test("bold, emails and links", () => {
    expect(legalInline("**Railway:** hosting. Write to privacy@agentes.chat, or see https://agentes.chat/en.")).toEqual(
      [
        { kind: "bold", text: "Railway:" },
        { kind: "text", text: " hosting. Write to " },
        { kind: "link", text: "privacy@agentes.chat", href: "mailto:privacy@agentes.chat" },
        { kind: "text", text: ", or see " },
        { kind: "link", text: "https://agentes.chat/en", href: "https://agentes.chat/en" },
        { kind: "text", text: "." },
      ],
    );
  });
});
