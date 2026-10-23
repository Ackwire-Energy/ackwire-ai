/**
 * What an agent sees on a screen (ADR 0054): the page or window as text, one
 * line per node with a ref for each element it can act on (`button "Save"
 * [ref=e3]`, as `agent-browser`'s snapshot writes it), and what changed
 * between two looks. Surface-agnostic: the browser fills it from its
 * snapshot today; a desktop surface can fill it from the OS accessibility
 * tree later, and everything built on it (targets in words, checks, plans)
 * works the same.
 */

/** One element the agent can act on. */
export interface ScreenElement {
  /** `e12` (no `@`). */
  ref: string;
  role: string;
  name: string;
  /** Its line on the screen, as written. */
  line: string;
  /** Where it sits: its named containers, nearest first (`form "Sign in"`, `dialog "Cookies"`). */
  context: string[];
  /** Its line's position in `lines` (document order). */
  index: number;
}

export interface ScreenObservation {
  url: string | null;
  /** The screen as text, one node per line (indentation is nesting). */
  lines: string[];
  elements: ScreenElement[];
  /** When it was taken (ms). */
  at: number;
}

/** A still image of the screen (JPEG), with the size of the page in CSS pixels it shows. */
export interface ScreenImage {
  data: string;
  width: number;
  height: number;
  /** The page's size in CSS pixels (points on the image map onto it). */
  viewport: { width: number; height: number };
  /** Elements drawn on it with their number and box (CSS pixels), when it was annotated. */
  marks?: ScreenMark[];
}

export interface ScreenMark {
  ref: string;
  number: number;
  role: string;
  name?: string;
  box: { x: number; y: number; width: number; height: number };
}

const REF = /\bref=(e\d+)\b/;
const ROLE = /^-\s+([A-Za-z][\w-]*)/;
const NAME = /"((?:[^"\\]|\\.)*)"/;
/** Containers worth naming as an element's place ("the Delete in the row for invoice 42"). */
const PLACES = new Set([
  "dialog",
  "alertdialog",
  "form",
  "region",
  "navigation",
  "banner",
  "main",
  "complementary",
  "contentinfo",
  "search",
  "table",
  "row",
  "rowgroup",
  "listitem",
  "list",
  "group",
  "menu",
  "menubar",
  "tablist",
  "tabpanel",
  "toolbar",
  "article",
  "section",
  "heading",
  "Iframe",
  "iframe",
]);

const unquote = (s: string) => s.replace(/\\(.)/g, "$1");

/** `e7`, `@e7` or `[ref=e7]` → `e7`; anything else → null. */
export function screenRef(target: string): string | null {
  const m = /^\s*(?:\[?ref=)?@?(e\d+)\]?\s*$/.exec(target);
  return m ? (m[1] as string) : null;
}

/**
 * The screen from a snapshot's text (and its `refs` map when there is one:
 * role and name per ref, as `agent-browser --json` returns them).
 */
export function observeSnapshot(input: {
  text: string;
  url?: string | null;
  refs?: unknown;
  at?: number;
}): ScreenObservation {
  const lines = input.text
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "");
  const known =
    input.refs && typeof input.refs === "object"
      ? (input.refs as Record<string, { role?: unknown; name?: unknown }>)
      : {};
  const elements: ScreenElement[] = [];
  // Open containers, by depth: each line's named parents.
  const stack: { depth: number; place: string | null }[] = [];
  lines.forEach((line, index) => {
    const depth = (line.length - line.trimStart().length) / 2;
    const body = line.trim();
    while (stack.length > 0 && (stack[stack.length - 1] as { depth: number }).depth >= depth) stack.pop();
    const role = ROLE.exec(body)?.[1] ?? "";
    const quoted = NAME.exec(body)?.[1];
    const ref = REF.exec(body)?.[1];
    if (ref) {
      const meta = known[ref];
      elements.push({
        ref,
        role: typeof meta?.role === "string" && meta.role ? meta.role : role,
        name: typeof meta?.name === "string" ? meta.name : quoted !== undefined ? unquote(quoted) : "",
        line: body,
        context: stack
          .map((s) => s.place)
          .filter((p): p is string => p !== null)
          .reverse()
          .slice(0, 3),
        index,
      });
    }
    const place = PLACES.has(role) && quoted ? `${role} "${unquote(quoted).slice(0, 80)}"` : null;
    stack.push({ depth, place });
  });
  // Refs the map knows that no line carries (rare): still targets.
  const seen = new Set(elements.map((e) => e.ref));
  for (const [ref, meta] of Object.entries(known)) {
    if (seen.has(ref) || !/^e\d+$/.test(ref)) continue;
    const role = typeof meta?.role === "string" ? meta.role : "";
    const name = typeof meta?.name === "string" ? meta.name : "";
    elements.push({ ref, role, name, line: `${role} "${name}" [ref=${ref}]`, context: [], index: lines.length });
  }
  return { url: input.url ?? null, lines, elements, at: input.at ?? Date.now() };
}

