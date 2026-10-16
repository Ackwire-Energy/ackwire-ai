import { useEffect, useRef } from "react";
import { AGENT_GRADIENTS, bodyTones, mixHex, spriteGrid } from "../agent/engine.js";
import { cx } from "../cx";
import type { AgentColor, AgentEyes } from "./AgentLook";

/**
 * A routine's runs in pixels (telas/Rotinas.html): each run is a dithered
 * column in the agent's own tones on a 2px grid. Height is the run's cost
 * (`weight`, 0–1, a share of the priciest recent run); nothing new is a
 * stub; a failure a column in the danger tone; a skip a short warm one.
 * Decorative canvases (nothing to read): the caller gives the words, an
 * `aria-label` on a `role="img"` wrapper.
 */
export type RunPixelStatus = "ok" | "silent" | "failed" | "skipped";
export interface RunPixel {
  status: RunPixelStatus;
  /** 0–1. */
  weight?: number;
  at?: string | Date;
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const CELL = 2;

const reduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches === true;

function token(el: Element, name: string, fallback: string) {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return /^#[0-9a-f]{3,8}$/i.test(v) ? v : fallback;
}

/** Bayer between a column's tones: deep at the base, light at the top. */
function column(ctx: CanvasRenderingContext2D, x0: number, w: number, h: number, base: number, pal: string[]) {
  const last = pal.length - 1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const f = h <= 1 ? 0.5 : 1 - y / (h - 1);
      const s = f * last;
      const b = Math.floor(s);
      const idx = s - b > (BAYER[((y & 3) << 2) | ((x0 + x) & 3)] ?? 0.5) ? b + 1 : b;
      ctx.fillStyle = pal[Math.min(last, idx)] ?? pal[0] ?? "#888888";
      ctx.fillRect(x0 + x, base - y, 1, 1);
    }
}

interface Palette {
  ok: string[];
  silent: string[];
  failed: string[];
  skipped: string[];
  dot: string;
  future: string;
}
function paletteFor(el: Element, color: AgentColor): Palette {
  const tones = bodyTones(color);
  const raised = token(el, "--raised", "#ffffff");
  const danger = token(el, "--danger", "#b42a20");
  const warn = token(el, "--warn", "#9a5b00");
  const t = (i: number) => tones[i] ?? "#888888";
  return {
    ok: [t(1), t(1), t(2), t(3)],
    silent: [mixHex(t(3), raised, 0.35), t(4)],
    failed: [danger, danger, mixHex(danger, raised, 0.45)],
    skipped: [warn, mixHex(warn, raised, 0.4)],
    dot: token(el, "--line-strong", "#cfcfc9"),
    future: mixHex(t(3), raised, 0.25),
  };
}

function drawRun(
  ctx: CanvasRenderingContext2D,
  p: Palette,
  x0: number,
  w: number,
  rows: number,
  base: number,
  run: RunPixel,
) {
  const tall = (min: number) => Math.max(min, Math.round(min + (run.weight ?? 1) * (rows - min)));
  if (run.status === "ok") column(ctx, x0, w, tall(Math.ceil(rows * 0.4)), base, p.ok);
  else if (run.status === "silent") column(ctx, x0, w, 2, base, p.silent);
  else if (run.status === "failed") column(ctx, x0, w, rows, base, p.failed);
  else column(ctx, x0, w, Math.ceil(rows * 0.4), base, p.skipped);
}

/** A run in progress: cells arriving in the sky's light end, flickering. */
function drawWorking(ctx: CanvasRenderingContext2D, x0: number, w: number, rows: number, base: number, t: number) {
  const [top, bottom] = AGENT_GRADIENTS.sky;
  const sky = [bottom, top, mixHex(top, "#ffffff", 0.5)];
  const h = 3 + Math.round((Math.sin(t * 5) + 1) * ((rows - 3) / 2));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if ((x * 7 + y * 13 + Math.floor(t * 12)) % 5 === 0) continue;
      ctx.fillStyle = sky[Math.min(2, Math.floor((y / h) * 3))] ?? bottom;
      ctx.fillRect(x0 + x, base - y, 1, 1);
    }
}

/** Runs a draw function: once (reduced motion, nothing moving) or about 12 times a second while mounted. */
function useCanvas(
  draw: (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, t: number) => void,
  moving: boolean,
) {
  const ref = useRef<HTMLCanvasElement>(null);
  const fn = useRef(draw);
  fn.current = draw;
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext?.("2d");
    if (!canvas || !ctx) return;
    const paint = () => fn.current(ctx, canvas, performance.now() / 1000);
    paint();
    if (!moving || reduced()) return;
    const timer = setInterval(() => {
      if (!document.hidden && canvas.isConnected) paint();
    }, 80);
    return () => clearInterval(timer);
  });
  return ref;
}

