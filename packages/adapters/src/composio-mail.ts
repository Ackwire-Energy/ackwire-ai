/**
 * Small, dependency-free helpers to normalise mail coming out of providers
 * (Composio's Gmail and Outlook tool results and trigger payloads): JSON fields, HTML to plain text, address lists, dates and base64url bodies.
 */
import type { MailAddress } from "./mail";

export type Obj = Record<string, unknown>;

/** A JSON object field, or `{}`. */
export const obj = (value: unknown): Obj =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
/** A non-empty string (a number as text), else undefined. */
export const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : typeof value === "number" ? String(value) : undefined;
/** A search's page size: 20 by default, 1 to 50. */
export const clampLimit = (limit: number | undefined) => Math.min(50, Math.max(1, Math.floor(limit ?? 20)));

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

/**
 * HTML to readable plain text: drops head/style/script and comments, turns
 * blocks and `<br>` into line breaks, list items into "- ", table cells into
 * tabs, and links into "text (url)" (just the url when the text is the url).
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|style|script|title|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!doctype[^>]*>/gi, "");
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
  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(td|th)\s*>/gi, "\t")
    .replace(new RegExp(`</?(${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n")
    .replace(/<\/li\s*>/gi, "")
    .replace(/<[^>]*>/g, "");
  text = decodeEntities(text).replace(/ /g, " ");
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\r]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Whether a body looks like HTML rather than plain text. */
export function looksLikeHtml(text: string): boolean {
  return /<\/?(html|body|div|p|br|table|span|td|img|style|head|meta|font|b|strong|ul|li)\b[^>@]*>|<a\s[^>]*href/i.test(
    text,
  );
}

/** Plain text either way: converts when the body looks like HTML. */
export function toPlainText(body: string): string {
  return looksLikeHtml(body) ? htmlToText(body) : decodeEntities(body).replace(/\r\n/g, "\n").trim();
}

/** Collapses whitespace and cuts to `max` characters (with an ellipsis). */
export function snippetOf(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Splits an address header on commas outside quotes and angle brackets. */
function splitAddresses(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angle = 0;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === "<") angle++;
    else if (!quoted && char === ">") angle = Math.max(0, angle - 1);
    if ((char === "," || char === ";") && !quoted && angle === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** One address: `Name <a@b.c>`, `"Last, First" <a@b.c>` or `a@b.c`; null when there is no address. */
export function parseAddress(value: string): MailAddress | null {
  const trimmed = value.trim();
  const angle = /^(.*)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(trimmed);
  if (angle) {
    const name = decodeEntities(
      (angle[1] ?? "")
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .trim(),
    );
    const address = (angle[2] ?? "").toLowerCase();
    return name && name.toLowerCase() !== address ? { name, address } : { address };
  }
  const bare = /([^\s<>"]+@[^\s<>"]+)/.exec(trimmed);
  return bare?.[1] ? { address: bare[1].toLowerCase() } : null;
}

/** An address list header (or an array of strings / Graph recipients) into lowercase addresses. */
export function parseAddressList(value: unknown): MailAddress[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => parseAddressList(item));
  if (typeof value === "object") {
    const graph = graphRecipient(value);
    return graph ? [graph] : [];
  }
  if (typeof value !== "string") return [];
  return splitAddresses(value)
    .map(parseAddress)
    .filter((address): address is MailAddress => address !== null);
}

/** A Microsoft Graph recipient (`{ emailAddress: { name, address } }`). */
export function graphRecipient(value: unknown): MailAddress | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const inner = (record.emailAddress ?? record.email_address ?? record) as Record<string, unknown>;
  const address = typeof inner.address === "string" ? inner.address.trim().toLowerCase() : "";
  if (!address.includes("@")) return null;
  const name = typeof inner.name === "string" ? inner.name.trim() : "";
  return name && name.toLowerCase() !== address ? { name, address } : { address };
}

/**
 * A date as ISO 8601: accepts ISO strings, RFC 2822 headers and epoch
 * milliseconds or seconds (number or numeric string). Null when unreadable.
 */
export function toIsoDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  let date: Date;
  if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value.trim()))) {
    const n = Number(value);
    date = new Date(n < 1e12 ? n * 1000 : n);
  } else if (typeof value === "string") {
    date = new Date(value);
  } else return null;
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Decodes base64 or base64url (padding optional). */
export function decodeBase64(data: string): Uint8Array {
  const normal = data.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const padded = normal + "=".repeat((4 - (normal.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, "base64"));
}

/** Decodes a base64url body to UTF-8 text. */
export function decodeBase64Text(data: string): string {
  return new TextDecoder().decode(decodeBase64(data));
}
