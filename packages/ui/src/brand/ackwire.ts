/**
 * The Ackwire AI brand: the product's name and the Ackwire "A" monogram, from the Ackwire Design System
 * (Brand Guidelines 2026). The "A" is drawn in the theme's accent (`--agent`: Solar Green on dark, its deep shade on
 * light, where Solar Green fails contrast); the wordmark is the name in the ink.
 */

/** The product's name, as it is written everywhere: never translated. */
export const BRAND_NAME = "Ackwire AI";

/** The Ackwire "A" monogram (the brand's `monogram.svg`): its ink spans x 238.9 to 466.2 and y 0 to 162. */
export const MONOGRAM_PATH =
  "M461.02,117.93l-69.68-97.94c-4.59-6.45-10.46-11.49-17.44-14.98-6.55-3.27-13.91-5-21.28-5.01h-.03c-7.37,0-14.72,1.72-21.26,4.98-6.99,3.48-12.86,8.51-17.46,14.96l-69.8,97.85c-8.07,11.31-6.58,26.84,3.48,36.42l.15.15c11.16,10.62,28.82,10.18,39.44-.99l44.2-46.46c5.6-5.89,13.16-9.13,21.29-9.13s15.69,3.24,21.29,9.13l44.16,46.42c10.62,11.16,28.28,11.61,39.44.99h0c10.06-9.57,11.55-25.08,3.5-36.39ZM387.08,94.38c-9.07-9.53-21.31-14.78-34.46-14.78s-25.39,5.25-34.46,14.78l-50.81,53.42,62.36-77.74c5.61-6.99,13.96-11,22.92-11s17.31,4.01,22.92,11l62.36,77.74-50.82-53.42ZM389.72,58.68c-9.07-11.31-22.6-17.8-37.1-17.8s-28.03,6.49-37.1,17.8l-62.87,78.38,76.01-106.56c5.58-7.83,14.3-12.32,23.91-12.32h.02c9.62,0,18.34,4.51,23.92,12.35l73.56,103.39-60.35-75.24Z";

/** A square box around the monogram, centered: use it as the `viewBox` of a square mark. */
export const MONOGRAM_VIEWBOX = "238.5 -33 228 228";

/** Ackwire's brand colors (the Design System's `brand.css`), for places without the theme's tokens. */
export const ACKWIRE = {
  forest: "#031f1b",
  charcoal: "#020f0d",
  solar: "#90ed42",
  solarDeep: "#3f7a12",
  celadon: "#eef4ef",
} as const;

/**
 * The "A" in the app's pixel style: the monogram's three layers as stepped chevrons on a 26×13 grid, each cell the
 * number of its layer (1 the outer, 3 the inner), "." empty. Each layer has its own tone of Ackwire green, brightest
 * outside, as light falls on the agents from above.
 */
export const PIXEL_MARK = [
  "............11............",
  "...........1111...........",
  "..........111111..........",
  ".........111..111.........",
  "........111.22.111........",
  ".......111.2222.111.......",
  "......111.222222.111......",
  ".....111.222..222.111.....",
  "....111.222.33.222.111....",
  "...111.222.3333.222.111...",
  "..111.222.333333.222.111..",
  ".111.222.333..333.222.111.",
  "111.222.333....333.222.111",
] as const;

/** The pixel mark's grid, and a square box around it, centered (`viewBox`). */
export const PIXEL_MARK_SIZE = { w: 26, h: 13 } as const;
export const PIXEL_MARK_VIEWBOX = "0 -6.5 26 26";

/** The three layers' tones per theme, outer to inner: deep enough on white on light, bright on black on dark. */
export const PIXEL_MARK_TONES = {
  light: ["#2f5f0d", "#3f7a12", "#5a9a1e"],
  dark: ["#b8f582", "#90ed42", "#6cba2c"],
} as const;

/** One row's run of cells of one layer: `layer` 0 is the outer, 2 the inner. */
export interface PixelRun {
  x: number;
  y: number;
  w: number;
  layer: 0 | 1 | 2;
}

/** The pixel mark as runs of cells, one rect each. */
export function pixelMarkRuns(): PixelRun[] {
  const runs: PixelRun[] = [];
  PIXEL_MARK.forEach((row, y) => {
    let start = 0;
    for (let x = 1; x <= row.length; x++) {
      if (row[x] === row[start]) continue;
      const cell = row[start];
      if (cell && cell !== ".") runs.push({ x: start, y, w: x - start, layer: (Number(cell) - 1) as 0 | 1 | 2 });
      start = x;
    }
  });
  return runs;
}

/**
 * The pixel mark as SVG elements (for pages without React: the favicon, the error page): `fill` in the given tones
 * (outer to inner), or with `as: "class"` the given class names, for a page whose stylesheet colors them per theme.
 */
export function pixelMarkRects(tones: readonly string[], as: "fill" | "class" = "fill"): string {
  return pixelMarkRuns()
    .map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1" ${as}="${tones[r.layer]}"/>`)
    .join("");
}