/** The last runs as a strip of pixel columns, oldest left; empty slots are a dot on the line. */
export function RunStrip({
  runs,
  color = "sky",
  slots = 14,
  running = false,
  className,
}: {
  /** Newest first (as the API sends them). */
  runs: RunPixel[];
  color?: AgentColor;
  slots?: number;
  /** The newest slot shows a run in progress. */
  running?: boolean;
  className?: string;
}) {
  const COLW = 3;
  const GAP = 1;
  const ROWS = 10;
  const width = slots * (COLW + GAP) - GAP;
  const ref = useCanvas((ctx, canvas, t) => {
    const p = paletteFor(canvas, color);
    ctx.clearRect(0, 0, width, ROWS);
    const shown = runs.slice(0, slots - (running ? 1 : 0)).reverse();
    const pad = slots - shown.length - (running ? 1 : 0);
    for (let i = 0; i < pad; i++) {
      ctx.fillStyle = p.dot;
      ctx.fillRect(i * (COLW + GAP) + 1, ROWS - 1, 1, 1);
    }
    shown.forEach((run, j) => {
      drawRun(ctx, p, (pad + j) * (COLW + GAP), COLW, ROWS, ROWS - 1, run);
    });
    if (running) drawWorking(ctx, (slots - 1) * (COLW + GAP), COLW, ROWS, ROWS - 1, t);
  }, running);
  return (
    <canvas
      ref={ref}
      className={cx("ac-run-strip", className)}
      width={width}
      height={ROWS}
      style={{ width: width * CELL, height: ROWS * CELL }}
    />
  );
}

const SPRITES = new Map<string, string[]>();
const spriteOf = (eyes: string) => {
  let g = SPRITES.get(eyes);
  if (!g) {
    g = spriteGrid(9, eyes);
    SPRITES.set(eyes, g);
  }
  return g;
};

/**
 * One routine's lane on the time horizon: a dotted line, past runs as small
 * columns, future runs as single pixels in the agent's light tone and the
 * next one as the agent itself, a pixel sprite on the line (it blinks and
 * hops). While it runs the sprite stands at "now" writing.
 */
export function RunLane({
  from,
  to,
  now,
  past,
  future,
  color = "sky",
  eyes = "round",
  running = false,
  className,
}: {
  from: Date;
  to: Date;
  now: Date;
  past: (RunPixel & { at: string | Date })[];
  future: (string | Date)[];
  color?: AgentColor;
  eyes?: AgentEyes;
  running?: boolean;
  className?: string;
}) {
  const ROWS = 15;
  const BASE = 11;
  const ref = useCanvas((ctx, canvas, t) => {
    const w = Math.max(10, Math.round(canvas.clientWidth / CELL) || 300);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== ROWS) canvas.height = ROWS;
    const span = to.getTime() - from.getTime() || 1;
    const X = (d: string | Date) => Math.round(((new Date(d).getTime() - from.getTime()) / span) * (w - 1));
    const p = paletteFor(canvas, color);
    ctx.clearRect(0, 0, w, ROWS);
    for (let x = 0; x < w; x += 2) {
      ctx.fillStyle = p.dot;
      ctx.fillRect(x, BASE + 1, 1, 1);
    }
    for (const run of past) drawRun(ctx, p, X(run.at) - 1, 2, 8, BASE, run);
    const next = running ? undefined : future[0];
    for (const d of future) {
      if (d === next) continue;
      ctx.fillStyle = p.future;
      ctx.fillRect(X(d), BASE, 1, 1);
    }
    const cx0 = running ? X(now) + 6 : next !== undefined ? Math.max(X(next), X(now) + 6) : null;
    if (cx0 === null) return;
    const tones = bodyTones(color);
    const grid = spriteOf(eyes);
    const still = reduced();
    const seed = color.length + eyes.length;
    const hop = !running && !still && (t * 1.3 + seed) % 3 < 0.35 ? 1 : 0;
    const blink = !still && (t + seed * 0.7) % 4.2 < 0.14;
    const top = BASE - 8 - hop;
    grid.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const c = row[x];
        if (c === ".") continue;
        if (c === "o")
          ctx.fillStyle = running
            ? y === 4
              ? "#ffffff"
              : (tones[1] ?? "#000")
            : blink
              ? (tones[1] ?? "#000")
              : "#ffffff";
        else {
          const s = (1 - y / 8) * 3;
          const b = Math.floor(s);
          ctx.fillStyle =
            tones[Math.min(4, 1 + (s - b > (BAYER[((y & 3) << 2) | (x & 3)] ?? 0.5) ? b + 1 : b))] ?? "#888";
        }
        ctx.fillRect(cx0 - 4 + x, top + y, 1, 1);
      }
    });
  }, true);
  return <canvas ref={ref} className={cx("ac-run-lane", className)} />;
}

/** A legend key (3×5 cells) in neutral tones, for the horizon's legend. */
export function RunKey({ status }: { status: RunPixelStatus | "next" }) {
  const ref = useCanvas((ctx, canvas) => {
    const p = paletteFor(canvas, "graphite");
    ctx.clearRect(0, 0, 3, 5);
    if (status === "next") {
      ctx.fillStyle = p.future;
      ctx.fillRect(1, 4, 1, 1);
    } else drawRun(ctx, p, 0, 3, 5, 4, { status, weight: 1 });
  }, false);
  return <canvas ref={ref} className="ac-run-key" width={3} height={5} />;
}
