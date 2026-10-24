/**
 * The pixel sky: an ordered-dither (Bayer 4×4) field in an 8-tone sky palette,
 * with pixel-art agents drifting up and blinking, a light that follows the
 * pointer, and calm zones behind the text (the field settles on palette level
 * 6/7 there and the sprites pass behind). Every canvas call is guarded: without a 2D
 * context (tests, old browsers) nothing is drawn and the CSS background shows.
 */
import { type AgentColor, SPRITE, spriteTone } from "@agenteschat/ui";
import { GRAD } from "./data";

/** "#rrggbb" → a little-endian RGBA pixel for a Uint32Array over ImageData. */
export const hex = (h: string) => {
  const n = Number.parseInt(h.slice(1), 16);
  return ((255 << 24) | ((n & 255) << 16) | (((n >> 8) & 255) << 8) | (n >> 16)) >>> 0;
};
export const SKY = ["#0a3f9c", "#0f56c4", "#2b74e6", "#4b93ff", "#78b4ff", "#a6cfff", "#cfe6ff", "#eef7ff"].map(hex);
const WHITE = hex("#ffffff");
// Eyes are white on every agent; the near pixel agents get a navy body so they show.
const BODY = hex(spriteTone("sky"));
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
// The pixel agent comes from the agent engine (same shape and eyes as every agent).

/** The pointer, shared by every sky (one listener while any sky is mounted). */
export const pointer = { x: 0, y: 0 };
let listeners = 0;
const onPointer = (e: PointerEvent) => {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
};
export function trackPointer(): () => void {
  if (typeof window === "undefined") return () => {};
  if (listeners++ === 0) {
    pointer.x = window.innerWidth * 0.7;
    pointer.y = window.innerHeight * 0.4;
    window.addEventListener("pointermove", onPointer, { passive: true });
  }
  return () => {
    if (--listeners === 0) window.removeEventListener("pointermove", onPointer);
  };
}

/** A blob: [x, y, spread, strength] in 0..1 units of the panel. */
export type Blob = [number, number, number, number];

export interface SkyOptions {
  /** Screen pixels per sky pixel. */
  pixel?: number;
  sprites?: boolean;
  /** Field value inside the calm zones (6/7: exactly palette level 6). */
  calmV?: number;
  lightR?: number;
  calm?: () => (Element | null | undefined)[];
  /** Elements with a round light halo (calm level) around them, so a dithered agent reads on the sky. */
  halo?: () => (Element | null | undefined)[];
  base: (u: number, v: number) => number;
  blobs: (t: number) => Blob[];
}

const S = Math.sin;
const C = Math.cos;

/** Hero: light at the top-left (the headline), deep blue at the bottom-right (where the giant rises). */
export const HERO_SKY: Pick<SkyOptions, "base" | "blobs"> = {
  base: (u, v) => 0.84 - 0.42 * u - 0.48 * v,
  blobs: (t) => [
    [0.18 + 0.06 * S(t * 0.21), 0.2 + 0.05 * C(t * 0.17), 0.12, 0.18],
    [0.62 + 0.08 * S(t * 0.13), 0.35 + 0.08 * C(t * 0.19), 0.08, 0.16],
    [0.86 + 0.05 * C(t * 0.15), 0.92 + 0.04 * S(t * 0.23), 0.16, -0.3],
    [0.42 + 0.1 * C(t * 0.11), 0.95 + 0.04 * S(t * 0.2), 0.1, -0.16],
    [0.95 + 0.03 * S(t * 0.27), 0.18 + 0.06 * C(t * 0.14), 0.05, 0.14],
  ],
};

/** Closing: light on top for the text, deeper toward the crew at the bottom. */
export const CLOSING_SKY: Pick<SkyOptions, "base" | "blobs"> = {
  base: (u, v) => 0.82 - 0.6 * v - 0.08 * Math.abs(u - 0.5),
  blobs: (t) => [
    [0.5 + 0.1 * S(t * 0.15), 0.25 + 0.05 * C(t * 0.2), 0.14, 0.14],
    [0.15 + 0.05 * C(t * 0.18), 0.9, 0.08, -0.14],
    [0.85 + 0.05 * S(t * 0.16), 0.88, 0.08, -0.14],
  ],
};

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext("2d");
  } catch {
    return null;
  }
}

interface Sprite {
  x: number;
  y: number;
  k: number;
  vy: number;
  ph: number;
  blink: number;
  ghost: boolean;
}

