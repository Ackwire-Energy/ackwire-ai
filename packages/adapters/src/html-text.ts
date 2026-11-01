/**
 * Outside HTML and text made safe to read (ADR 0117): one HTML-to-text converter for web pages, mail and
 * search results, which drops what a person never sees on the page (so hidden text can't speak to the
 * model), and one cleaner for any outside text, which strips invisible characters and folds look-alike
 * forms (full-width brackets) into plain ones before envelope markers are checked.
 */

/** Zero-width, bidi, word-joiner, BOM, soft hyphen and Unicode tag characters: invisible on screen. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD]|[\u{E0000}-\u{E007F}]/gu;

/** Outside text without invisible characters, NFKC-folded (full-width `＜` becomes `<`). */
export function cleanOutside(text: string): string {
  return text.replace(INVISIBLE, "").normalize("NFKC");
}

/** Whether the text carries invisible characters `cleanOutside` would strip. */
export const hasInvisible = (text: string) => text.search(INVISIBLE) !== -1;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  deg: "°",
  times: "×",
  divide: "÷",
  iexcl: "¡",
  iquest: "¿",
  aacute: "á",
  Aacute: "Á",
  agrave: "à",
  Agrave: "À",
  acirc: "â",
  Acirc: "Â",
  atilde: "ã",
  Atilde: "Ã",
  auml: "ä",
  ccedil: "ç",
  Ccedil: "Ç",
  eacute: "é",
  Eacute: "É",
  egrave: "è",
  ecirc: "ê",
  Ecirc: "Ê",
  euml: "ë",
  iacute: "í",
  Iacute: "Í",
  icirc: "î",
  oacute: "ó",
  Oacute: "Ó",
  ocirc: "ô",
  Ocirc: "Ô",
  otilde: "õ",
  Otilde: "Õ",
  ouml: "ö",
  uacute: "ú",
  Uacute: "Ú",
  ucirc: "û",
  uuml: "ü",
  ntilde: "ñ",
  Ntilde: "Ñ",
  szlig: "ß",
  zwnj: "",
  zwj: "",
  shy: "",
};

/** Decodes HTML entities (named, decimal and hex). Unknown names stay as they are. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code =
        entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const BLOCK_TAGS =
  "address|article|aside|blockquote|center|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|main|nav|ol|p|pre|section|table|tbody|thead|tfoot|tr|ul";

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const ATTR = /([^\s=/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const TAG = /<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;

function attributes(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(ATTR)) {
    const name = (m[1] ?? "").toLowerCase();
    if (name && !out.has(name)) out.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return out;
}

const isZero = (v: string) => /^[+-]?0*(\.0*)?[a-z%]*$/.test(v) && /0/.test(v) && !/[1-9]/.test(v);

/** Whether an inline style hides the element from a person looking at the page. */
function styleHides(style: string): boolean {
  const decl = new Map<string, string>();
  for (const part of style.toLowerCase().split(";")) {
    const i = part.indexOf(":");
    if (i > 0)
      decl.set(
        part.slice(0, i).trim(),
        part
          .slice(i + 1)
          .replace(/!important/g, "")
          .replace(/\s+/g, ""),
      );
  }
  const get = (k: string) => decl.get(k) ?? "";
  if (get("display") === "none" || get("visibility") === "hidden") return true;
  if (decl.has("opacity") && isZero(get("opacity"))) return true;
  if (decl.has("font-size") && isZero(get("font-size"))) return true;
  const color = get("color");
  if (color && (color === get("background-color") || color === get("background"))) return true;
  if (/^(absolute|fixed)$/.test(get("position"))) {
    const far = (v: string) => /^-\d+(\.\d+)?px$/.test(v) && Number.parseFloat(v) <= -1000;
    if (far(get("left")) || far(get("top"))) return true;
  }
  return false;
}

function hiddenElement(name: string, raw: string): boolean {
  if (name === "template") return true;
  const attrs = attributes(raw);
  if (attrs.has("hidden") || attrs.get("aria-hidden")?.toLowerCase() === "true") return true;
  const style = attrs.get("style");
  return style ? styleHides(style) : false;
}

/**
 * Drops every element a person can't see (template, `hidden`, `aria-hidden="true"`, inline styles that hide
 * it or move it off screen) with its whole subtree. A stack walk, so nested elements of the same name close
 * where the browser would close them. ponytail: inline styles only, colors compared as written; a class
 * hidden by a stylesheet still shows, which needs a CSS engine.
 */
export function dropHidden(html: string): string {
  let out = "";
  let last = 0;
  let skip: { name: string; depth: number } | null = null;
  for (const m of html.matchAll(TAG)) {
    const closing = m[1] === "/";
    const name = (m[2] ?? "").toLowerCase();
    const raw = m[3] ?? "";
    const end = (m.index ?? 0) + m[0].length;
    const selfClosing = VOID_TAGS.has(name) || raw.trimEnd().endsWith("/");
    if (skip) {
      if (name !== skip.name) continue;
      if (closing) skip.depth--;
      else if (!selfClosing) skip.depth++;
      if (skip.depth === 0) {
        skip = null;
        last = end;
      }
      continue;
    }
    if (closing || !hiddenElement(name, raw)) continue;
    out += html.slice(last, m.index);
    last = end;
    if (!selfClosing) skip = { name, depth: 1 };
  }
  // An unclosed hidden element hides the rest of the page, as in a browser.
  return skip ? out : out + html.slice(last);
}

/**
 * HTML to readable plain text: drops head/style/script and comments and every element a person can't see
 * (`dropHidden`), turns blocks and `<br>` into line breaks, list items into "- ", table cells into tabs,
 * images into their alt text, and links into "text (url)" (just the url when the text is the url). The
 * result goes through `cleanOutside`.
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|style|script|title|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!doctype[^>]*>/gi, "");
  text = dropHidden(text);
  text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_match, attrs: string, inner: string) => {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const url = decodeEntities((href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim());
    const label = inner
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const labelText = decodeEntities(label);
    if (!url || /^(javascript|data):/i.test(url) || url.startsWith("#")) return label;
    const shownUrl = url.replace(/^mailto:/i, "");
    if (!labelText || labelText === url || labelText === shownUrl) return shownUrl;
    return `${label} (${shownUrl})`;
  });
  text = text.replace(/<img\b[^>]*?\balt\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi, (_m, a?: string, b?: string) => {
    const alt = (a ?? b ?? "").trim();
    return alt ? `[${alt}]` : "";
  });
  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(td|th)\s*>/gi, "\t")
    .replace(new RegExp(`</?(${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
    .replace(/<\/li\s*>/gi, "")
    .replace(/<[^>]*>/g, "");
  text = decodeEntities(text).replace(/ /g, " ");
  return cleanOutside(text)
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\r]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
