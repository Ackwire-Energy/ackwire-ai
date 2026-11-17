import type { SkyFrame, SkyOptions } from "./engine";

/** Where a workspace lives: on agentes.chat Cloud, or on a server of one's own. */
export type Hosting = "cloud" | "own";

/** The team drawn over the choice of where a workspace lives: three looks, fixed, any workspace's, not the person's. */
export const HOSTING_CAST = [
  { name: "a", look: { color: "amber", eyes: "round" } },
  { name: "b", look: { color: "sky", eyes: "round" } },
  { name: "c", look: { color: "green", eyes: "round" } },
] as const;

import { mix, parseColor, pixelOf, TEAM_NIGHT } from "./math";

/*
 * The team's sky (ADR 0160): night while they have no AI (or no server keeps them up), day once they think. Drawn by
 * the shared sky engine; the web's TeamScene, the sign-in's "Onde fica o seu workspace?" and the desktop app's first
 * screen paint it.
 */

const DAY = ["#79d32d", "#81dd34", "#93ec48", "#a6f762", "#b6f87f", "#cffbaa", "#e5fdd1", "#f6feef"];
/** The day on a dark page: the same blues, deeper, so the sky doesn't glare beside dark surfaces. */
const DAY_DARK = ["#2f550f", "#396713", "#457b18", "#52901d", "#5ea324", "#6cb52e", "#79c539", "#89d449"];

const STAR = pixelOf("#f4feeb");
const MOON = pixelOf("#f3f6ff");
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const bayer = (x: number, y: number) => BAYER[((y & 3) << 2) | (x & 3)] ?? 0.5;
const hash = (x: number, y: number) => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
};
/** A pixel cloud: circles on a flat base, in sky pixels around its anchor. */
const PUFFS = [
  [0, 0, 3.2],
  [4.2, 0.6, 2.4],
  [-4, 0.8, 2.2],
  [1.6, -1.8, 2.4],
  [7.4, 1.4, 1.5],
  [-6.8, 1.5, 1.4],
] as const;
/** Where the clouds sit (u, v) and how big: away from the middle, where the team and the words are. */
const CLOUDS = [
  [0.17, 0.34, 1],
  [0.84, 0.5, 0.8],
] as const;

/** 0: not a cloud; 1: its body; 2: its underside, drawn every other pixel. */
function cloudAt(x: number, y: number, w: number, h: number) {
  for (const [u, v, k] of CLOUDS) {
    const ax = u * w;
    const ay = v * h;
    if (y > ay + 2.2 * k) continue;
    for (const [px, py, r] of PUFFS)
      if ((x - ax - px * k) ** 2 + (y - ay - py * k) ** 2 <= (r * k) ** 2) return y > ay + 0.9 * k ? 2 : 1;
  }
  return 0;
}

/** Stars and a moon that go as the day comes, clouds that come with it. `quiet`: the top share kept plain (words). */
function paintOver(f: SkyFrame, day: number, quiet: number) {
  const { buf, w, h, tones } = f;
  const cloud = tones[tones.length - 1] ?? STAR;
  const night = 1 - day;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = y / h;
      if (v >= quiet && v < 0.62 && hash(x, y) < 0.008 * night) buf[y * w + x] = STAR;
      if (day > 0.3) {
        const c = cloudAt(x, y, w, h);
        if (c !== 0 && bayer(x, y) < (day - 0.3) * (c === 1 ? 4 : 0.8)) buf[y * w + x] = cloud;
      }
    }
  if (night < 0.25) return;
  const mx = Math.round(w * 0.8);
  const my = Math.round(h * (quiet > 0 ? 0.3 : 0.16) + day * 10);
  const dot = (x: number, y: number, color: number) => {
    if (x >= 0 && x < w && y >= 0 && y < h) buf[y * w + x] = color;
  };
  for (let dy = -2; dy < 6; dy++)
    for (let dx = -2; dx < 6; dx++) {
      const round = (dx - 1.5) ** 2 + (dy - 1.5) ** 2 <= 12;
      if (round) dot(mx + dx, my + dy, MOON);
    }
  // The bite that makes it a crescent, in the sky's own deepest tone.
  const deep = tones[0] ?? MOON;
  for (let dy = -2; dy < 2; dy++) for (let dx = 2; dx < 6; dx++) if (dx - dy >= 3) dot(mx + dx, my + dy, deep);
}

const isDark = (surface: string) => {
  const [r, g, b] = parseColor(surface);
  return (r + g + b) / 3 < 110;
};

/** The team sky's tones at `day` (0 night, 1 day) over `surface` (deeper day blues on a dark one). DOM-free. */
export const teamTones = (day: number, surface: string) =>
  TEAM_NIGHT.map((n, i) => mix(n, (isDark(surface) ? DAY_DARK : DAY)[i] ?? n, day));

/** The sky's options at `day` (0 night, 1 day), drawn by the shared sky engine. */
export function teamSky(day: number, quiet = 0): SkyOptions {
  return {
    pixel: 4,
    surface: "--raised",
    light: 0,
    sprites: 0,
    palette: (surface) => teamTones(day, surface),
    base: (u, v) => {
      const sun = day * 0.2 * Math.exp(-(((u - 0.5) * 1.5) ** 2 + ((v - 1.05) * 2.4) ** 2));
      return Math.min(1, Math.max(0, v ** 0.9 * 0.9 + 0.05 * Math.sin(u * 5.2 + v * 3) + sun));
    },
    after: (f) => paintOver(f, day, quiet),
  };
}