/** Starts a sky on `canvas` (sized to its parent). Returns the cleanup. */
export function startSky(canvas: HTMLCanvasElement, getOptions: () => SkyOptions, reduced: boolean): () => void {
  const ctx = context2d(canvas);
  const host = canvas.parentElement;
  if (!ctx || !host || typeof ctx.createImageData !== "function") return () => {};
  const P = getOptions().pixel ?? 4;
  let w = 0;
  let h = 0;
  let img: ImageData | null = null;
  let buf = new Uint32Array(0);
  let raf = 0;
  let visible = true;
  let last = performance.now();
  let t = Math.random() * 50;
  let flock: Sprite[] = [];
  const light = { x: 0.5, y: 0.5 };
  const raf$ = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;

  function spawn(anywhere: boolean): Sprite {
    const near = Math.random() < 0.15;
    return {
      x: Math.random() * w,
      y: anywhere ? Math.random() * h : h + 12,
      k: near ? 2 : 1,
      vy: near ? 7 : 3.5 + Math.random() * 2,
      ph: Math.random() * 6.28,
      blink: Math.random() * 6,
      ghost: !near && Math.random() < 0.5,
    };
  }
  function resize() {
    const r = host?.getBoundingClientRect();
    if (!r) return;
    w = Math.max(4, Math.ceil(r.width / P));
    h = Math.max(4, Math.ceil(r.height / P));
    canvas.width = w;
    canvas.height = h;
    img = ctx?.createImageData(w, h) ?? null;
    buf = img ? new Uint32Array(img.data.buffer) : new Uint32Array(0);
    const n = getOptions().sprites ? Math.min(18, Math.round((w * h) / 2000)) : 0;
    flock = Array.from({ length: n }, () => spawn(true));
  }
  function frame(now: number) {
    if (!img || !host) return;
    const opts = getOptions();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    const r = host.getBoundingClientRect();
    const tx = (pointer.x - r.left) / (r.width || 1);
    const ty = (pointer.y - r.top) / (r.height || 1);
    light.x += (Math.min(1.3, Math.max(-0.3, tx)) - light.x) * 0.05;
    light.y += (Math.min(1.3, Math.max(-0.3, ty)) - light.y) * 0.05;
    const blobs = opts.blobs(t);
    const nb = blobs.length;
    const inv = 1 / h;
    const levels = SKY.length - 1;
    const lx = light.x * w;
    const ly = light.y * h;
    const lr = (opts.lightR ?? 0.32) * h;
    const lr2 = 1 / (lr * lr);
    // Calm zones: behind the text the sky settles on one light tone, and sprites pass behind.
    const zones: [number, number, number, number][] = [];
    for (const el of opts.calm ? opts.calm() : []) {
      if (!el) continue;
      const e = el.getBoundingClientRect();
      const z: [number, number, number, number] = [
        (e.left - r.left) / P,
        (e.top - r.top) / P,
        (e.right - r.left) / P,
        (e.bottom - r.top) / P,
      ];
      if (z[2] > z[0]) zones.push(z);
    }
    // Halos: full calm out to 55% of the radius, fading to the sky at 0.8 × the element's width.
    const rings: [number, number, number][] = [];
    for (const el of opts.halo ? opts.halo() : []) {
      if (!el) continue;
      const e = el.getBoundingClientRect();
      if (e.width > 0)
        rings.push([(e.left + e.width / 2 - r.left) / P, (e.top + e.height / 2 - r.top) / P, (e.width * 0.8) / P]);
    }
    const PAD = 26;
    const calmV = opts.calmV ?? 0.9;
    const calmAt = (x: number, y: number) => {
      let k = 0;
      for (const [cx, cy, rad] of rings) {
        const q = Math.min(1, Math.max(0, (rad - Math.hypot(x - cx, y - cy)) / (rad * 0.45)));
        const s2 = q * q * (3 - 2 * q);
        if (s2 > k) k = s2;
      }
      for (const z of zones) {
        const dx = x < z[0] ? z[0] - x : x > z[2] ? x - z[2] : 0;
        const dy = y < z[1] ? z[1] - y : y > z[3] ? y - z[3] : 0;
        if (dx > PAD || dy > PAD) continue;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < PAD) {
          const q = 1 - d / PAD;
          const s2 = q * q * (3 - 2 * q);
          if (s2 > k) k = s2;
        }
      }
      return k;
    };
    for (let y = 0; y < h; y++) {
      const v = y * inv;
      const row = y * w;
      const by = (y & 3) << 2;
      for (let x = 0; x < w; x++) {
        let f = opts.base(x / w, v);
        for (let i = 0; i < nb; i++) {
          const b = blobs[i] as Blob;
          const dx = (x - b[0] * w) * inv;
          const dy = (y - b[1] * h) * inv;
          f += b[3] * Math.exp(-(dx * dx + dy * dy) / b[2]);
        }
        const ldx = x - lx;
        const ldy = y - ly;
        f += 0.22 * Math.exp(-(ldx * ldx + ldy * ldy) * lr2);
        if (zones.length || rings.length) {
          const k = calmAt(x, y);
          if (k) f += (calmV - f) * k;
        }
        f = f < 0 ? 0 : f > 1 ? 1 : f;
        const s = f * levels;
        const base = s | 0;
        const idx = s - base > (BAYER[by | (x & 3)] ?? 0.5) ? base + 1 : base;
        buf[row + x] = SKY[idx > levels ? levels : idx] as number;
      }
    }
    // Pixel agents drifting up, with a little parallax and an occasional blink.
    const mx = tx - 0.5;
    for (let i = 0; i < flock.length; i++) {
      const p = flock[i] as Sprite;
      p.y -= p.vy * dt;
      p.ph += dt * 0.7;
      p.blink -= dt;
      if (p.blink < -0.16) p.blink = 3 + Math.random() * 6;
      if (p.y < -12 * p.k) {
        flock[i] = spawn(false);
        continue;
      }
      const ox = Math.round(p.x + Math.sin(p.ph) * 2 * p.k - mx * 10 * p.k);
      const oy = Math.round(p.y);
      const closed = p.blink < 0;
      for (let sy = 0; sy < 9; sy++) {
        const line = SPRITE[sy] as string;
        for (let sx = 0; sx < 9; sx++) {
          const c = line[sx];
          if (c === ".") continue;
          let col = p.ghost ? (SKY[levels - 1] as number) : BODY;
          if (c === "o" && !(closed && sy === 3)) col = WHITE;
          for (let ky = 0; ky < p.k; ky++)
            for (let kx = 0; kx < p.k; kx++) {
              const X = ox + sx * p.k + kx;
              const Y = oy + sy * p.k + ky;
              if (X >= 0 && X < w && Y >= 0 && Y < h && !((zones.length || rings.length) && calmAt(X, Y) > 0.35))
                buf[Y * w + X] = col;
            }
        }
      }
    }
    ctx?.putImageData(img, 0, 0);
    if (visible && !reduced && raf$) raf = raf$(frame);
  }

  resize();
  const observers: { disconnect(): void }[] = [];
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      resize();
      if (reduced || !visible) frame(performance.now());
    });
    ro.observe(host);
    observers.push(ro);
  }
  if (typeof IntersectionObserver !== "undefined") {
    const io = new IntersectionObserver(([e]) => {
      visible = e?.isIntersecting ?? true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (visible && !reduced && raf$) {
        last = performance.now();
        raf = raf$(frame);
      }
    });
    io.observe(host);
    observers.push(io);
  }
  frame(performance.now());
  return () => {
    visible = false;
    if (raf) cancelAnimationFrame(raf);
    for (const o of observers) o.disconnect();
  };
}

