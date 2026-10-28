/**
 * Smooth reveal of an agent's streamed reply. Deltas arrive in uneven
 * chunks; the row shows them word by word, one step per animation frame.
 * A small buffer drains at a reading pace, a big one drains fast (in about
 * `REVEAL_MAX_LAG_MS`), so a long reply never lags far behind the stream.
 */

/** Pace when the buffer is small (characters per second). */
export const REVEAL_BASE_CPS = 90;
/** A big buffer drains in about this long. */
export const REVEAL_MAX_LAG_MS = 350;
/** A row that mounts with this much text already (back to the channel mid-reply) shows it at once. */
export const REVEAL_INSTANT_FROM = 400;

const space = (c: string | undefined) => c !== undefined && /\s/.test(c);

/** Characters to show when the row mounts with `text`. */
export const initialReveal = (text: string) => (text.length >= REVEAL_INSTANT_FROM ? text.length : 0);

/**
 * The end of the word at `index`, with the spaces after it, so words are
 * released whole. An index already on a word start stays where it is.
 */
export function wordEnd(text: string, index: number) {
  if (index >= text.length) return text.length;
  if (index <= 0) return 0;
  if (space(text[index - 1]) && !space(text[index])) return index;
  let i = index;
  while (i < text.length && !space(text[i])) i++;
  while (i < text.length && space(text[i])) i++;
  return i;
}

/**
 * How much of `target` to show `elapsedMs` after showing `shown` characters. While it is still `writing`, an inline
 * Markdown piece shows whole (`wholeMarkdown`); a stopped text never waits for a closing that won't come.
 */
export function revealStep(shown: number, target: string, elapsedMs: number, writing = true) {
  if (shown >= target.length) return target.length;
  const from = Math.max(0, shown);
  const backlog = target.length - from;
  const cps = Math.max(REVEAL_BASE_CPS, (backlog * 1000) / REVEAL_MAX_LAG_MS);
  const budget = Math.max(1, Math.round((cps * Math.max(0, elapsedMs)) / 1000));
  const next = Math.max(from + 1, wordEnd(target, Math.min(target.length, from + budget)));
  return writing ? Math.max(from, wholeMarkdown(target, next)) : next;
}

/** An open mark that has waited this long (characters) for its closing is a literal one: it stops holding. */
export const MARKDOWN_HOLD_MAX = 160;

type Mark = { kind: "code" | "**" | "~~" | "*" | "link"; at: number; url?: boolean };

/** The inline Markdown pieces open so far, read one character at a time (`readMark`). */
interface MarkScan {
  open: Mark[];
  fenced: boolean;
  lineStart: boolean;
}

const newScan = (): MarkScan => ({ open: [], fenced: false, lineStart: true });

/**
 * Reads the character at `i` into `scan` and returns where the next one is. Inline code, bold, strike, italic with
 * `*` and links; never across a blank line, never inside a fenced code block (that one shows line by line). A `*`
 * or `**` opens only before a non-space and closes only after one, so "5 * 3" or a list's "* " is text.
 */
function readMark(text: string, i: number, scan: MarkScan): number {
  const ch = text[i] as string;
  const atLineStart = scan.lineStart;
  if (atLineStart && text.startsWith("```", i)) {
    scan.fenced = !scan.fenced;
    scan.open.length = 0;
    scan.lineStart = false;
    return i + 3;
  }
  if (ch === "\n") {
    // A blank line ends a paragraph: nothing inline carries over.
    if (text[i + 1] === "\n") scan.open.length = 0;
    scan.lineStart = true;
    return i + 1;
  }
  scan.lineStart = false;
  if (scan.fenced) return i + 1;
  const open = scan.open;
  const top = open[open.length - 1];
  if (top?.kind === "code") {
    if (ch === "`") open.pop();
    return i + 1;
  }
  if (ch === "`") {
    open.push({ kind: "code", at: i });
    return i + 1;
  }
  if (top?.kind === "link") {
    if (!top.url && ch === "]") {
      if (text[i + 1] === "(") {
        top.url = true;
        return i + 2;
      }
      open.pop();
    } else if (top.url && ch === ")") open.pop();
    return i + 1;
  }
  if (ch === "[") {
    open.push({ kind: "link", at: text[i - 1] === "!" ? i - 1 : i });
    return i + 1;
  }
  const pair = text.startsWith("**", i) ? "**" : text.startsWith("~~", i) ? "~~" : ch === "*" ? "*" : null;
  if (!pair) return i + 1;
  const before = text[i - 1];
  const after = text[i + pair.length];
  let closing = -1;
  for (let k = open.length - 1; k >= 0; k--) {
    if (open[k]?.kind === pair) {
      closing = k;
      break;
    }
  }
  if (closing >= 0 && before !== undefined && !/\s/.test(before)) open.splice(closing);
  else if (after !== undefined && !/\s/.test(after) && !(pair === "*" && atLineStart && after === " "))
    open.push({ kind: pair, at: i });
  return i + pair.length;
}

/**
 * The end to reveal so no inline Markdown piece shows half-drawn (a raw "**" or "[" that turns into formatting a
 * moment later): a piece open at `end` is shown whole when its closing already arrived, or waits at its opening
 * while it hasn't. A mark open for more than `MARKDOWN_HOLD_MAX` characters is taken as text.
 */
export function wholeMarkdown(text: string, end: number) {
  if (end >= text.length) return text.length;
  const scan = newScan();
  let i = 0;
  while (i < end) i = readMark(text, i, scan);
  const mark = scan.open[0];
  if (!mark || end - mark.at > MARKDOWN_HOLD_MAX) return end;
  // Read on (at most to the hold's limit) for where everything open closes.
  const limit = Math.min(text.length, mark.at + MARKDOWN_HOLD_MAX);
  while (i < limit) {
    i = readMark(text, i, scan);
    if (scan.open.length === 0) return wordEnd(text, i);
  }
  return mark.at;
}
