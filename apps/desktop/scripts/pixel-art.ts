/**
 * Pixel art for the installers' pictures (installer-art.ts for Windows, dmg-art.ts for the macOS .dmg), drawn from
 * the agent engine and the sky's tones so the installers show the same agent and sky as the app's cover.
 *
 * No dependencies: the wordmark is outlines as path data (Plus Jakarta Sans ExtraBold, SIL Open Font License 1.1,
 * the brand typeface's stand-in), filled here, and small BMP and PNG writers.
 */
import { deflateSync } from "node:zlib";
import { bodyTones, EYE_COLOR, eyeShapes, inBody, toneAt } from "../../../packages/ui/src/agent/engine.js";
import { ACKWIRE } from "../../../packages/ui/src/brand/ackwire";
import { SKY_TONES } from "../../../packages/ui/src/sky/math";

export type RGB = [number, number, number];

export const hex = (h: string): RGB => {
  const n = Number.parseInt(h.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
export const WHITE: RGB = [255, 255, 255];
/** Ackwire's Solar Green and Forest Green (packages/ui brand/ackwire.ts). */
export const SOLAR = hex(ACKWIRE.solar);
export const FOREST = hex(ACKWIRE.forest);
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** The sky's run from deep to light (the cover's sky). */
export const SKY = (SKY_TONES as string[]).map(hex);

/** A picture `w`×`h` pixels, drawn in points of `k` pixels each (2 = twice the size it shows at). */
export class Picture {
  readonly px: Float64Array;
  constructor(
    readonly w: number,
    readonly h: number,
    readonly k = 2,
  ) {
    this.px = new Float64Array(w * h * 3);
  }

  /** Paints (x, y) with `c` at `alpha` over what is there. */
  blend(x: number, y: number, c: RGB, alpha = 1) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || alpha <= 0) return;
    const i = (y * this.w + x) * 3;
    for (let k = 0; k < 3; k++) this.px[i + k] = (this.px[i + k] as number) * (1 - alpha) + (c[k] as number) * alpha;
  }

  rect(x: number, y: number, w: number, h: number, c: RGB) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.blend(xx, yy, c);
  }

  /** A rect in points (rounded to whole pixels), at `alpha`. */
  box(x: number, y: number, w: number, h: number, c: RGB, alpha = 1) {
    const x0 = Math.round(x * this.k);
    const y0 = Math.round(y * this.k);
    const x1 = Math.round((x + w) * this.k);
    const y1 = Math.round((y + h) * this.k);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.blend(xx, yy, c, alpha);
  }

  /** 24-bit BMP, rows bottom-up, each padded to 4 bytes. */
  bmp(): Uint8Array {
    const row = Math.ceil((this.w * 3) / 4) * 4;
    const size = 54 + row * this.h;
    const out = new Uint8Array(size);
    const v = new DataView(out.buffer);
    out[0] = 0x42; // "BM"
    out[1] = 0x4d;
    v.setUint32(2, size, true);
    v.setUint32(10, 54, true);
    v.setUint32(14, 40, true);
    v.setInt32(18, this.w, true);
    v.setInt32(22, this.h, true);
    v.setUint16(26, 1, true);
    v.setUint16(28, 24, true);
    v.setUint32(34, row * this.h, true);
    v.setInt32(38, 3780, true); // 96 dpi
    v.setInt32(42, 3780, true);
    for (let y = 0; y < this.h; y++) {
      const at = 54 + (this.h - 1 - y) * row;
      for (let x = 0; x < this.w; x++) {
        const i = (y * this.w + x) * 3;
        for (let k = 0; k < 3; k++) out[at + x * 3 + (2 - k)] = Math.round(this.px[i + k] as number); // BGR
      }
    }
    return out;
  }

  /** 8-bit RGB PNG at 72 dpi per point (a 2× picture says 144 dpi, as macOS expects of a Retina image). */
  png(): Uint8Array {
    const raw = new Uint8Array((this.w * 3 + 1) * this.h);
    for (let y = 0; y < this.h; y++) {
      const at = y * (this.w * 3 + 1); // filter byte 0 (none), then the row
      for (let x = 0; x < this.w * 3; x++) raw[at + 1 + x] = Math.round(this.px[y * this.w * 3 + x] as number);
    }
    const ihdr = new Uint8Array(13);
    const hv = new DataView(ihdr.buffer);
    hv.setUint32(0, this.w);
    hv.setUint32(4, this.h);
    ihdr.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB, deflate, no filter set, not interlaced
    const phys = new Uint8Array(9);
    const pv = new DataView(phys.buffer);
    const perMeter = Math.round((72 * this.k) / 0.0254);
    pv.setUint32(0, perMeter);
    pv.setUint32(4, perMeter);
    phys[8] = 1; // meters
    const chunks = [
      chunk("IHDR", ihdr),
      chunk("pHYs", phys),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", new Uint8Array()),
    ];
    const sig = [137, 80, 78, 71, 13, 10, 26, 10];
    const out = new Uint8Array(sig.length + chunks.reduce((n, c) => n + c.length, 0));
    out.set(sig);
    let at = sig.length;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** One PNG chunk: length, type, data and the CRC of type + data. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let c = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) c = (CRC[(c ^ (out[i] as number)) & 255] as number) ^ (c >>> 8);
  v.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
  return out;
}