const mix = (a: string, b: string, k: number) => {
  const p = (h: string) => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  const A = p(a);
  const B = p(b);
  return `#${A.map((v, i) =>
    Math.round(v + ((B[i] ?? 0) - v) * k)
      .toString(16)
      .padStart(2, "0"),
  ).join("")}`;
};

/** The maker's glow: from the page's darkest surface to the chosen color's top. */
export function glowPalette(color: AgentColor, theme: "light" | "dark"): number[] {
  const [top, bottom] = color === "sky" ? ["#8cc3ff", "#0063d1"] : GRAD[color];
  const dark = theme === "light" ? "#ebebe7" : "#0a0a09";
  return [
    dark,
    mix(dark, bottom, 0.25),
    mix(dark, bottom, 0.5),
    mix(dark, bottom, 0.75),
    bottom,
    mix(bottom, top, 0.5),
  ].map(hex);
}

/** Draws the maker's dithered glow once (call again on resize or a new palette). */
export function drawGlow(canvas: HTMLCanvasElement, palette: number[]) {
  const ctx = context2d(canvas);
  const host = canvas.parentElement;
  if (!ctx || !host || typeof ctx.createImageData !== "function") return;
  const P = 5;
  const r = host.getBoundingClientRect();
  const w = Math.max(1, Math.ceil(r.width / P));
  const h = Math.max(1, Math.ceil(r.height / P));
  canvas.width = w;
  canvas.height = h;
  const img = ctx.createImageData(w, h);
  const buf = new Uint32Array(img.data.buffer);
  const levels = palette.length - 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const dx = (x - w / 2) / h;
      const dy = (y - h * 0.52) / h;
      const f = Math.max(0, Math.min(1, 0.95 * Math.exp(-(dx * dx + dy * dy) / 0.09)));
      const s = f * levels;
      const base = s | 0;
      const idx = s - base > (BAYER[((y & 3) << 2) | (x & 3)] ?? 0.5) ? base + 1 : base;
      buf[y * w + x] = palette[Math.min(levels, idx)] as number;
    }
  ctx.putImageData(img, 0, 0);
}
