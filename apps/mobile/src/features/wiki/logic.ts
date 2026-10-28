import type { WikiPageSummary } from "@agenteschat/client";
import { parseWikiToken } from "@agenteschat/client/lib/markdown";

/**
 * The wiki on the phone: the home's groups (Fixadas, Editadas recentemente, then each folder), the search and
 * a page's text with its `[[links]]` as plain words. Pure: the screens draw it.
 */

/** Pages under "Editadas recentemente" on the home. */
export const RECENT_COUNT = 5;

export interface WikiGroup {
  /** `pinned`, `recent`, or the folder's path ("" = the root). */
  key: string;
  kind: "pinned" | "recent" | "folder";
  folder: string;
  pages: WikiPageSummary[];
}

/** The home: pinned pages, the latest edits, then every folder (the root first) with its pages by title. */
export function wikiGroups(pages: WikiPageSummary[]): WikiGroup[] {
  const groups: WikiGroup[] = [];
  const pinned = pages.filter((p) => p.pinned).sort(byTitle);
  if (pinned.length > 0) groups.push({ key: "pinned", kind: "pinned", folder: "", pages: pinned });
  // With only a handful of pages the folders already show them all.
  if (pages.length > RECENT_COUNT) {
    const recent = [...pages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT_COUNT);
    groups.push({ key: "recent", kind: "recent", folder: "", pages: recent });
  }
  const folders = new Map<string, WikiPageSummary[]>();
  for (const p of pages) folders.set(p.folder, [...(folders.get(p.folder) ?? []), p]);
  const paths = [...folders.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  for (const path of paths) {
    groups.push({ key: `folder:${path}`, kind: "folder", folder: path, pages: (folders.get(path) ?? []).sort(byTitle) });
  }
  return groups;
}

const byTitle = (a: WikiPageSummary, b: WikiPageSummary) => a.title.localeCompare(b.title);

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/** Pages whose title, folder, tags or opening text have every word typed (case and accents ignored). */
export function searchWiki(pages: WikiPageSummary[], q: string): WikiPageSummary[] {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const hay = (p: WikiPageSummary) => fold([p.title, p.folder, p.tags.join(" "), p.excerpt ?? ""].join(" "));
  const titleHit = (p: WikiPageSummary) => words.every((w) => fold(p.title).includes(w));
  return pages
    .filter((p) => {
      const h = hay(p);
      return words.every((w) => h.includes(w));
    })
    .sort((a, b) => Number(titleHit(b)) - Number(titleHit(a)) || byTitle(a, b));
}

/**
 * The page's text for the chat's renderer, which has no wiki links: `[[Página|rótulo]]` becomes its label in
 * bold and an embed (`![[foto.png]]`) its name in italics; the links themselves are rows under the text.
 */
export function plainWikiText(body: string): string {
  return body
    .replace(/!\[\[([^[\]\n]+)\]\]/g, (tok) => `_${parseWikiToken(tok.slice(1)).label}_`)
    .replace(/\[\[([^[\]\n]+)\]\]/g, (tok) => `**${parseWikiToken(tok).label.replace(/#.*$/, "").trim()}**`);
}

/** A slug from a link or the route (URL keys only: letters, digits, dots, dashes and slashes). */
export const isWikiSlug = (s: unknown): s is string =>
  typeof s === "string" && s.length > 0 && s.length <= 300 && /^[\p{L}\p{N}./_-]+$/u.test(s);
