/**
 * Draws the Windows installer's pictures (src-tauri/installer/installer.nsi, tauri.windows.conf.json) from the
 * agent engine and the sky's tones, so the installer shows the same agent and sky as the app's cover. Run by CI
 * before `tauri build` on Windows (`bun apps/desktop/scripts/installer-art.ts`).
 *
 * Outputs (ignored by git), 24-bit BMPs at twice the size Windows shows them at 100% (the installer scales them
 * to its controls, so they stay sharp at 150% and 200%):
 *   src-tauri/installer/side.bmp       328×628  the welcome page's side (164×314)
 *   src-tauri/installer/side-done.bmp  328×628  the finish page's side: the same, the agent smiling
 *   src-tauri/installer/header.bmp     300×114  the header of the pages between (150×57)
 *
 * No dependencies: the wordmark is Funnel Display Light's outlines (SIL Open Font License 1.1) as path data,
 * filled here, and a tiny BMP writer.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bodyTones, EYE_COLOR, eyeShapes, inBody, toneAt } from "../../../packages/ui/src/agent/engine.js";
import { SKY_TONES } from "../../../packages/ui/src/sky/math";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

type RGB = [number, number, number];

const hex = (h: string): RGB => {
  const n = Number.parseInt(h.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const WHITE: RGB = [255, 255, 255];
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Pixels per point: everything is drawn at twice the size it shows at 100%. */
const K = 2;

