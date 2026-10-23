/**
 * A legal page (Terms of Use, Privacy Policy) as data, so the app and the
 * landing page render the same text: the app at `/terms` and `/privacy`, the
 * landing at `/en/terms`, `/pt/termos`… (its `src/i18n/legal` is a copy of
 * this folder). Inline text may carry `**bold**`; email addresses and
 * `https://` links become links when rendered (`legalInline`).
 */
export type LegalBlock = string | { list: string[] };

export interface LegalSection {
  /** Anchor on the page (`#retention`), the same in every language. */
  id: string;
  heading: string;
  blocks: LegalBlock[];
}

export interface LegalDocument {
  title: string;
  /** One line under the title. */
  summary: string;
  /** ISO date of the last change (`2026-10-23`). */
  updated: string;
  sections: LegalSection[];
}

export type LegalKind = "terms" | "privacy";
