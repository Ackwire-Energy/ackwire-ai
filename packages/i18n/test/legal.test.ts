import { describe, expect, test } from "bun:test";
import { en, ptBR } from "../src/index";
import { type LegalKind, legalDocument, legalDocuments, legalInline } from "../src/legal";
import { leaves } from "./leaves";

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

describe("the privacy policy says where Workspace Content passes through our network provider", () => {
  // agentes.chat Cloud is behind a network provider that decrypts its traffic at the data center nearest to each device:
  // the list of where Workspace Content leaves our servers ("and only in them") and the countries of §9 must say so.
  // Product decision: the legal pages name no infrastructure provider (network, hosting), in any language.
  test("en", () => {
    const section = (id: string) => JSON.stringify(legalDocuments.privacy.en.sections.find((s) => s.id === id)?.blocks);
    expect(section("agents")).toContain("our network provider");
    expect(section("transfers")).toContain("our network provider");
  });
});

describe("the privacy policy covers every model provider a workspace may choose, without naming one", () => {
  // §9's US claim covers only the providers the policy names, so a provider a workspace picks (and the model's maker
  // or host it passes calls on to) falls under the §9 exception, and a new provider in the product needs no edit here.
  const section = (locale: "en" | "pt-BR", id: string) =>
    JSON.stringify(legalDocuments.privacy[locale].sections.find((s) => s.id === id)?.blocks);
  test("en", () => {
    expect(section("en", "agents")).toContain("Some providers pass the call on to the company that makes or hosts");
    expect(section("en", "transfers")).toContain(
      "except the model providers and connected services a workspace chooses, and the companies they pass calls on to",
    );
  });
  test("pt-BR", () => {
    expect(section("pt-BR", "agents")).toContain("Alguns provedores repassam a chamada à empresa que faz ou hospeda");
    expect(section("pt-BR", "transfers")).toContain(
      "exceto os provedores de modelo e os serviços conectados que um workspace escolhe",
    );
  });
  test("no language names a provider a workspace picks", () => {
    for (const [code, doc] of Object.entries(legalDocuments.privacy))
      expect({
        code,
        named: JSON.stringify(doc).match(/\b(?:OpenRouter|Command Code|DeepSeek|Kimi|MiniMax|Z\.ai)\b/g),
      }).toEqual({
        code,
        named: null,
      });
  });
});

describe("agentes.chat Cloud's restriction lines cite the Terms this server serves", () => {
  // The section each line rests on, by its id: when the Terms are renumbered, this fails until the lines follow.
  const RESTS_ON = {
    review: "acceptable-use",
    reviewFor: "acceptable-use",
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
        const number = typeof line === "string" ? line.match(/(?:section|seção) (\d+)/)?.[1] : undefined;
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

describe("legal pages in every language", () => {
  for (const [kind, byLocale] of Object.entries(legalDocuments)) {
    test(`${kind}: each translation has English's sections and date, and says English prevails`, () => {
      const english = byLocale.en;
      for (const [code, doc] of Object.entries(byLocale)) {
        if (!doc) continue;
        expect({ code, ids: doc.sections.map((s) => s.id) }).toEqual({ code, ids: english.sections.map((s) => s.id) });
        expect({ code, updated: doc.updated }).toEqual({ code, updated: english.updated });
        // pt-BR predates the notice (open question for the owner); every newer translation carries it.
        if (code !== "en" && code !== "pt-BR")
          expect({ code, courtesy: !!doc.courtesy?.trim() }).toEqual({ code, courtesy: true });
      }
      expect(legalDocument(kind as LegalKind, "ja")).toBe(byLocale.ja ?? english);
    });
  }
});

// Semicolons only, not plain-marks' em dash: Russian legal style writes "далее — «Условия»". The landing's copy test
// runs the same check on its copy of these pages.
test("legal pages in every language: no semicolon", () => {
  const found = leaves(legalDocuments).filter(([, text]) => typeof text === "string" && /[;；]/.test(text));
  expect(found).toEqual([]);
});
