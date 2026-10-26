/** A copy this small is enough to tell a picture from one flat color, and cheap to read back. */
const PROBE = { width: 16, height: 12 };

/**
 * At most this share of a picture's copy is black. A desktop that just started is black until its wallpaper draws,
 * and a frame before that may already show its dock on the black: two or three pixels of the copy. A window black
 * from edge to edge still leaves the dock's band under it (60 px of 900, a row of the copy).
 */
const BLACK_MAX = 0.97;

/** RGBA pixels that are all one color. */
export function oneColor(pixels: Uint8ClampedArray) {
  for (let i = 4; i < pixels.length; i += 4) {
    if (
      pixels[i] !== pixels[0] ||
      pixels[i + 1] !== pixels[1] ||
      pixels[i + 2] !== pixels[2] ||
      pixels[i + 3] !== pixels[3]
    )
      return false;
  }
  return true;
}

/** The share of RGBA pixels that are black, whatever their alpha (a canvas nothing drew on is black too). */
function blackShare(pixels: Uint8ClampedArray) {
  let black = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] === 0 && pixels[i + 1] === 0 && pixels[i + 2] === 0) black++;
  }
  return black / (pixels.length / 4);
}

/**
 * Whether a canvas shows a picture yet: not one flat color, and not the black of a screen whose desktop hasn't
 * drawn with a few things on it already. Where the browser can't read a canvas back, it says yes: nothing waits on
 * what can't be seen.
 */
export function showsPicture(canvas: HTMLCanvasElement) {
  if (canvas.width === 0 || canvas.height === 0) return false;
  const probe = document.createElement("canvas");
  probe.width = PROBE.width;
  probe.height = PROBE.height;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) return true;
  ctx.drawImage(canvas, 0, 0, PROBE.width, PROBE.height);
  const pixels = ctx.getImageData(0, 0, PROBE.width, PROBE.height).data;
  return !oneColor(pixels) && blackShare(pixels) <= BLACK_MAX;
}