/* ---------- The sky: ordered dither over a run of tones ---------- */

/** Dithers `tones` over the picture in cells of `cell` points; `at(u, v)` (0..1) picks along the tones. */
export function dither(p: Picture, tones: RGB[], at: (u: number, v: number) => number, cell = 2) {
  const size = cell * p.k;
  const cw = Math.ceil(p.w / size);
  const ch = Math.ceil(p.h / size);
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++) {
      const val = Math.max(0, Math.min(0.999, at((x + 0.5) / cw, (y + 0.5) / ch))) * (tones.length - 1);
      const lo = Math.floor(val);
      const th = ((BAYER[(y & 3) * 4 + (x & 3)] as number) + 0.5) / 16;
      const tone = tones[val - lo > th ? Math.min(lo + 1, tones.length - 1) : lo] as RGB;
      p.rect(x * size, y * size, size, size, tone);
    }
}

/** A small pixel cloud (the landing's), at (x, y) in points, `cell` points per block. */
export function cloud(p: Picture, x: number, y: number, cell: number, tone: RGB) {
  const shape = ["..XXX...", ".XXXXXX.", "XXXXXXXX"];
  shape.forEach((line, j) => {
    [...line].forEach((c, i) => {
      if (c === "X") p.rect((x + i * cell) * p.k, (y + j * cell) * p.k, cell * p.k, cell * p.k, tone);
    });
  });
}

/* ---------- The agent: the engine's body, tones and eyes, still ---------- */

const SS = 4; // samples per axis on the edges

