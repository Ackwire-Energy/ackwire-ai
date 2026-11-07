/**
 * Room every floating layer (menu, list, popover, hover card, tooltip) keeps from the viewport's edges: `--space-3`.
 * `.ac-popover, .ac-menu--dropdown` in `styles/components.css` cap their width at twice this.
 */
export const EDGE_ROOM = 12;

/**
 * How far a popover moves over its trigger to show whole: a card taller than the room on its side (its height clamped to
 * that room, and still overflowing) gains what it lacks over `base`, the room it had before moving, up to the whole
 * window between the edges. 0 for one that fits, or that its own cap clamps (a menu's 280px scrolls where it is).
 * Measured from `base`, not from the room now: one that already moved but isn't placed again yet asks the same, not more.
 */
export function pullToFit(box: {
  scroll: number;
  client: number;
  height: number;
  room: number;
  base: number;
  window: number;
}) {
  if (box.scroll <= box.client || !(box.height >= box.room - 1)) return 0;
  const natural = box.scroll + box.height - box.client;
  return Math.max(0, Math.ceil(Math.min(natural - box.base, box.window - 2 * EDGE_ROOM - box.base)));
}
