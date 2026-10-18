/**
 * The picture viewer's math (worklets: they run on the UI thread during gestures). Translations are
 * from the screen's center, in points.
 */

export const MAX_ZOOM = 4;
/** A drag this far down (or up), or this fast, closes the viewer. */
export const DISMISS_DISTANCE = 120;
export const DISMISS_VELOCITY = 900;

/**
 * The translation that keeps the point under the fingers (`focal`, from the center) still while the
 * scale goes from `from` to `to`.
 */
export function zoomAround(
  start: { x: number; y: number },
  from: number,
  to: number,
  focalX: number,
  focalY: number,
): { x: number; y: number } {
  "worklet";
  const k = from > 0 ? to / from : 1;
  return { x: focalX - (focalX - start.x) * k, y: focalY - (focalY - start.y) * k };
}

/** Keeps a zoomed picture covering its frame: no empty edge pulled in beyond the picture's side. */
export function clampZoomTranslate(
  x: number,
  y: number,
  scale: number,
  width: number,
  height: number,
): { x: number; y: number } {
  "worklet";
  const maxX = Math.max(0, ((scale - 1) * width) / 2);
  const maxY = Math.max(0, ((scale - 1) * height) / 2);
  return { x: Math.min(Math.max(x, -maxX), maxX), y: Math.min(Math.max(y, -maxY), maxY) };
}