function inPill(u: number, v: number, e: { x: number; y: number; w: number; h: number }): boolean {
  if (u < e.x || u > e.x + e.w || v < e.y || v > e.y + e.h) return false;
  const r = Math.min(e.w, e.h) / 2;
  const cx = Math.min(Math.max(u, e.x + r), e.x + e.w - r);
  const cy = Math.min(Math.max(v, e.y + r), e.y + e.h - r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** The engine's "arc" eye (drawEyes): the top half of an ellipse, stroked with round ends, in body units. */
function onArc(u: number, v: number, e: { x: number; y: number; w: number; h: number }, line: number): boolean {
  const lw = line;
  const rx = Math.max(0.5 / 128, e.w / 2 - lw / 2);
  const ry = e.h;
  const cx = e.x + e.w / 2;
  const cy = e.y + e.h;
  const steps = 24;
  for (let k = 0; k < steps; k++) {
    const a0 = Math.PI + (Math.PI * k) / steps;
    const a1 = Math.PI + (Math.PI * (k + 1)) / steps;
    const d = distToSegment(
      u,
      v,
      cx + rx * Math.cos(a0),
      cy + ry * Math.sin(a0),
      cx + rx * Math.cos(a1),
      cy + ry * Math.sin(a1),
    );
    if (d <= lw / 2) return true;
  }
  return false;
}

/** The agent (round eyes, as the cover) at (x, y) in points, `size` points wide; sky and 12 cells unless told. */
export function agent(p: Picture, x: number, y: number, size: number, happy = false, color = "sky", n = 12) {
  const s = Math.round(size * p.k);
  const ox = Math.round(x * p.k);
  const oy = Math.round(y * p.k);
  const tones = (bodyTones(color) as string[]).map(hex);
  const eyes = eyeShapes("round", happy ? { expression: "happy" } : {}) as {
    x: number;
    y: number;
    w: number;
    h: number;
    kind: string;
  }[];
  const line = Math.max(1.4, s * 0.055) / s;
  const eye = (u: number, v: number) => eyes.some((e) => (e.kind === "arc" ? onArc(u, v, e, line) : inPill(u, v, e)));
  for (let py = 0; py < s; py++)
    for (let px = 0; px < s; px++) {
      let hits = 0;
      let white = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const u = (px + (sx + 0.5) / SS) / s;
          const v = (py + (sy + 0.5) / SS) / s;
          if (!inBody(u, v)) continue;
          hits++;
          if (eye(u, v)) white++;
        }
      if (!hits) continue;
      const u = (px + 0.5) / s;
      const v = (py + 0.5) / s;
      const tone = tones[toneAt(Math.min(n - 1, Math.floor(u * n)), Math.min(n - 1, Math.floor(v * n)), n)] as RGB;
      p.blend(ox + px, oy + py, tone, hits / (SS * SS));
      if (white) p.blend(ox + px, oy + py, hex(EYE_COLOR), white / hits);
    }
}

/* ---------- The wordmark: "Ackwire" and "AI" in Plus Jakarta Sans ExtraBold ---------- */

/** Outlines at 100 px, baseline at y = 0, set as the logo's lockup (packages/ui Logo): tight, "AI" a gap after. */
export const WORDMARK = {
  width: 512.7,
  ackwire:
    "M1.1 0L26.3 -74.5L46.9 -74.5L72.1 0L55.2 0L50.2 -15.2L22.9 -15.2L17.9 0ZM27.2 -28.7L45.9 -28.7L34.5 -63.9L38.7 -63.9ZM100.5 1.2Q92.3 1.2 85.8 -2.6Q79.2 -6.3 75.4 -12.8Q71.5 -19.3 71.5 -27.4Q71.5 -35.5 75.3 -41.9Q79.1 -48.4 85.7 -52.1Q92.3 -55.8 100.5 -55.8Q106.6 -55.8 111.8 -53.7Q117 -51.6 120.7 -47.8Q124.4 -44.1 126 -39L113 -33.4Q111.6 -37.5 108.3 -39.9Q104.9 -42.3 100.5 -42.3Q96.6 -42.3 93.6 -40.4Q90.5 -38.5 88.8 -35.1Q87 -31.7 87 -27.3Q87 -22.9 88.8 -19.5Q90.5 -16.1 93.6 -14.2Q96.6 -12.3 100.5 -12.3Q105 -12.3 108.3 -14.7Q111.6 -17.1 113 -21.2L126 -15.5Q124.5 -10.7 120.8 -6.9Q117.1 -3.1 111.9 -0.9Q106.7 1.2 100.5 1.2ZM131.8 0L131.8 -75.7L146.8 -75.7L146.8 -27.2L141.2 -29L165.3 -54.6L183.8 -54.6L164 -32.6L183.7 0L166.7 0L150.2 -27.7L158.9 -29.9L142.2 -11.7L146.8 -20.4L146.8 0ZM201.8 0L183 -54.6L198.5 -54.6L211.7 -15.2L206.3 -15.3L221 -54.6L234 -54.6L248.6 -15.3L243.2 -15.2L256.4 -54.6L272 -54.6L253.1 0L240.1 0L224.9 -42.2L230.1 -42.2L214.8 0ZM275.6 0L275.6 -54.6L290.6 -54.6L290.6 0ZM275.6 -59.5L275.6 -74.5L290.6 -74.5L290.6 -59.5ZM298.6 0L298.6 -54.6L312.6 -54.6L312.6 -41.5L311.6 -43.4Q313.4 -50.3 317.6 -52.7Q321.7 -55.2 327.4 -55.2L330.6 -55.2L330.6 -42.2L325.9 -42.2Q320.4 -42.2 317 -38.8Q313.6 -35.5 313.6 -29.4L313.6 0ZM360.5 1.2Q351.8 1.2 345.4 -2.7Q339 -6.5 335.5 -13Q332 -19.5 332 -27.4Q332 -35.6 335.7 -42Q339.3 -48.4 345.5 -52.1Q351.7 -55.8 359.5 -55.8Q366 -55.8 371 -53.7Q376 -51.7 379.5 -48Q382.9 -44.3 384.7 -39.4Q386.5 -34.6 386.5 -28.9Q386.5 -27.3 386.4 -25.7Q386.2 -24.2 385.8 -23.1L344.9 -23.1L344.9 -34.1L377.3 -34.1L370.2 -28.9Q371.2 -33.2 370.1 -36.6Q369 -39.9 366.3 -41.8Q363.5 -43.8 359.5 -43.8Q355.6 -43.8 352.8 -41.9Q350 -40 348.6 -36.3Q347.2 -32.6 347.5 -27.3Q347.1 -22.7 348.6 -19.2Q350.1 -15.7 353.2 -13.7Q356.3 -11.8 360.7 -11.8Q364.7 -11.8 367.6 -13.4Q370.4 -15 372 -17.8L384 -12.1Q382.4 -8.1 379 -5.1Q375.5 -2.1 370.8 -0.4Q366.1 1.2 360.5 1.2Z",
  ai: "M414.9 0L440.1 -74.5L460.7 -74.5L485.9 0L469 0L464 -15.2L436.7 -15.2L431.7 0ZM441 -28.7L459.7 -28.7L448.3 -63.9L452.5 -63.9ZM490.6 0L490.6 -74.5L506.1 -74.5L506.1 0Z",
};

type Edge = [number, number, number, number];

/** M/L/Q/Z path data (absolute, as the outlines above) to line edges, curves flattened. */
export function edges(d: string, scale: number, dx: number, dy: number): Edge[] {
  const out: Edge[] = [];
  const tokens = d.match(/[MLQZ]|-?\d*\.?\d+/g) ?? [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  const num = () => Number(tokens[i++]);
  const P = (px: number, py: number): [number, number] => [dx + px * scale, dy + py * scale];
  while (i < tokens.length) {
    const t = tokens[i] as string;
    if (/[MLQZ]/.test(t)) {
      cmd = t;
      i++;
      if (cmd === "Z") {
        out.push([...P(x, y), ...P(sx, sy)]);
        x = sx;
        y = sy;
      }
      continue;
    }
    if (cmd === "M") {
      x = sx = num();
      y = sy = num();
      cmd = "L";
    } else if (cmd === "L") {
      const nx = num();
      const ny = num();
      out.push([...P(x, y), ...P(nx, ny)]);
      x = nx;
      y = ny;
    } else if (cmd === "Q") {
      const cx = num();
      const cy = num();
      const nx = num();
      const ny = num();
      let px = x;
      let py = y;
      for (let k = 1; k <= 8; k++) {
        const s = k / 8;
        const qx = (1 - s) ** 2 * x + 2 * (1 - s) * s * cx + s * s * nx;
        const qy = (1 - s) ** 2 * y + 2 * (1 - s) * s * cy + s * s * ny;
        out.push([...P(px, py), ...P(qx, qy)]);
        px = qx;
        py = qy;
      }
      x = nx;
      y = ny;
    } else i++;
  }
  return out;
}

/** Coverage (0..1) per pixel of the shapes in `e` (non-zero winding), 4×4 samples. */
export function coverage(e: Edge[], w: number, h: number): Float64Array {
  const cov = new Float64Array(w * h);
  const n = 4;
  for (let row = 0; row < h * n; row++) {
    const sy = (row + 0.5) / n;
    const hits: [number, number][] = [];
    for (const [x0, y0, x1, y1] of e) {
      if (y0 === y1 || sy < Math.min(y0, y1) || sy >= Math.max(y0, y1)) continue;
      hits.push([x0 + ((sy - y0) / (y1 - y0)) * (x1 - x0), y1 > y0 ? 1 : -1]);
    }
    hits.sort((a, b) => a[0] - b[0]);
    for (let col = 0; col < w * n; col++) {
      const sx = (col + 0.5) / n;
      let wind = 0;
      for (const [hx, dir] of hits) {
        if (hx > sx) break;
        wind += dir;
      }
      if (wind !== 0) cov[Math.floor(row / n) * w + Math.floor(col / n)] += 1 / (n * n);
    }
  }
  return cov;
}

/** A soft shadow under a coverage mask: box-blurred three times, `radius` px. */
export function blur(src: Float64Array, w: number, h: number, radius: number): Float64Array {
  let a = src;
  for (let pass = 0; pass < 3; pass++) {
    const b = new Float64Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += a[y * w + Math.min(w - 1, Math.max(0, x + k))] as number;
        b[y * w + x] = sum / (2 * radius + 1);
      }
    const c = new Float64Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += b[Math.min(h - 1, Math.max(0, y + k)) * w + x] as number;
        c[y * w + x] = sum / (2 * radius + 1);
      }
    a = c;
  }
  return a;
}

