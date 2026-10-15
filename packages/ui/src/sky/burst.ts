/**
 * A short burst of pixels (and a few pixel agents) from a point on screen,
 * for the moments that unblock work (an approval). It draws for about a
 * second on a fixed canvas around the point (so the element that started it
 * may re-render or go away) and then removes it. Reduced motion or no 2D
 * context: nothing happens.
 */
import { prefersReducedMotion, SPRITE } from "./engine";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  size: number;
  sprite: boolean;
}

/** `at` in viewport coordinates; `tones` the agent's colors; `eye` the sprites' eye color. */
export function pixelBurst(at: { x: number; y: number }, tones: readonly string[], eye: string) {
  if (prefersReducedMotion() || typeof requestAnimationFrame !== "function" || typeof document === "undefined") return;
  const canvas = document.createElement("canvas");
  const ctx = context2d(canvas);
  if (!ctx || tones.length === 0) return;
  const P = 3;
  const W = 420;
  const H = 300;
  canvas.className = "ac-sky-burst";
  canvas.setAttribute("aria-hidden", "true");
  canvas.width = W / P;
  canvas.height = H / P;
  canvas.style.left = `${Math.round(at.x - W / 2)}px`;
  canvas.style.top = `${Math.round(at.y - H * 0.75)}px`;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  document.body.append(canvas);
  const cx = W / P / 2;
  const cy = (H * 0.75) / P;
  const parts: Particle[] = [];
  for (let i = 0; i < 64; i++) {
    const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;
    const sp = 20 + Math.random() * 70;
    parts.push({
      x: cx,
      y: cy,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: 0.6 + Math.random() * 0.7,
      color: tones[(Math.random() * tones.length) | 0] ?? "#ffffff",
      size: Math.random() < 0.15 ? 2 : 1,
      sprite: false,
    });
  }
  for (let i = 0; i < 3; i++)
    parts.push({
      x: cx + (Math.random() - 0.5) * 30 - 4,
      y: cy - 4,
      vx: (Math.random() - 0.5) * 10,
      vy: -18 - Math.random() * 10,
      life: 1.5,
      color: "#ffffff",
      size: 1,
      sprite: true,
    });
  let last = performance.now();
  let alive = parts;
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    alive = alive.filter((p) => {
      p.life -= dt;
      return p.life > 0;
    });
    for (const p of alive) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (!p.sprite) {
        p.vx *= 0.96;
        p.vy = p.vy * 0.96 - 6 * dt;
      }
      ctx.globalAlpha = Math.min(1, p.life * 2.2);
      if (p.sprite) {
        for (let sy = 0; sy < 9; sy++)
          for (let sx = 0; sx < 9; sx++) {
            const c = (SPRITE[sy] as string)[sx];
            if (c === ".") continue;
            ctx.fillStyle = c === "o" ? eye : p.color;
            ctx.fillRect(Math.round(p.x) + sx, Math.round(p.y) + sy, 1, 1);
          }
      } else {
        ctx.fillStyle = p.color;
        ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
      }
    }
    if (alive.length) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return canvas.getContext("2d");
  } catch {
    return null;
  }
}
