/**
 * Terms of Use and Privacy Policy, in pt-BR and English. The landing page
 * keeps a copy of this folder (`src/i18n/legal`); change both together.
 */
import { privacyEn } from "./privacy.en";
import { privacyPtBR } from "./privacy.pt-BR";
import { termsEn } from "./terms.en";
import { termsPtBR } from "./terms.pt-BR";
import type { LegalDocument, LegalKind } from "./types";

export type { LegalBlock, LegalDocument, LegalKind, LegalSection } from "./types";

export const legalDocuments: Record<LegalKind, Record<"pt-BR" | "en", LegalDocument>> = {
  terms: { "pt-BR": termsPtBR, en: termsEn },
  privacy: { "pt-BR": privacyPtBR, en: privacyEn },
};

export function legalDocument(kind: LegalKind, locale: string): LegalDocument {
  return legalDocuments[kind][locale === "en" ? "en" : "pt-BR"];
}

/** A piece of inline legal text: plain, `**bold**`, or a link (email or https). */
export type LegalInline = { kind: "text" | "bold"; text: string } | { kind: "link"; text: string; href: string };

const LINKS = /([\w.+-]+@[\w-]+(?:\.[\w-]+)+|https:\/\/[^\s)]+[^\s).,;])/g;

/** Splits a line into text, bold and links, for any renderer (React in the apps, HTML at build time). */
export function legalInline(line: string): LegalInline[] {
  const out: LegalInline[] = [];
  line.split("**").forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) {
      out.push({ kind: "bold", text: part });
      return;
    }
    let last = 0;
    for (const m of part.matchAll(LINKS)) {
      const at = m.index ?? 0;
      if (at > last) out.push({ kind: "text", text: part.slice(last, at) });
      const text = m[0];
      out.push({ kind: "link", text, href: text.startsWith("https://") ? text : `mailto:${text}` });
      last = at + text.length;
    }
    if (last < part.length) out.push({ kind: "text", text: part.slice(last) });
  });
  return out;
}
