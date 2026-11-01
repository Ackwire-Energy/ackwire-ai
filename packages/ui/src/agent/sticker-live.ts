/**
 * Living stickers (ADR 0091): one shared loop draws every sticker on screen, about 25 times a second, and only the
 * ones in view (a picker full of them, or a long conversation, costs what is visible). With reduced motion the loop
 * stands still: each sticker is drawn once, at its still frame, and again when what it shows changes.
 */
import { drawSticker, STICKER_STILL_T, type StickerLook, type StickerMood } from "./stickers";

export interface LiveSticker {
  canvas: HTMLCanvasElement;
  /** Read at each frame: what to draw, and the canvas's side in CSS pixels. */
  spec: () => { look: StickerLook; mood: StickerMood; size: number; seed: number };
}

const stickers = new Set<LiveSticker>();
const visible = new WeakSet<HTMLCanvasElement>();
let raf = 0;
let last = 0;
let observer: IntersectionObserver | null = null;
/** The gap between frames (ms). */
const FRAME_MS = 40;

let motionQuery: MediaQueryList | null | undefined;
const reduced = () => {
  if (motionQuery === undefined) {
    motionQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    // Motion allowed again: the loop starts; asked to stop: every sticker stands at its still frame.
    motionQuery?.addEventListener?.("change", () => {
      if (!motionQuery?.matches) start();
      else for (const s of stickers) drawLiveSticker(s, STICKER_STILL_T);
    });
  }
  return motionQuery?.matches === true;
};

const now = () => (typeof performance === "object" ? performance.now() : Date.now()) / 1000;

/** How many stickers the loop is drawing (tests). */
export function liveStickerCount() {
  return stickers.size;
}

/** Draws one sticker now, at `t` seconds (its seed added), sizing its canvas to the screen's pixels. */
export function drawLiveSticker(sticker: LiveSticker, t: number) {
  const { canvas } = sticker;
  const { look, mood, size, seed } = sticker.spec();
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    return;
  }
  if (!ctx) return;
  const dpr = Math.min(2, typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1);
  const side = Math.max(1, Math.round(size * dpr));
  if (canvas.width !== side || canvas.height !== side) {
    canvas.width = side;
    canvas.height = side;
  }
  ctx.clearRect(0, 0, side, side);
  drawSticker(ctx, look, mood, reduced() ? STICKER_STILL_T : t + seed, side);
}

function tick(time: number) {
  raf = 0;
  if (time - last >= FRAME_MS) {
    last = time;
    const t = time / 1000;
    for (const s of stickers) if (visible.has(s.canvas)) drawLiveSticker(s, t);
  }
  if (stickers.size && !reduced()) raf = requestAnimationFrame(tick);
}

function start() {
  if (!raf && stickers.size && !reduced() && typeof requestAnimationFrame === "function")
    raf = requestAnimationFrame(tick);
}

/** Starts drawing a sticker (in view only); returns the cleanup. */
export function addLiveSticker(sticker: LiveSticker): () => void {
  stickers.add(sticker);
  if (typeof IntersectionObserver === "function") {
    observer ??= new IntersectionObserver((entries) => {
      for (const e of entries) {
        const canvas = e.target as HTMLCanvasElement;
        if (!e.isIntersecting) {
          visible.delete(canvas);
          continue;
        }
        visible.add(canvas);
        // Standing still: drawn once as it comes into view (it may have changed while away).
        if (reduced()) for (const s of stickers) if (s.canvas === canvas) drawLiveSticker(s, STICKER_STILL_T);
      }
    });
    observer.observe(sticker.canvas);
  } else visible.add(sticker.canvas);
  drawLiveSticker(sticker, now());
  start();
  return () => {
    stickers.delete(sticker);
    observer?.unobserve(sticker.canvas);
    visible.delete(sticker.canvas);
    if (stickers.size === 0 && raf && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}
