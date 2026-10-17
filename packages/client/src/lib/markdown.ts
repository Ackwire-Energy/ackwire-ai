/**
 * The parsing half of a small, safe Markdown renderer for chat messages and
 * artifact documents: headings, paragraphs, lists, quotes, rules, GFM tables,
 * fenced code, inline code, bold, italic, ~~strikethrough~~, links and bare
 * URLs. Each platform renders the blocks with its own elements (the web:
 * `apps/web/src/lib/markdown.tsx`); raw HTML is never interpreted. Links
 * allow http(s) and mailto (`SAFE_URL`); @mentions follow `MENTION`.
 */
export type MdBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; lang: string; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string; lines: string[] }
  | { type: "embed"; target: string }
  | { type: "rule" }
  | { type: "table"; header: string[]; rows: string[][] };

const LIST = /^\s*([-*+]|\d+[.)])\s+(.*)$/;
const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

export function parseMarkdown(source: string, options: { breaks?: boolean } = {}): MdBlock[] {
  const join = options.breaks ? "\n" : " ";
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] as string)) body.push(lines[i++] as string);
      i++;
      out.push({ type: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      out.push({ type: "heading", level: (heading[1] as string).length, text: heading[2] ?? "" });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ type: "rule" });
      i++;
      continue;
    }
    const next = lines[i + 1] ?? "";
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(next)) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] as string).includes("|") && (lines[i] as string).trim()) {
        rows.push(splitRow(lines[i++] as string));
      }
      out.push({ type: "table", header, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] as string))
        body.push((lines[i++] as string).replace(/^\s*>\s?/, ""));
      out.push({ type: "quote", text: body.join(join), lines: body });
      continue;
    }
    // `![[foto.png]]` alone on its line: an Obsidian embed (an attachment or another note).
    const embed = line.match(/^\s*!\[\[([^[\]\n|]+)(?:\|[^\]\n]*)?\]\]\s*$/);
    if (embed) {
      out.push({ type: "embed", target: (embed[1] ?? "").trim() });
      i++;
      continue;
    }
    const item = line.match(LIST);
    if (item) {
      const ordered = /\d/.test(item[1] as string);
      const items: string[] = [];
      while (i < lines.length) {
        const m = (lines[i] as string).match(LIST);
        if (m && /\d/.test(m[1] as string) === ordered) {
          items.push(m[2] ?? "");
          i++;
        } else if (items.length && /^\s{2,}\S/.test(lines[i] as string)) {
          items[items.length - 1] += `${join}${(lines[i++] as string).trim()}`;
        } else break;
      }
      out.push({ type: "list", ordered, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i] as string;
      if (!l.trim() || /^(#{1,6})\s|^\s*```|^\s*>/.test(l) || LIST.test(l)) break;
      para.push(l.trim());
      i++;
    }
    out.push({ type: "paragraph", text: para.join(join) });
  }
  return out;
}

// Code, bold, italic (not inside words, so `snake_case` and URLs stay as typed), links, bare URLs,
// wiki links, ~~strikethrough~~.
export const INLINE =
  /(`[^`]+`)|(\*\*[^*]+?\*\*|__[^_]+?__)|((?<![\w*])\*[^*\s][^*]*?\*(?![\w*])|(?<![\w_])_[^_\s][^_]*?_(?![\w_]))|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])|(\[\[[^[\]\n]+\]\])|(~~[^~\s](?:[^~]*?[^~\s])?~~)/;
export const SAFE_URL = /^(https?:|mailto:)/i;
/** Same rule as the backend (`parseMentionHandles`): emails are not mentions. */
export const MENTION = /(^|[^\w@.])@([a-zA-Z0-9][a-zA-Z0-9_-]{1,31})(?![\w@-])/g;

/** `[[Processos/Onboarding|o onboarding]]` → { title: "Processos/Onboarding", label: "o onboarding" }. */
export function parseWikiToken(token: string) {
  const inner = token.slice(2, -2);
  const bar = inner.indexOf("|");
  const title = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
  const label = (bar >= 0 ? inner.slice(bar + 1) : inner).trim() || title;
  return { title, label };
}

/** Every `[[link]]` title in a text, in order, without repeats. */
export function wikiLinksIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<!!)\[\[([^[\]\n]+)\]\]/g)) {
    const { title } = parseWikiToken(m[0]);
    if (title && !out.includes(title)) out.push(title);
  }
  return out;
}

/** Heading anchor ids for the outline: "Como pedimos acesso" → "como-pedimos-acesso". */
export const headingId = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