/** A soft Forest Green shadow under the layers (8 points of blur, 1 point down), then each mask in its color. */
function inkWithShadow(p: Picture, layers: [Float64Array, RGB][]) {
  const both = (layers[0] as [Float64Array, RGB])[0].map((_, i) =>
    Math.min(
      1,
      layers.reduce((s, [m]) => s + (m[i] as number), 0),
    ),
  );
  const shadow = blur(both, p.w, p.h, Math.round((8 * p.k) / 3));
  for (let yy = 0; yy < p.h; yy++)
    for (let xx = 0; xx < p.w; xx++) {
      const s = (shadow[Math.max(0, yy - p.k) * p.w + xx] as number) * 0.5;
      if (s > 0.002) p.blend(xx, yy, FOREST, s);
    }
  for (let i = 0; i < p.w * p.h; i++) {
    const x = i % p.w;
    const yy = Math.floor(i / p.w);
    for (const [m, color] of layers) p.blend(x, yy, color, m[i] as number);
  }
}

/**
 * The wordmark centred on `cx`, its baseline at `y` (points), `size` points tall: "Ackwire" in white and "AI" in
 * Solar Green, as the logo on a dark page, over a soft shadow.
 */
export function wordmark(p: Picture, cx: number, y: number, size: number) {
  const scale = (size * p.k) / 100;
  const dx = cx * p.k - (WORDMARK.width * scale) / 2;
  const dy = y * p.k;
  inkWithShadow(p, [
    [coverage(edges(WORDMARK.ackwire, scale, dx, dy), p.w, p.h), WHITE],
    [coverage(edges(WORDMARK.ai, scale, dx, dy), p.w, p.h), SOLAR],
  ]);
}
