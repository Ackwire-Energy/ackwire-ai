/**
 * The agents' desktop wallpaper, drawn by the pixel sky engine itself: one still frame of `startSky` (seeded,
 * no pointer light, the loop stopped after the first frame) with the expanded logo over it. render.sh bundles
 * this file and screenshots wall.html.
 */
import { PIXEL_MARK_VIEWBOX, pixelMarkRects } from "../../../packages/ui/src/brand/ackwire";
import { drawSprite, type SkyFrame, startSky } from "../../../packages/ui/src/sky/engine";
import { pixelOf, SKY_TONES, spriteTone } from "../../../packages/ui/src/sky/math";

const W = 1280;
const H = 900;
const ASPECT = W / H;
const PIXEL = 4;

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (a: number, b: number, x: number) => {
  const k = clamp((x - a) / (b - a));
  return k * k * (3 - 2 * k);
};
/** A soft bump at (cx, cy) in screen fractions; radii in units of the height. */
const oval = (u: number, v: number, cx: number, cy: number, rx: number, ry = rx) => {
  const dx = ((u - cx) * ASPECT) / rx;
  const dy = (v - cy) / ry;
  return Math.exp(-(dx * dx + dy * dy));
};
/** Bands: each level flat over `1 - k` of its span, the dither only in the `k` between two levels. */
const terrace = (l: number, k: number) => {
  const i = Math.floor(l);
  return i + smooth(0.5 - k / 2, 0.5 + k / 2, l - i);
};

/**
 * The field in `SKY_TONES` levels at (u, v), both 0..1 of the screen: a deeper band overhead with two rounded
 * clouds, a wide flat middle where windows sit, and a pale band along the bottom, under the dock and the logo.
 */
function level(u: number, v: number): number {
  let l = 3.3 + 1.7 * smooth(0, 0.42, v) + 1.05 * smooth(0.66, 1, v) - 0.45 * u * (1 - smooth(0, 0.5, v));
  l += 0.18 * Math.sin(u * 7 + v * 3 + 0.6);
  l += 0.9 * oval(u, v, 0.2, 0.2, 0.17, 0.05) + 0.7 * oval(u, v, 0.29, 0.25, 0.11, 0.035);
  l += 0.8 * oval(u, v, 0.78, 0.12, 0.15, 0.04) + 0.6 * oval(u, v, 0.86, 0.17, 0.09, 0.03);
  return terrace(l, 0.5);
}

/** Pixel agents (the engine's 9×9 sprite), top left at (x, y) in screen fractions: up the edges, none in the middle. */
const AGENTS: { x: number; y: number; body: "navy" | "ghost"; closed?: boolean }[] = [
  { x: 0.045, y: 0.33, body: "ghost" },
  { x: 0.03, y: 0.52, body: "navy" },
  { x: 0.07, y: 0.66, body: "ghost" },
  { x: 0.16, y: 0.075, body: "ghost" },
  { x: 0.42, y: 0.04, body: "ghost" },
  { x: 0.8, y: 0.04, body: "navy", closed: true },
  { x: 0.945, y: 0.3, body: "ghost" },
  { x: 0.94, y: 0.62, body: "ghost" },
];

/**
 * The logo at the bottom left, on the pale band, centered on the dock's line (the dock spans y 844–893): below
 * 840, where a maximized window ends, so it shows whatever is open. The mark and "AI" in Solar Deep, "Ackwire" in
 * Forest Green: the computer dialog shows the desktop at about 0.6, where a lighter ink thins out to a haze.
 */
const LOGO = { left: 36, bottom: 15, size: 26, ink: "#031f1b", green: "#3f7a12" };
const LOGO_FACE = `800 ${LOGO.size}px "Plus Jakarta Sans"`;
const LOGO_TEXT = "Ackwire AI";

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The logo as the app draws it (packages/ui Logo): the pixel "A", then "Ackwire" and "AI". */
function logo(): HTMLElement {
  const el = document.createElement("span");
  el.className = "logo";
  el.style.fontSize = `${LOGO.size}px`;
  el.style.left = `${LOGO.left}px`;
  el.style.bottom = `${LOGO.bottom}px`;
  el.style.color = LOGO.ink;
  el.innerHTML =
    `<svg viewBox="${PIXEL_MARK_VIEWBOX}" shape-rendering="crispEdges" fill="${LOGO.green}" aria-hidden="true">${pixelMarkRects()}</svg>` +
    `<span class="word"><span>Ackwire</span><span style="color:${LOGO.green}">AI</span></span>`;
  return el;
}

async function main() {
  const host = document.querySelector<HTMLElement>(".wall");
  const canvas = host?.querySelector("canvas");
  if (!host || !canvas) return;
  host.append(logo());
  await document.fonts.load(LOGO_FACE, LOGO_TEXT);
  // Without the brand's font the logo would come out in a fallback face: the image stays black instead.
  if (!document.fonts.check(LOGO_FACE, LOGO_TEXT)) return;
  // The engine starts at a random time and spawns its own agents at random: a fixed seed keeps one frame.
  Math.random = seeded(7);
  const levels = SKY_TONES.length - 1;
  const white = pixelOf("#ffffff");
  const navy = pixelOf(spriteTone("sky"));
  // The engine's far agents: faint silhouettes in the second lightest tone.
  const ghost = pixelOf(SKY_TONES[levels - 1] as string);
  const stop = startSky(canvas, () => ({
    pixel: PIXEL,
    palette: SKY_TONES,
    light: 0,
    sprites: 0,
    base: (u, v) => level(u, v) / levels,
    after: (f: SkyFrame) => {
      for (const a of AGENTS) {
        drawSprite(f, Math.round(a.x * f.w), Math.round(a.y * f.h), 1, a.body === "navy" ? navy : ghost, white, a.closed);
      }
    },
  }));
  stop();
}

void main();
