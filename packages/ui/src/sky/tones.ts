/**
 * Tones for the pixel sky. Every sky is a short list of colors from deep (0)
 * to light (last); the dither picks between neighbours. The agents' world is
 * the sky blue (same in both themes); an agent's own sky uses its color.
 */
import { type AgentColor, agentGradient } from "../components/AgentLook";

/** The landing's sky, deep blue to almost white. */
export const SKY_TONES = ["#0a3f9c", "#0f56c4", "#2b74e6", "#4b93ff", "#78b4ff", "#a6cfff", "#cfe6ff", "#eef7ff"];

/** "#rgb", "#rrggbb" or "rgb(r, g, b)" → [r, g, b]; anything else is mid gray. */
export function parseColor(color: string): [number, number, number] {
  const c = color.trim();
  if (c.startsWith("#")) {
    const h = c.length === 4 ? [...c.slice(1)].map((x) => x + x).join("") : c.slice(1, 7);
    const n = Number.parseInt(h, 16);
    if (h.length === 6 && !Number.isNaN(n)) return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(c);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return [128, 128, 128];
}

/** `a` → `b` by `k` (0..1), as "#rrggbb". */
export function mix(a: string, b: string, k: number): string {
  const A = parseColor(a);
  const B = parseColor(b);
  return `#${A.map((v, i) =>
    Math.round(v + ((B[i] ?? v) - v) * k)
      .toString(16)
      .padStart(2, "0"),
  ).join("")}`;
}

/** A color as a little-endian RGBA pixel (for a Uint32Array over ImageData). */
export function pixelOf(color: string): number {
  const [r, g, b] = parseColor(color);
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** A full sky in an agent's color: deep to near white (sky → the landing's tones). */
export function agentTones(color: AgentColor = "sky"): string[] {
  if (color === "sky") return SKY_TONES;
  const [top, bottom] = agentGradient(color);
  const deep = mix(bottom, "#000000", 0.42);
  return [
    deep,
    mix(deep, bottom, 0.5),
    bottom,
    mix(bottom, top, 0.5),
    top,
    mix(top, "#ffffff", 0.4),
    mix(top, "#ffffff", 0.7),
    mix(top, "#ffffff", 0.9),
  ];
}

/** From a surface into the agent's color (empty states, the activity strip). */
export function glowTones(color: AgentColor, surface: string): string[] {
  const [top, bottom] = agentGradient(color);
  return [
    surface,
    mix(surface, bottom, 0.2),
    mix(surface, bottom, 0.45),
    mix(surface, bottom, 0.72),
    bottom,
    mix(bottom, top, 0.5),
    top,
    mix(top, "#ffffff", 0.5),
  ];
}

/** The light version: from a surface only into the color's light tones (the sidebar). */
export function softTones(color: AgentColor, surface: string): string[] {
  const [top, bottom] = agentGradient(color);
  return [
    surface,
    mix(surface, top, 0.12),
    mix(surface, top, 0.26),
    mix(surface, top, 0.42),
    mix(surface, top, 0.62),
    top,
    mix(top, bottom, 0.35),
  ];
}

/** The pixel agents' eye color on a sky of this color. */
export const eyeTone = (color: AgentColor = "sky") => (color === "sky" ? "#1c63d6" : agentGradient(color)[1]);
