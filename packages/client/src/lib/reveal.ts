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

/** How much of `target` to show `elapsedMs` after showing `shown` characters. */
export function revealStep(shown: number, target: string, elapsedMs: number) {
  if (shown >= target.length) return target.length;
  const from = Math.max(0, shown);
  const backlog = target.length - from;
  const cps = Math.max(REVEAL_BASE_CPS, (backlog * 1000) / REVEAL_MAX_LAG_MS);
  const budget = Math.max(1, Math.round((cps * Math.max(0, elapsedMs)) / 1000));
  return Math.max(from + 1, wordEnd(target, Math.min(target.length, from + budget)));
}

/**
 * Keeps the revealed length when the text only grew; starts over when it
 * was replaced (a run resumed after an approval streams a fresh text).
 */
export function rebaseReveal(shown: number, previous: string, next: string) {
  const kept = Math.min(shown, previous.length);
  return next.startsWith(previous.slice(0, kept)) ? Math.min(kept, next.length) : 0;
}
