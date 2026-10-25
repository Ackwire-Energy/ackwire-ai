/** A copy this small is enough to tell a picture from one flat color, and cheap to read back. */
const PROBE = { width: 16, height: 12 };

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

/**
 * Whether a canvas shows a picture yet: something drawn, and not one flat color (a screen whose desktop hasn't
 * drawn is black). Where the browser can't read a canvas back, it says yes: nothing waits on what can't be seen.
 */
export function showsPicture(canvas: HTMLCanvasElement) {
  if (canvas.width === 0 || canvas.height === 0) return false;
  const probe = document.createElement("canvas");
  probe.width = PROBE.width;
  probe.height = PROBE.height;
  const ctx = probe.getContext("2d", { willReadFrequently: true });
  if (!ctx) return true;
  ctx.drawImage(canvas, 0, 0, PROBE.width, PROBE.height);
  return !oneColor(ctx.getImageData(0, 0, PROBE.width, PROBE.height).data);
}
