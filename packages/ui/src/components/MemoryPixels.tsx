import { useEffect, useRef } from "react";
import { bodyTones, drawAgent, mixHex } from "../agent/engine.js";
import type { AgentAppearance } from "./AgentLook";
import { reduced, token } from "./RunPixels";

/** An open pixel book: P page, L text line, C the cover (agent's tone), S the spine. */
const BOOK = ["..PPPP.PPPP..", ".PLLLPSPLLLP.", ".PLLPPSPLLPP.", "CPPPPPSPPPPPC", ".CCCCCSCCCCC."];
const W = 30;
const H = 24;

function draw(canvas: HTMLCanvasElement, look: AgentAppearance, at: number, anim: boolean) {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    return;
  }
  if (!ctx) return;
  const k = Math.min(2, typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
  const w = Math.round(W * k);
  const h = Math.round(H * k);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.clearRect(0, 0, w, h);
  const color = look.color ?? "sky";
  // Eyes down on the page; a blink now and then while it moves.
  const blink = anim && at % 1.8 > 1.62;
  const s = 20 * k;
  drawAgent(ctx, (w - s) / 2, 0, s, {
    color,
    eyes: look.eyes,
    cells: 10,
    pose: { blink, look: [0, 0.06], turn: [0, 0.12] },
  });
  const tones = bodyTones(color);
  const u = 2 * k;
  const ox = Math.round((w - 13 * u) / 2);
  const oy = h - 5 * u;
  const page = token(canvas, "--book-page", "#fffdf6");
  const line = token(canvas, "--book-line", "#cfc8b6");
  const fill: Record<string, string | undefined> = { P: page, L: line, C: tones[1], S: tones[0] };
  BOOK.forEach((row, y) => {
    [...row].forEach((c, x) => {
      const f = fill[c];
      if (!f || !ctx) return;
      ctx.fillStyle = f;
      ctx.fillRect(ox + x * u, oy + y * u, u, u);
    });
  });
  if (!anim) return;
  // The page flip: one page lifts on the right, narrows over the spine and lands on the left.
  const f = (at % 1.4) / 1.1;
  if (f >= 1) return;
  const pw = Math.max(1, Math.round(5 * Math.abs(Math.cos(Math.PI * f))));
  const lift = pw <= 2 ? 1 : 0;
  ctx.fillStyle = mixHex(page, line, 0.22);
  for (let j = 0; j < pw; j++) {
    const x = f < 0.5 ? 7 + j : 5 - j;
    ctx.fillRect(ox + x * u, oy - lift * u, u, (4 + lift - (j === pw - 1 ? 1 : 0)) * u);
  }
}

/**
 * The memory mark's picture (telas/ReacoesAgente.html): the agent, drawn by
 * the agent engine in its own colors, reading an open pixel book. It moves
 * once when it appears and while `active` (hover or focus): a page turns and
 * the agent blinks. Still with reduced motion. Decorative: the caller names it.
 */
export function AgentReadingBook({ appearance, active = false }: { appearance?: AgentAppearance; active?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const look = useRef(appearance ?? {});
  look.current = appearance ?? {};
  const since = useRef(typeof performance === "object" ? performance.now() : 0);
  const mounted = useRef(since.current);
  useEffect(() => {
    if (active) since.current = performance.now();
  }, [active]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: redraw when the look or hover changes
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const still = reduced() || typeof requestAnimationFrame !== "function";
    let raf = 0;
    const frame = (now: number) => {
      const intro = (now - mounted.current) / 1000 < 1.1;
      const anim = !still && (active || intro);
      const at = (now - (active ? since.current : mounted.current)) / 1000;
      draw(el, look.current, at, anim);
      if (anim) raf = requestAnimationFrame(frame);
    };
    if (still) draw(el, look.current, 0, false);
    else raf = requestAnimationFrame(frame);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [active, appearance?.color, appearance?.eyes]);
  return <canvas ref={canvas} className="ac-book-mark" width={W} height={H} />;
}
