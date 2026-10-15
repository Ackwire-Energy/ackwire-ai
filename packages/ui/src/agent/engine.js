/**
 * The agent, defined once. Every place that draws an agent reads its shape,
 * eyes, colors and dither from here: the avatar (`Avatar`), the logo and the
 * favicon, the pixel agents in the sky, the landing's giant and the HTML
 * prototypes in docs/design/telas (which import this file as is, so it stays
 * plain JavaScript with types in engine.d.ts and no imports).
 *
 * Coordinates are fractions of the body's box (0..1, y down). The body is a
 * square with radius 29% on three corners and the cut corner at bottom-left;
 * the eyes are the logo's: two narrow white pills.
 */

/** Top and bottom of each agent color. Sky is the landing's blue, the same in both themes. */
export const AGENT_GRADIENTS = {
  sky: ["#8cc3ff", "#0063d1"],
  indigo: ["#7d8bff", "#3f4fd6"],
  violet: ["#ae8cf7", "#6e45d1"],
  rose: ["#f58aa6", "#c9406a"],
  amber: ["#f3c25c", "#c07d0b"],
  green: ["#5fcf8b", "#1f8a4c"],
  teal: ["#4cd0c0", "#0f8f86"],
  graphite: ["#9a9a95", "#4a4a47"],
};

/** Eyes are white on every agent, everywhere. */
export const EYE_COLOR = "#ffffff";

/** The body: radius on three corners and the cut corner (bottom-left), as fractions of the side. */
export const BODY_RADIUS = 0.29;
export const BODY_CUT = 0.054;