/** How an element reads to a judge: its line plus where it sits. */
export function describeElement(e: ScreenElement, max = 220): string {
  const own = e.line.replace(/^-\s+/, "").replace(/\s*\[ref=e\d+\]/, "");
  const where = e.context.length > 0 ? ` — in ${e.context.join(" › ")}` : "";
  const text = `${own}${where}`;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The address without its fragment: two looks at the same document. */
const documentOf = (url: string | null) => (url ? url.replace(/#.*$/, "") : null);

export interface ScreenChanges {
  /** The address changed, or most of the screen did: a new page, not a change on it. */
  newPage: boolean;
  added: string[];
  removed: string[];
  urlBefore: string | null;
  urlAfter: string | null;
}

/**
 * What changed between two looks, line by line (a multiset difference: refs
 * stay the same for elements that survive, so a kept line reads the same).
 * Lines in screen order.
 */
export function diffObservations(before: ScreenObservation | null, after: ScreenObservation): ScreenChanges {
  if (!before) {
    return { newPage: true, added: after.lines, removed: [], urlBefore: null, urlAfter: after.url };
  }
  const count = new Map<string, number>();
  for (const l of before.lines) count.set(l.trim(), (count.get(l.trim()) ?? 0) + 1);
  const added: string[] = [];
  for (const l of after.lines) {
    const k = l.trim();
    const n = count.get(k) ?? 0;
    if (n > 0) count.set(k, n - 1);
    else added.push(l);
  }
  const left = new Map(count);
  const removed: string[] = [];
  for (const l of before.lines) {
    const k = l.trim();
    const n = left.get(k) ?? 0;
    if (n > 0) {
      removed.push(l);
      left.set(k, n - 1);
    }
  }
  const kept = after.lines.length - added.length;
  const newPage =
    documentOf(before.url) !== documentOf(after.url) ||
    (after.lines.length > 8 && kept < Math.min(before.lines.length, after.lines.length) * 0.3);
  return { newPage, added, removed, urlBefore: before.url, urlAfter: after.url };
}

/** A short fingerprint of a screen: two looks with the same one show the same thing. */
export function screenDigest(o: ScreenObservation): string {
  let h = 2166136261;
  for (const l of o.lines) {
    for (let i = 0; i < l.length; i++) {
      h ^= l.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 10;
  }
  return `${documentOf(o.url) ?? ""}#${(h >>> 0).toString(36)}:${o.lines.length}`;
}

const STRUCTURE = new Set(["heading", "dialog", "alertdialog", "alert", "status", "tab", "Iframe", "iframe"]);

/**
 * What the agent can act on, for its first look at a page: elements with a
 * ref plus headings, dialogs and alerts, nesting kept; at most `max`
 * characters (the rest counted).
 */
export function screenOverview(o: ScreenObservation, max = 6000): { text: string; omitted: number } {
  const keep = o.lines.filter((l) => REF.test(l) || STRUCTURE.has(ROLE.exec(l.trim())?.[1] ?? ""));
  return clipLines(keep, max);
}

/** Lines up to `max` characters; how many were left out. */
export function clipLines(lines: string[], max: number): { text: string; omitted: number } {
  const out: string[] = [];
  let size = 0;
  for (const l of lines) {
    if (size + l.length + 1 > max) break;
    out.push(l);
    size += l.length + 1;
  }
  return { text: out.join("\n"), omitted: lines.length - out.length };
}

/** The page's text for a judge, at most `max` characters. */
export function screenText(o: ScreenObservation, max = 60_000): string {
  return clipLines(o.lines, max).text;
}
