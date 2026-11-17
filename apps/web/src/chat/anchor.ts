/**
 * The list holds its place where the browser doesn't.
 *
 * Rows off screen are drawn late (`content-visibility: auto`), so one above what the person reads can change height
 * after they scrolled past where it will be. Browsers with scroll anchoring move the list by as much, so nothing on
 * screen shifts. Safari has none: there the list is moved by hand, by what `anchorShift` says.
 */

/** A row whose height changed: its top now, in the list's content (0 = the content's top), and its height before and now. */
export interface RowResize {
  top: number;
  before: number;
  after: number;
}

/**
 * How far to scroll so what is on screen stays where it was: the growth of every row that ended above the list's
 * top edge before it changed. A row crossing that edge, or below it, is what the person looks at: it grows in place.
 * `rows` in any order, each `top` as laid out after all of them changed.
 */
export function anchorShift(rows: readonly RowResize[], scrollTop: number): number {
  let shift = 0;
  for (const row of [...rows].sort((a, b) => a.top - b.top)) {
    // Where it ended before any of this: its top now, less what the rows above it grew by.
    const endedAt = row.top - shift + row.before;
    if (endedAt <= scrollTop) shift += row.after - row.before;
  }
  return shift;
}

/** The browser keeps the list's place itself (scroll anchoring). */
export const anchorsScroll = () =>
  typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("overflow-anchor", "auto");