/** Eye centers (x) and each eye style: size and vertical center. `arc` = happy (∩), `lid` = sleepy (half). */
export const EYE_X = [0.375, 0.625];
export const EYE_STYLES = {
  round: { w: 0.093, h: 0.27, cy: 0.465 },
  dots: { w: 0.093, h: 0.12, cy: 0.48 },
  wide: { w: 0.12, h: 0.33, cy: 0.46 },
  happy: { w: 0.15, h: 0.09, cy: 0.45, kind: "arc" },
  sleepy: { w: 0.13, h: 0.07, cy: 0.52, kind: "lid" },
};
/** While words arrive the eyes are short dashes. */
export const WRITING_EYE = { w: 0.15, h: 0.065, cy: 0.52 };

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/** "#rrggbb" → [r, g, b]. */
export function rgbOf(hex) {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `a` → `b` by `k` (0..1), as "#rrggbb". */
export function mixHex(a, b, k) {
  const A = rgbOf(a);
  const B = rgbOf(b);
  return `#${A.map((v, i) =>
    Math.round(v + (B[i] - v) * k)
      .toString(16)
      .padStart(2, "0"),
  ).join("")}`;
}

/** An agent color's [top, bottom] (unknown colors are sky). */
export function gradientOf(color) {
  return AGENT_GRADIENTS[color] ?? AGENT_GRADIENTS.sky;
}

/**
 * Five body tones, deep (0) to light (4). `deep` runs one step deeper, for a
 * big agent on a light halo (the landing's giant), so its top still reads.
 */
export function bodyTones(color, deep = false) {
  const [top, bottom] = gradientOf(color);
  if (deep)
    return [mixHex(bottom, "#000000", 0.5), mixHex(bottom, "#000000", 0.22), bottom, mixHex(bottom, top, 0.5), top];
  return [mixHex(bottom, "#000000", 0.38), bottom, mixHex(bottom, top, 0.5), top, mixHex(top, "#ffffff", 0.5)];
}

/** The small pixel agents' body: deep enough for white eyes (navy on the sky). */
export function spriteBody(color) {
  return !color || color === "sky" ? "#04203f" : mixHex(gradientOf(color)[1], "#000000", 0.45);
}

/** Dither cells per side for a body of `px` pixels: about 2.5–15 screen pixels per cell. */
export function ditherCells(px) {
  return px <= 20 ? 8 : px <= 28 ? 10 : px <= 40 ? 14 : px <= 64 ? 18 : px <= 160 ? 22 : 26;
}

/** Whether (u, v) is inside the body. */
export function inBody(u, v) {
  const r = BODY_RADIUS;
  const c = BODY_CUT;
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  if (u < r && v < r) return (u - r) ** 2 + (v - r) ** 2 <= r * r;
  if (u > 1 - r && v < r) return (u - 1 + r) ** 2 + (v - r) ** 2 <= r * r;
  if (u > 1 - r && v > 1 - r) return (u - 1 + r) ** 2 + (v - 1 + r) ** 2 <= r * r;
  if (u < c && v > 1 - c) return (u - c) ** 2 + (v - 1 + c) ** 2 <= c * c;
  return true;
}

/** The body's outline as an SVG path at (x, y), side `s`. */
export function bodyPath(x = 0, y = 0, s = 1) {
  const r = BODY_RADIUS * s;
  const c = BODY_CUT * s;
  const f = (n) => Number(n.toFixed(3));
  return [
    `M${f(x + r)} ${f(y)}`,
    `H${f(x + s - r)}`,
    `A${f(r)} ${f(r)} 0 0 1 ${f(x + s)} ${f(y + r)}`,
    `V${f(y + s - r)}`,
    `A${f(r)} ${f(r)} 0 0 1 ${f(x + s - r)} ${f(y + s)}`,
    `H${f(x + c)}`,
    `A${f(c)} ${f(c)} 0 0 1 ${f(x)} ${f(y + s - c)}`,
    `V${f(y + r)}`,
    `A${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(y)}`,
    "Z",
  ].join("");
}

/** Tone index (0..4) of the cell (x, y) of an n×n body: light top-left to deep bottom-right, Bayer-dithered. */
export function toneAt(x, y, n) {
  const u = (x + 0.5) / n;
  const v = (y + 0.5) / n;
  const k = Math.max(0, Math.min(4, (0.92 - 0.75 * v - 0.12 * u) * 4));
  const lo = Math.floor(k);
  return Math.min(4, k - lo > BAYER[(x & 3) + (y & 3) * 4] ? lo + 1 : lo);
}

/** The body as an SVG string: n×n cells, one rect per run of a tone in a row (the shape is clipped by whoever shows it). */
export function bodySvg(color, n, deep = false) {
  const tones = bodyTones(color, deep);
  const rects = [];
  for (let y = 0; y < n; y++) {
    let start = 0;
    let run = -1;
    for (let x = 0; x <= n; x++) {
      const idx = x < n ? toneAt(x, y, n) : -1;
      if (idx !== run) {
        if (run >= 0) rects.push(`<rect x="${start}" y="${y}" width="${x - start}" height="1" fill="${tones[run]}"/>`);
        start = x;
        run = idx;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" preserveAspectRatio="none" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}

/**
 * The two eyes for a style and a pose, as boxes in body fractions:
 * `{ x, y, w, h, kind }` with kind "pill" (rounded), "arc" (∩) or "lid" (half).
 * Pose: `writing` (dashes), `blink` (closed), `look` [dx, dy] in fractions.
 */
export function eyeShapes(style = "round", pose = {}) {
  const base = EYE_STYLES[style] ?? EYE_STYLES.round;
  const e = pose.writing ? WRITING_EYE : base;
  const kind = pose.writing ? "pill" : (e.kind ?? "pill");
  const [dx, dy] = pose.look ?? [0, 0];
  const h = pose.blink && kind === "pill" ? Math.max(0.03, e.h * 0.12) : e.h;
  return EYE_X.map((cx) => ({ x: cx - e.w / 2 + dx, y: e.cy - h / 2 + dy, w: e.w, h, kind }));
}

/** Draws the eyes on a 2D canvas for a body at (x, y), side `s`. */
export function drawEyes(ctx, x, y, s, shapes, color = EYE_COLOR) {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  for (const e of shapes) {
    const ex = x + e.x * s;
    const ey = y + e.y * s;
    const w = e.w * s;
    const h = e.h * s;
    ctx.beginPath();
    if (e.kind === "arc") {
      ctx.lineWidth = Math.max(1, s * 0.045);
      ctx.lineCap = "round";
      ctx.ellipse(ex + w / 2, ey + h, w / 2 - ctx.lineWidth / 2, h, 0, Math.PI, 0);
      ctx.stroke();
    } else if (e.kind === "lid") {
      ctx.ellipse(ex + w / 2, ey, w / 2, h, 0, 0, Math.PI);
      ctx.fill();
    } else {
      ctx.roundRect(ex, ey, w, h, Math.min(w, h) / 2);
      ctx.fill();
    }
  }
}

const noise = (x, y) => {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * Draws a whole agent on a 2D canvas at (x, y), side `s` (canvas pixels).
 * Options: `color`, `eyes` (style), `pose`, `cells` (dither grid, default
 * from the size), `deep` tones, `progress` (0..1: the body forming from the
 * sky, cells arriving from the bottom-left with noise; eyes show once formed),
 * `withEyes` (default true).
 */
export function drawAgent(ctx, x, y, s, opts = {}) {
  const n = opts.cells ?? ditherCells(s);
  const tones = bodyTones(opts.color, opts.deep);
  const progress = opts.progress ?? 1;
  const p = s / n;
  ctx.save();
  if (progress >= 1) {
    ctx.beginPath();
    ctx.roundRect(x, y, s, s, [s * BODY_RADIUS, s * BODY_RADIUS, s * BODY_RADIUS, s * BODY_CUT]);
    ctx.clip();
  }
  for (let cy = 0; cy < n; cy++)
    for (let cx = 0; cx < n; cx++) {
      const u = (cx + 0.5) / n;
      const v = (cy + 0.5) / n;
      if (progress < 1) {
        if (!inBody(u, v)) continue;
        const order = 0.55 * noise(cx, cy) + 0.45 * ((1 - v) * 0.6 + u * 0.4);
        const show = progress * 1.15 - order;
        if (show <= 0) continue;
        ctx.fillStyle = show < 0.08 ? "#eef7ff" : tones[toneAt(cx, cy, n)];
      } else ctx.fillStyle = tones[toneAt(cx, cy, n)];
      const x0 = Math.round(x + cx * p);
      const y0 = Math.round(y + cy * p);
      ctx.fillRect(x0, y0, Math.round(x + (cx + 1) * p) - x0, Math.round(y + (cy + 1) * p) - y0);
    }
  ctx.restore();
  if (opts.withEyes !== false && progress > 0.92) drawEyes(ctx, x, y, s, eyeShapes(opts.eyes, opts.pose));
}

/**
 * A small pixel agent for the skies: n×n rows of "X" (body), "o" (eye) and
 * "." (empty), from the same shape and eyes (n = 9 gives the classic sprite).
 */
export function spriteGrid(n = 9, style = "round") {
  const eyes = eyeShapes(style);
  const rows = [];
  for (let y = 0; y < n; y++) {
    let row = "";
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n;
      const v = (y + 0.5) / n;
      if (!inBody(u, v)) row += ".";
      else row += eyes.some((e) => u >= e.x && u <= e.x + e.w && v >= e.y && v <= e.y + e.h) ? "o" : "X";
    }
    rows.push(row);
  }
  return rows;
}
