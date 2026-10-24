/**
 * The pixel sky: an ordered-dither (Bayer 4×4) field over a short list of
 * tones, with pixel-art agents drifting up and blinking, a light that follows
 * the pointer, and calm zones behind text (the field settles on one tone there
 * and the sprites pass behind). Ported from the landing (pages/landing/sky.ts)
 * and made palette-agnostic: any agent color, faded from any surface token.
 *
 * One animation loop runs for every sky on the page; a sky off screen or
 * hidden costs nothing. With reduced motion a sky is drawn once (and again
 * on resize or a theme change). Without a 2D context (tests, old browsers)
 * nothing is drawn and the element's CSS background shows.
 */
import {
  blobsAt,
  type CalmZone,
  calmAt,
  ditherIndex,
  drawSprite,
  pixelOf,
  type SkyBlob,
  type SkyFrame,
  spriteTone,
} from "./math";

export { drawSprite, type SkyBlob, type SkyFrame, SPRITE } from "./math";

/** What a sky draws, read again on every frame (so it can change live). */
export interface SkyOptions {
  /** Screen pixels per sky pixel (default 4). */
  pixel?: number;
  /** Tones from deep (0) to light; a function gets the surface color (see `surface`). */
  palette: readonly string[] | ((surface: string) => readonly string[]);
  /** CSS custom property of the surface behind the sky (default `--bg`), resolved on the canvas. */
  surface?: string;
  /** The field at (u, v) in 0..1, at time t (seconds): 0 = first tone, 1 = last. */
  base: (u: number, v: number, t: number) => number;
  blobs?: (t: number) => SkyBlob[];
  /** Time multiplier (default 1): a working agent's sky runs faster. */
  speed?: number;
  /** Pixel agents: a count, or one per `area` sky pixels up to `max`. */
  sprites?: number | { area: number; max: number };
  /** Share of near (double size) sprites (default 0.3). */
  near?: number;
  /** Rise speed multiplier (default 1). */
  rise?: number;
  /** Sprites leave above this fraction of the height (default: the top edge). */
  ceil?: number;
  /** The sprites' body color (their eyes are always white), e.g. `spriteTone(color)`. */
  body?: string;
  /** The pointer light's strength (default 0.22; 0 turns it off) and radius (share of the height). */
  light?: number;
  lightR?: number;
  /** Elements whose box stays calm (text over the sky). */
  calm?: () => (Element | null | undefined)[];
  /** Field value inside calm zones (default 6/7) and the fade around them, in sky pixels. */
  calmV?: number;
  calmPad?: number;
  /** Draws over the field (e.g. one sprite of its own) before the frame is shown. */
  after?: (frame: SkyFrame) => void;
}

const WHITE = pixelOf("#ffffff");

/* ---------- shared state: pointer, theme, motion, one loop ---------- */

const pointer = { x: 0, y: 0 };
let pointerUsers = 0;
const onPointer = (e: PointerEvent) => {
  pointer.x = e.clientX;
  pointer.y = e.clientY;
};
function trackPointer(): () => void {
  if (typeof window === "undefined") return () => {};
  if (pointerUsers++ === 0) {
    pointer.x = window.innerWidth * 0.7;
    pointer.y = window.innerHeight * 0.4;
    window.addEventListener("pointermove", onPointer, { passive: true });
  }
  return () => {
    if (--pointerUsers === 0) window.removeEventListener("pointermove", onPointer);
  };
}

/** Bumps when the theme changes, so skies re-read their surface color. */
let themeVersion = 0;
let themeWatch: MutationObserver | null = null;
function watchTheme() {
  if (themeWatch || typeof MutationObserver === "undefined" || typeof document === "undefined") return;
  themeWatch = new MutationObserver(() => {
    themeVersion++;
    for (const s of live) s.dirty = true;
  });
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
}

