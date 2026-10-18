/**
 * The conversation list's scroll rules, kept pure so they can be tested: when the list follows new
 * content, which rows just arrived at the bottom (they animate in), how many new messages sit below
 * the person while they read older ones (the "N novas mensagens" pill), and how a finished reply's
 * streaming row waits for its saved message so the swap never leaves an empty frame.
 */

/**
 * The list follows new content only while the person is this close to the end, as a fraction of the
 * visible height (Legend List's `maintainScrollAtEndThreshold`). Farther up, they are reading: nothing
 * moves and the pill counts what arrived.
 */
export const STICK_TO_END_THRESHOLD = 0.15;

/** How long a finished reply's streaming row waits for its saved message before it goes anyway. */
export const HOLD_FINISHED_RUN_MS = 2500;

/**
 * Keys added at the bottom since the previous rows: after the last row both lists share, and new.
 * An older page prepended above, the first load (no previous rows) and a replaced list give none.
 */
export function appendedKeys(prev: readonly string[], next: readonly string[]): string[] {
  if (prev.length === 0) return [];
  const before = new Set(prev);
  let last = -1;
  for (let i = next.length - 1; i >= 0; i--) {
    if (before.has(next[i] as string)) {
      last = i;
      break;
    }
  }
  if (last < 0) return [];
  return next.slice(last + 1).filter((k) => !before.has(k));
}

export interface ScrollRow {
  key: string;
  /** A message or a reply being written (day dividers and markers never count). */
  kind: "message" | "run" | "other";
  /** Written by the person reading (never counts as new for them). */
  mine?: boolean;
}

/** The last message row: where the person has read up to when they are at the end. */
export function lastSeenKey(rows: readonly ScrollRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i] as ScrollRow;
    if (r.kind === "message") return r.key;
  }
  return null;
}

/**
 * New messages and replies below the last one the person saw, theirs left out. If that row is gone
 * (the list was replaced), nothing counts.
 */
export function unreadBelow(rows: readonly ScrollRow[], seenKey: string | null): number {
  if (!seenKey) return 0;
  const at = rows.findIndex((r) => r.key === seenKey);
  if (at < 0) return 0;
  let n = 0;
  for (let i = at + 1; i < rows.length; i++) {
    const r = rows[i] as ScrollRow;
    if ((r.kind === "message" || r.kind === "run") && !r.mine) n++;
  }
  return n;
}

export interface HeldRun<R> {
  run: R;
  until: number;
}

export interface RunsShown<R> {
  /** The streaming rows to draw, the held ones (older) first. */
  shown: R[];
  held: Map<string, HeldRun<R>>;
  /** When the next held row expires (to re-check then), or null. */
  nextExpiry: number | null;
}

/**
 * The streaming rows to draw. A run that stops writing usually has its saved message a moment later
 * (separate updates), so its row stays, with its last words, until a message with that run arrives or
 * `holdMs` passes. A run whose message is already in the list never draws (no duplicate reply).
 */
export function runsToShow<R extends { runId: string }>(
  held: ReadonlyMap<string, HeldRun<R>>,
  prevShown: readonly R[],
  writing: readonly R[],
  arrived: ReadonlySet<string>,
  now: number,
  holdMs = HOLD_FINISHED_RUN_MS,
): RunsShown<R> {
  const live = writing.filter((r) => !arrived.has(r.runId));
  const writingIds = new Set(writing.map((r) => r.runId));
  const next = new Map<string, HeldRun<R>>();
  for (const [id, h] of held) {
    if (h.until > now && !arrived.has(id) && !writingIds.has(id)) next.set(id, h);
  }
  for (const r of prevShown) {
    // Stopped writing just now (not held before): hold it.
    if (!writingIds.has(r.runId) && !arrived.has(r.runId) && !held.has(r.runId)) {
      next.set(r.runId, { run: r, until: now + holdMs });
    }
  }
  let nextExpiry: number | null = null;
  for (const h of next.values()) {
    if (nextExpiry === null || h.until < nextExpiry) nextExpiry = h.until;
  }
  return { shown: [...[...next.values()].map((h) => h.run), ...live], held: next, nextExpiry };
}
