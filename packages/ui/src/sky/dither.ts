/**
 * The agent symbol's body in the sky's dither (docs/design/telas/AvatarLogo.html,
 * direction B): a light top fading to a deep bottom in the agent's color, as
 * an ordered (Bayer) dither on a small grid. Drawn as a crisp SVG, so it is a
 * plain image (no canvas) and scales with the symbol.
 */
import { type AgentColor, agentGradient } from "../components/AgentLook";
import { mix } from "./tones";

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/** Five tones of an agent color, deep to light. */
export function ditherTones(color: AgentColor = "sky"): string[] {
  const [top, bottom] = agentGradient(color);
  return [mix(bottom, "#000000", 0.38), bottom, mix(bottom, top, 0.5), top, mix(top, "#ffffff", 0.5)];
}

/** Cells per side for a symbol of `px` pixels: about 2.5–5 screen pixels per cell. */
export function ditherCells(px: number): number {
  return px <= 20 ? 8 : px <= 28 ? 10 : px <= 40 ? 14 : px <= 64 ? 18 : 22;
}

const cache = new Map<string, string>();

/** The body as an SVG string (`cells` × `cells`, one rect per run of a tone in a row). */
export function ditherSvg(color: AgentColor = "sky", cells = 14): string {
  const tones = ditherTones(color);
  const n = tones.length - 1;
  const rects: string[] = [];
  for (let y = 0; y < cells; y++) {
    let start = 0;
    let run = -1;
    for (let x = 0; x <= cells; x++) {
      let idx = -1;
      if (x < cells) {
        const u = (x + 0.5) / cells;
        const v = (y + 0.5) / cells;
        const k = Math.max(0, Math.min(n, (0.92 - 0.75 * v - 0.12 * u) * n));
        const lo = Math.floor(k);
        idx = Math.min(n, k - lo > (BAYER[(x & 3) + (y & 3) * 4] ?? 0.5) ? lo + 1 : lo);
      }
      if (idx !== run) {
        if (run >= 0) rects.push(`<rect x="${start}" y="${y}" width="${x - start}" height="1" fill="${tones[run]}"/>`);
        start = x;
        run = idx;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cells} ${cells}" preserveAspectRatio="none" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}

/** The body as a data URL, cached per color and grid. */
export function ditherUrl(color: AgentColor = "sky", cells = 14): string {
  const key = `${color}:${cells}`;
  let url = cache.get(key);
  if (!url) {
    url = `data:image/svg+xml,${encodeURIComponent(ditherSvg(color, cells))}`;
    cache.set(key, url);
  }
  return url;
}
