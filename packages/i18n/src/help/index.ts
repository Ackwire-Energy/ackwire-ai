/**
 * The help pages on the site (`/help/<slug>`), in pt-BR and English: each holds the background reading that a
 * screen of the app links to once, where it helps.
 */
import { type LegalInline, legalInline } from "../legal";
import { helpEn } from "./pages.en";
import { helpPtBR } from "./pages.pt-BR";
import type { HelpDocument } from "./types";

export type { HelpBlock, HelpDocument, HelpSection } from "./types";

/** Each page and the edition it speaks to (tests hold a Cloud page to the Cloud's words). */
export const HELP_PAGES = {
  "run-on-your-computer": "selfhost",
  computers: "selfhost",
  "workspace-computer": "cloud",
  import: "both",
  wiki: "both",
  memory: "both",
  approvals: "both",
  "who-answers": "both",
  jev: "selfhost",
} as const;

export type HelpSlug = keyof typeof HELP_PAGES;

export const isHelpSlug = (slug: string): slug is HelpSlug => Object.hasOwn(HELP_PAGES, slug);

/** The page in English for "en…", in Portuguese otherwise. */
export function helpDocument(slug: HelpSlug, locale: string): HelpDocument {
  return (locale.startsWith("en") ? helpEn : helpPtBR)[slug];
}

/** A piece of inline help text: plain, `**bold**`, `` `code` `` or a link. */
export type HelpInline = LegalInline | { kind: "code"; text: string };

/** Code spans, then `[text](href)` links; what's between them goes to `legalInline` (bold and bare links). */
const CODE_OR_LINK = /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

/**
 * Splits a line into text, bold, code and links. A URL inside code or a link is never linked twice, and `[[note]]`
 * (the wiki's own syntax) stays plain text.
 */
export function helpInline(line: string): HelpInline[] {
  const out: HelpInline[] = [];
  let last = 0;
  for (const m of line.matchAll(CODE_OR_LINK)) {
    const at = m.index ?? 0;
    if (at > last) out.push(...legalInline(line.slice(last, at)));
    if (m[1] !== undefined) out.push({ kind: "code", text: m[1] });
    else out.push({ kind: "link", text: m[2] ?? "", href: m[3] ?? "" });
    last = at + m[0].length;
  }
  if (last < line.length) out.push(...legalInline(line.slice(last)));
  return out;
}