export const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface Sky {
  dirty: boolean;
  step(dt: number): void;
}
const live = new Set<Sky>();
let raf = 0;
let last = 0;
const hasRaf = () => typeof requestAnimationFrame === "function";
/** About 30 frames a second: the dither moves in whole cells, more frames only cost. */
const FRAME_MS = 32;
function tick(now: number) {
  if (now - last >= FRAME_MS) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    for (const s of live) s.step(dt);
  }
  raf = live.size && hasRaf() ? requestAnimationFrame(tick) : 0;
}
function wake() {
  if (raf || !hasRaf()) return;
  last = performance.now();
  raf = requestAnimationFrame(tick);
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    const ctx = canvas.getContext("2d");
    return ctx && typeof ctx.createImageData === "function" ? ctx : null;
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

/** Starts a sky on `canvas` (sized to its parent); `get` is read on every frame. Returns the cleanup. */
export function startSky(canvas: HTMLCanvasElement, get: () => SkyOptions): () => void {
  const ctx = context2d(canvas);
  const parent = canvas.parentElement;
  if (!ctx || !parent) return () => {};
  const host: HTMLElement = parent;
  const reduced = prefersReducedMotion();
  let w = 0;
  let h = 0;
  let px = 0;
  let img: ImageData | null = null;
  let buf = new Uint32Array(0);
  let visible = true;
  let t = Math.random() * 50;
  let flock: Sprite[] = [];
  const light = { x: 0.5, y: 0.5 };
  let surfaceAt = -1;
  let surface = "";
  let toneKey = "";
  let tones: number[] = [];

  const spawn = (o: SkyOptions, anywhere: boolean): Sprite => {
    const near = Math.random() < (o.near ?? 0.3);
    return {
      x: Math.random() * w,
      y: anywhere ? Math.random() * h : h + 12,
      k: near ? 2 : 1,
      vy: near ? 7 : 3.5 + Math.random() * 2,
      ph: Math.random() * 6.28,
      blink: Math.random() * 6,
      ghost: !near && Math.random() < 0.5,
    };
  };
  const wanted = (o: SkyOptions) => {
    const s = o.sprites;
    if (!s) return 0;
    if (typeof s === "number") return s;
    return Math.min(s.max, Math.round((w * h) / s.area));
  };
  const resize = () => {
    const r = host.getBoundingClientRect();
    const o = get();
    const P = o.pixel ?? 4;
    const nw = Math.max(4, Math.ceil(r.width / P));
    const nh = Math.max(4, Math.ceil(r.height / P));
    if (!r.width || (nw === w && nh === h && P === px && img)) return;
    w = nw;
    h = nh;
    px = P;
    canvas.width = w;
    canvas.height = h;
    img = ctx.createImageData(w, h);
    buf = new Uint32Array(img.data.buffer);
    flock = Array.from({ length: wanted(o) }, () => spawn(o, true));
    sky.dirty = true;
  };

  function draw(dt: number) {
    if (!img) return;
    const o = get();
    if ((o.pixel ?? 4) !== px) resize();
    t += dt * (o.speed ?? 1);
    // Tones: the surface is read from the tokens once per theme.
    if (typeof o.palette === "function") {
      if (surfaceAt !== themeVersion) {
        surfaceAt = themeVersion;
        surface =
          getComputedStyle(canvas)
            .getPropertyValue(o.surface ?? "--bg")
            .trim() || "#808080";
      }
    }
    const list = typeof o.palette === "function" ? o.palette(surface) : o.palette;
    const key = list.join();
    if (key !== toneKey) {
      toneKey = key;
      tones = list.map(pixelOf);
    }
    const levels = tones.length - 1;
    const r = host.getBoundingClientRect();
    const tx = (pointer.x - r.left) / (r.width || 1);
    const ty = (pointer.y - r.top) / (r.height || 1);
    light.x += (Math.min(1.3, Math.max(-0.3, tx)) - light.x) * 0.05;
    light.y += (Math.min(1.3, Math.max(-0.3, ty)) - light.y) * 0.05;
    const blobs = o.blobs ? o.blobs(t) : [];
    const nb = blobs.length;
    const inv = 1 / h;
    const lk = o.light ?? 0.22;
    const lx = light.x * w;
    const ly = light.y * h;
    const lr = (o.lightR ?? 0.32) * h;
    const lr2 = 1 / (lr * lr);
    const zones: CalmZone[] = [];
    for (const el of o.calm ? o.calm() : []) {
      if (!el) continue;
      const e = el.getBoundingClientRect();
      if (e.right > e.left)
        zones.push([(e.left - r.left) / px, (e.top - r.top) / px, (e.right - r.left) / px, (e.bottom - r.top) / px]);
    }
    const PAD = o.calmPad ?? 22;
    const calmV = o.calmV ?? 6 / 7;
    // Per pixel: the base field, the blobs, the pointer light, the calm zones; then the dither (./math).
    for (let y = 0; y < h; y++) {
      const v = y * inv;
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let f = o.base(x / w, v, t);
        if (nb) f = blobsAt(blobs, x, y, w, h, f);
        if (lk) {
          const ldx = x - lx;
          const ldy = y - ly;
          f += lk * Math.exp(-(ldx * ldx + ldy * ldy) * lr2);
        }
        if (zones.length) {
          const k = calmAt(zones, PAD, x, y);
          if (k) f += (calmV - f) * k;
        }
        buf[row + x] = tones[ditherIndex(f, levels, x, y)] as number;
      }
    }
    // Pixel agents drifting up, with a little parallax and an occasional blink.
    const want = wanted(o);
    while (flock.length < want) flock.push(spawn(o, false));
    if (flock.length > want) flock.length = want;
    const body = pixelOf(o.body ?? spriteTone("sky"));
    // Far agents are faint light silhouettes; near ones are solid, both with white eyes.
    const ghostBody = tones[Math.max(0, levels - 1)] as number;
    const rise = (o.rise ?? 1) * (o.speed ?? 1);
    const top = o.ceil ? h * o.ceil : 0;
    const skip = zones.length ? (x: number, y: number) => calmAt(zones, PAD, x, y) > 0.35 : undefined;
    const mx = tx - 0.5;
    for (let i = 0; i < flock.length; i++) {
      const p = flock[i] as Sprite;
      p.y -= p.vy * rise * dt;
      p.ph += dt * 0.7;
      p.blink -= dt;
      if (p.blink < -0.16) p.blink = 3 + Math.random() * 6;
      if (p.y < -12 * p.k || (top && p.y < top)) {
        flock[i] = spawn(o, false);
        continue;
      }
      const ox = Math.round(p.x + Math.sin(p.ph) * 2 * p.k - mx * 10 * p.k);
      drawSprite({ buf, w, h }, ox, Math.round(p.y), p.k, p.ghost ? ghostBody : body, WHITE, p.blink < 0, skip);
    }
    o.after?.({ buf, w, h, t, tones });
    ctx?.putImageData(img, 0, 0);
  }

  const sky: Sky = {
    dirty: true,
    step(dt) {
      if (!visible || !canvas.isConnected || canvas.offsetParent === null) return;
      // Behind a full-screen menu (MenuOverlay) the app is blurred: hold still there.
      if (document.documentElement.dataset.menuOverlay !== undefined && !canvas.closest(".ac-mo")) return;
      if (!img) resize();
      if (reduced && !sky.dirty) return;
      draw(reduced ? 0 : dt);
      sky.dirty = false;
    },
  };

  const untrack = trackPointer();
  watchTheme();
  resize();
  const observers: { disconnect(): void }[] = [];
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => resize());
    ro.observe(host);
    observers.push(ro);
  }
  if (typeof IntersectionObserver !== "undefined") {
    const io = new IntersectionObserver(([e]) => {
      visible = e?.isIntersecting ?? true;
    });
    io.observe(host);
    observers.push(io);
  }
  live.add(sky);
  wake();
  sky.step(0);
  return () => {
    live.delete(sky);
    untrack();
    for (const o of observers) o.disconnect();
  };
}

/** Marks every sky for a redraw (reduced motion draws only on demand). */
export function redrawSkies() {
  for (const s of live) s.dirty = true;
}