class Picture {
  readonly px: Float64Array;
  constructor(
    readonly w: number,
    readonly h: number,
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
}

/* ---------- The sky: ordered dither over a run of tones ---------- */

/** Dithers `tones` over the picture in cells of `cell` points; `at(u, v)` (0..1) picks along the tones. */
function dither(p: Picture, tones: RGB[], at: (u: number, v: number) => number, cell = 2) {
  const size = cell * K;
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
function cloud(p: Picture, x: number, y: number, cell: number, tone: RGB) {
  const shape = ["..XXX...", ".XXXXXX.", "XXXXXXXX"];
  shape.forEach((line, j) => {
    [...line].forEach((c, i) => {
      if (c === "X") p.rect((x + i * cell) * K, (y + j * cell) * K, cell * K, cell * K, tone);
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

/** The agent (color sky, round eyes, 12 cells, as the cover) at (x, y) in points, `size` points wide. */
function agent(p: Picture, x: number, y: number, size: number, happy = false) {
  const s = size * K;
  const ox = x * K;
  const oy = y * K;
  const n = 12;
  const tones = (bodyTones("sky") as string[]).map(hex);
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

/* ---------- The wordmark: "agentes" and ".chat" (60%) in Funnel Display Light ---------- */

/** Outlines at 100 px, baseline at y = 0; ".chat" starts where "agentes" advances to (as the cover sets them). */
const WORDMARK = {
  width: 603.33,
  agentes:
    "M21.5 0.9L21.5 0.9Q13.2 0.9 8.3-3.3Q3.5-7.5 3.5-14.2L3.5-14.2Q3.5-21.3 8.2-25.3Q12.9-29.2 21.8-29.2L21.8-29.2L39.8-29.2L39.8-31.5Q39.8-44.3 26.1-44.3L26.1-44.3Q14.9-44.3 12.7-35.8L12.7-35.8L4.7-35.8Q5.8-43.0 11.6-47.0Q17.4-51.0 26.3-51.0L26.3-51.0Q36.5-51.0 41.9-46.1Q47.3-41.3 47.3-32.1L47.3-32.1L47.3-8.3L51.2-8.3L51.2 0L42.5 0L42.5-7.5L39.0-7.5Q36.4-3.7 31.8-1.4Q27.3 0.9 21.5 0.9ZM22.5-5.6L22.5-5.6Q27.3-5.6 31.2-7.6Q35.2-9.6 37.5-13.0Q39.8-16.3 39.8-20.4L39.8-20.4L39.8-23.2L22.4-23.2Q10.8-23.2 10.8-14.5L10.8-14.5Q10.8-10.4 14.0-8Q17.1-5.6 22.5-5.6ZM83.8 21.0L83.8 21.0Q73.7 21.0 67.3 16.8Q61.0 12.5 59.8 5.0L59.8 5.0L68.2 5.0Q70.5 14.2 83.8 14.2L83.8 14.2Q92.0 14.2 96.4 10.3Q100.8 6.3 100.8-1L100.8-1L100.8-9.5L100.4-9.5Q98.5-5.0 94.0-2.5Q89.5 0 83.5 0L83.5 0Q76.3 0 71.1-3.1Q65.8-6.3 63.0-12.0Q60.2-17.7 60.2-25.5L60.2-25.5Q60.2-37.3 66.5-44.1Q72.8-51.0 83.7-51.0L83.7-51.0Q89.7-51.0 93.9-48.8Q98.2-46.7 100.7-42.5L100.7-42.5L104.2-42.5L104.2-50.0L112.8-50.0L112.8-41.7L108.7-41.7L108.7-0.4Q108.7 9.7 102.1 15.3Q95.6 21.0 83.8 21.0ZM85.3-6.8L85.3-6.8Q92.3-6.8 96.5-10.9Q100.8-15.0 100.8-21.7L100.8-21.7L100.8-29.3Q100.8-36.0 96.5-40.1Q92.3-44.2 85.3-44.2L85.3-44.2Q77.3-44.2 72.6-39.3Q68.0-34.3 68.0-25.5L68.0-25.5Q68.0-16.7 72.6-11.8Q77.3-6.8 85.3-6.8ZM147.0 1L147.0 1Q139.3 1 133.7-2.2Q128.0-5.4 124.9-11.3Q121.8-17.3 121.8-25.2L121.8-25.2Q121.8-33.1 124.9-38.9Q128.0-44.7 133.6-47.8Q139.2-51.0 146.7-51.0L146.7-51.0Q153.8-51.0 158.9-48.1Q164.1-45.3 167.0-40.0Q169.8-34.8 169.8-27.6L169.8-27.6L169.8-24.1L129.3-24.1Q129.7-15.5 134.4-10.7Q139.1-5.8 146.9-5.8L146.9-5.8Q152.3-5.8 156.1-8.2Q159.9-10.5 161.3-14.9L161.3-14.9L169.3-14.9Q167.4-7.3 161.5-3.2Q155.7 1 147.0 1ZM129.8-30.1L129.8-30.1L162.3-30.1Q161.7-36.8 157.5-40.6Q153.3-44.3 146.6-44.3L146.6-44.3Q139.8-44.3 135.4-40.6Q130.9-36.8 129.8-30.1ZM190.8 0L183.0 0L183.0-41.7L178.8-41.7L178.8-50.0L187.5-50.0L187.5-42.5L191.0-42.5Q193.5-46.7 198.0-48.8Q202.6-50.9 208.4-50.9L208.4-50.9Q217.8-50.9 223.4-45.4Q229.0-39.9 229.0-30.8L229.0-30.8L229.0 0L221.2 0L221.2-29.6Q221.2-36.7 217.3-40.4Q213.4-44.1 206.0-44.1L206.0-44.1Q198.7-44.1 194.8-40.4Q190.8-36.7 190.8-29.6L190.8-29.6L190.8 0ZM269.7 0L254.3 0Q250.8 0 248.9-1.8Q246.9-3.6 246.9-7.2L246.9-7.2L246.9-44.0L237.3-44.0L237.3-50.0L247.0-50.0L247.0-65.0L254.7-65.0L254.7-50.0L268.3-50.0L268.3-44.0L254.8-44.0L254.8-6.2L269.7-6.2L269.7 0ZM301.2 1L301.2 1Q293.5 1 287.8-2.2Q282.2-5.4 279.1-11.3Q276-17.3 276-25.2L276-25.2Q276-33.1 279.1-38.9Q282.2-44.7 287.8-47.8Q293.3-51.0 300.8-51.0L300.8-51.0Q307.9-51.0 313.1-48.1Q318.3-45.3 321.1-40.0Q324-34.8 324-27.6L324-27.6L324-24.1L283.5-24.1Q283.8-15.5 288.5-10.7Q293.3-5.8 301.1-5.8L301.1-5.8Q306.5-5.8 310.3-8.2Q314.1-10.5 315.5-14.9L315.5-14.9L323.5-14.9Q321.6-7.3 315.7-3.2Q309.8 1 301.2 1ZM283.9-30.1L283.9-30.1L316.4-30.1Q315.8-36.8 311.7-40.6Q307.5-44.3 300.8-44.3L300.8-44.3Q294-44.3 289.5-40.6Q285.1-36.8 283.9-30.1ZM354.1 1L354.1 1Q343.9 1 338.0-3.2Q332.1-7.4 331.5-15.0L331.5-15.0L339.3-15.0Q339.9-10.2 343.6-7.8Q347.3-5.5 354.3-5.5L354.3-5.5Q367.1-5.5 367.1-13.7L367.1-13.7Q367.1-17.0 365.1-18.8Q363.2-20.6 358.5-21.4L358.5-21.4L347.6-23.4Q334.0-25.9 334.0-36.4L334.0-36.4Q334.0-43.2 339.1-47.1Q344.2-51.0 353.0-51.0L353.0-51.0Q362.1-51.0 367.5-47.0Q373.0-43.0 373.8-35.8L373.8-35.8L366.2-35.8Q365.3-40.3 362.0-42.4Q358.8-44.5 352.9-44.5L352.9-44.5Q347.3-44.5 344.3-42.5Q341.3-40.6 341.3-36.8L341.3-36.8Q341.3-34.0 343.3-32.4Q345.3-30.8 349.7-29.9L349.7-29.9L360.5-27.9Q367.7-26.6 371.0-23.3Q374.3-19.9 374.3-14.3L374.3-14.3Q374.3-7.0 369.1-3.0Q363.8 1 354.1 1Z",
  chat: "M388.3 1L388.3 1Q385.8 1 384.1-0.8Q382.3-2.5 382.3-5.0L382.3-5.0Q382.3-7.5 384.1-9.3Q385.8-11.0 388.3-11.0L388.3-11.0Q390.8-11.0 392.6-9.3Q394.3-7.5 394.3-5.0L394.3-5.0Q394.3-2.5 392.6-0.8Q390.8 1 388.3 1ZM426.7 1L426.7 1Q419.1 1 413.5-2.2Q407.9-5.4 404.9-11.3Q401.8-17.1 401.8-25.0L401.8-25.0Q401.8-32.9 404.8-38.8Q407.8-44.6 413.4-47.8Q419.0-51.0 426.7-51.0L426.7-51.0Q435.6-51.0 441.6-46.6Q447.6-42.3 449.7-33.8L449.7-33.8L441.7-33.8Q440.2-39.2 436.4-41.7Q432.7-44.2 426.7-44.2L426.7-44.2Q418.6-44.2 414.1-39.1Q409.7-34.1 409.7-25.0L409.7-25.0Q409.7-16 414.1-10.9Q418.6-5.8 426.7-5.8L426.7-5.8Q439.2-5.8 442.0-17.0L442.0-17.0L450.0-17.0Q448.0-8.2 441.9-3.6Q435.8 1 426.7 1ZM466.7 0L458.8 0L458.8-70.0L466.7-70.0L466.7-41.7L467.0-41.7Q469.4-46.2 473.9-48.5Q478.3-50.9 484.3-50.9L484.3-50.9Q493.7-50.9 499.3-45.4Q504.8-39.9 504.8-30.8L504.8-30.8L504.8 0L497.0 0L497.0-29.6Q497.0-36.7 493.1-40.4Q489.3-44.1 481.8-44.1L481.8-44.1Q474.5-44.1 470.6-40.4Q466.7-36.7 466.7-29.6L466.7-29.6L466.7 0ZM533.2 0.9L533.2 0.9Q524.8 0.9 520.0-3.3Q515.2-7.5 515.2-14.2L515.2-14.2Q515.2-21.3 519.9-25.3Q524.6-29.2 533.5-29.2L533.5-29.2L551.5-29.2L551.5-31.5Q551.5-44.3 537.8-44.3L537.8-44.3Q526.6-44.3 524.3-35.8L524.3-35.8L516.3-35.8Q517.5-43.0 523.3-47.0Q529.1-51.0 538.0-51.0L538.0-51.0Q548.2-51.0 553.6-46.1Q559.0-41.3 559.0-32.1L559.0-32.1L559.0-8.3L562.8-8.3L562.8 0L554.2 0L554.2-7.5L550.7-7.5Q548.1-3.7 543.5-1.4Q538.9 0.9 533.2 0.9ZM534.2-5.6L534.2-5.6Q538.9-5.6 542.9-7.6Q546.8-9.6 549.2-13.0Q551.5-16.3 551.5-20.4L551.5-20.4L551.5-23.2L534.1-23.2Q522.5-23.2 522.5-14.5L522.5-14.5Q522.5-10.4 525.6-8Q528.8-5.6 534.2-5.6ZM601.3 0L586.0 0Q582.5 0 580.5-1.8Q578.6-3.6 578.6-7.2L578.6-7.2L578.6-44.0L569.0-44.0L569.0-50.0L578.7-50.0L578.7-65.0L586.3-65.0L586.3-50.0L600.0-50.0L600.0-44.0L586.4-44.0L586.4-6.2L601.3-6.2L601.3 0Z",
};

type Edge = [number, number, number, number];

/** M/L/Q/Z path data (absolute, as the outlines above) to line edges, curves flattened. */
function edges(d: string, scale: number, dx: number, dy: number): Edge[] {
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
function coverage(e: Edge[], w: number, h: number): Float64Array {
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
function blur(src: Float64Array, w: number, h: number, radius: number): Float64Array {
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

/** The wordmark centred on `cx`, its baseline at `y` (points), `size` points tall, white with the cover's shadow. */
function wordmark(p: Picture, cx: number, y: number, size: number) {
  const scale = (size * K) / 100;
  const dx = cx * K - (WORDMARK.width * scale) / 2;
  const dy = y * K;
  const main = coverage(edges(WORDMARK.agentes, scale, dx, dy), p.w, p.h);
  const dim = coverage(edges(WORDMARK.chat, scale, dx, dy), p.w, p.h);
  // The cover's text shadow: rgba(4,32,63,.5), 8 px blur, 1 px down.
  const both = main.map((v, i) => Math.min(1, v + (dim[i] as number) * 0.6));
  const shadow = blur(both, p.w, p.h, Math.round((8 * K) / 3));
  for (let yy = 0; yy < p.h; yy++)
    for (let xx = 0; xx < p.w; xx++) {
      const s = (shadow[Math.max(0, yy - K) * p.w + xx] as number) * 0.5;
      if (s > 0.002) p.blend(xx, yy, [4, 32, 63], s);
    }
  for (let i = 0; i < p.w * p.h; i++) {
    const x = i % p.w;
    const yy = Math.floor(i / p.w);
    p.blend(x, yy, WHITE, main[i] as number);
    p.blend(x, yy, WHITE, (dim[i] as number) * 0.6);
  }
}

/* ---------- The three pictures ---------- */

/** The sky's run from deep to light (the cover's sky). */
const SKY = (SKY_TONES as string[]).map(hex);

/** The welcome and finish pages' side (164×314): the whole sky, the agent and the wordmark in the middle. */
function side(done: boolean): Picture {
  const W = 164;
  const H = 314;
  const p = new Picture(W * K, H * K);
  const run = SKY.slice(0, 6);
  dither(p, run, (u, v) => 0.05 + 0.95 * v * v + 0.04 * Math.sin(u * 5));
  cloud(p, 18, 46, 3, run[3] as RGB);
  cloud(p, 112, 92, 2, run[3] as RGB);
  agent(p, (W - 64) / 2, 104, 64, done);
  wordmark(p, W / 2, 200, 21);
  return p;
}

/** The header (150×57), right of the page's title: the sky coming in from the right, the agent on it. */
function header(): Picture {
  const W = 150;
  const H = 57;
  const p = new Picture(W * K, H * K);
  const run = [WHITE, ...SKY.slice(0, 6).reverse()];
  dither(p, run, (u, v) => Math.max(0, (u - 0.18) / 0.82) * 0.85 + 0.06 * (v - 0.5));
  agent(p, W - 50, 11, 36);
  return p;
}

const dir = join(root, "src-tauri", "installer");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "side.bmp"), side(false).bmp());
writeFileSync(join(dir, "side-done.bmp"), side(true).bmp());
writeFileSync(join(dir, "header.bmp"), header().bmp());
console.log("installer art: side.bmp, side-done.bmp and header.bmp written");
