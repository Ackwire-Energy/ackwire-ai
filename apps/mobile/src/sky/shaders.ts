/**
 * The dither drawings as SkSL runtime shaders: one pass per screen pixel, the same steps as the web's
 * dither loop (see ./math.ts, which mirrors these functions and is tested against that loop).
 *
 * Uniforms shared by all: `size` (points), `px` (points per cell), `t` (seconds), `last` (index of the
 * last tone), `pal[8]` (tones, padded), `fade` (from this height, as a share, the drawing fades out to
 * the bottom like the web's mask; 2 = no fade), `clear` (1 = the first tone is see-through, for a drawing
 * over glass). Arrays are only read with loop indices (SkSL rule).
 */
export type DitherKind =
  | "sky"
  | "computer"
  | "fuse"
  | "bar"
  | "track"
  | "sweep"
  | "pill"
  | "pillwork"
  | "horizon"
  | "workspace";

const PRELUDE = `
uniform float2 size;
uniform float px;
uniform float t;
uniform float last;
uniform float fade;
uniform float clear;
uniform float4 pal[8];

float hash2(float a, float b) {
  return fract(sin(a * 127.1 + b * 311.7) * 43758.5453);
}

float b2(float a, float b) {
  return a < 0.5 ? (b < 0.5 ? 0.0 : 3.0) : (b < 0.5 ? 2.0 : 1.0);
}

float bayer(float x, float y) {
  float x0 = mod(x, 2.0);
  float y0 = mod(y, 2.0);
  float x1 = mod(floor(x / 2.0), 2.0);
  float y1 = mod(floor(y / 2.0), 2.0);
  return (4.0 * b2(x0, y0) + b2(x1, y1) + 0.5) / 16.0;
}

float4 tone(float idx) {
  float4 c = pal[0];
  for (int i = 1; i < 8; i++) {
    if (abs(float(i) - idx) < 0.5) c = pal[i];
  }
  return c;
}
`;

const MAIN = `
half4 main(float2 pos) {
  float x = floor(pos.x / px);
  float y = floor(pos.y / px);
  float w = max(2.0, ceil(size.x / px));
  float h = max(2.0, ceil(size.y / px));
  float u = x / w;
  float v = y / h;
  float f = clamp(field(u, v, x, y), 0.0, 1.0);
  float s = f * last;
  float b = floor(s);
  float idx = (s - b > bayer(x, y)) ? b + 1.0 : b;
  if (clear > 0.5 && idx < 0.5) return half4(0.0);
  float4 c = tone(min(idx, last));
  float yy = pos.y / size.y;
  float a = yy < fade ? 1.0 : clamp(1.0 - (yy - fade) / max(0.001, 1.0 - fade), 0.0, 1.0);
  return half4(c.rgb * a, a);
}
`;

/**
 * Drawings that put something over their field (the workspace sky's clouds and stars): `overlay` gives 0 (the
 * field shows), 1 (tone 6) or 2 (tone 7); the field's own tones end at `top`, not at the last one.
 */
const MAIN_OVERLAY = `
half4 main(float2 pos) {
  float x = floor(pos.x / px);
  float y = floor(pos.y / px);
  float w = max(2.0, ceil(size.x / px));
  float h = max(2.0, ceil(size.y / px));
  float u = x / w;
  float v = y / h;
  float f = clamp(field(u, v, x, y), 0.0, 1.0);
  float s = f * top;
  float b = floor(s);
  float idx = min((s - b > bayer(x, y)) ? b + 1.0 : b, top);
  float o = overlay(x, y, w, h);
  if (o > 0.5) idx = o > 1.5 ? 7.0 : 6.0;
  if (clear > 0.5 && idx < 0.5) return half4(0.0);
  float4 c = tone(idx);
  float yy = pos.y / size.y;
  float a = yy < fade ? 1.0 : clamp(1.0 - (yy - fade) / max(0.001, 1.0 - fade), 0.0, 1.0);
  return half4(c.rgb * a, a);
}
`;

/** Kinds drawn with `MAIN_OVERLAY`. */
const OVERLAID: ReadonlySet<DitherKind> = new Set(["workspace"]);

const FIELDS: Record<DitherKind, string> = {
  // The workspace's sky (@agenteschat/ui sky/workspace): `phoneField`, then `cloudAt` (hour 0, the Cloud) or
  // `starAt` (hour 1, a server of one's own) in PHONE_AREA, line by line.
  workspace: `
uniform float hour;
uniform float top;
float smooth01(float a, float b, float x) {
  float e = clamp((x - a) / (b - a), 0.0, 1.0);
  return e * e * (3.0 - 2.0 * e);
}
float field(float u, float v, float x, float y) {
  float down = 1.0 - smooth01(0.25, 1.0, v);
  return down * (0.6 + 0.3 * u) + 0.05 * sin(u * 5.0 + v * 4.0 + t * 0.5);
}
float run(float dx, float a, float b) {
  return (dx >= a && dx < b) ? 1.0 : 0.0;
}
float cloudCell(float i, float dx, float row) {
  if (i < 0.5) {
    if (abs(row) < 0.5) return run(dx, 2.0, 6.0) * 2.0;
    if (abs(row - 1.0) < 0.5) return run(dx, 1.0, 8.0) * 2.0;
    if (abs(row - 2.0) < 0.5) return run(dx, 0.0, 10.0);
    if (abs(row - 3.0) < 0.5) return run(dx, 1.0, 9.0);
    return 0.0;
  }
  if (i < 1.5) {
    if (abs(row) < 0.5) return run(dx, 1.0, 4.0) * 2.0;
    if (abs(row - 1.0) < 0.5) return run(dx, 0.0, 7.0);
    if (abs(row - 2.0) < 0.5) return run(dx, 1.0, 6.0);
    return 0.0;
  }
  if (abs(row) < 0.5) return run(dx, 2.0, 5.0) * 2.0;
  if (abs(row - 1.0) < 0.5) return run(dx, 1.0, 8.0) * 2.0;
  if (abs(row - 2.0) < 0.5) return run(dx, 0.0, 9.0);
  return 0.0;
}
float overlay(float x, float y, float w, float h) {
  float x0 = 0.5;
  float y0 = 0.05;
  float y1 = 0.42;
  if (x < w * x0) return 0.0;
  if (hour < 0.5) {
    float span = w * (1.0 - x0) + 14.0;
    for (int n = 0; n < 3; n++) {
      float i = float(n);
      float cx = floor(w - mod(t * (0.9 + 0.35 * i) + i * span * 0.37, span));
      float cy = floor(h * (y0 + (y1 - y0) * (0.1 + 0.4 * i)));
      float c = cloudCell(i, x - cx, y - cy);
      if (c > 0.5) return c;
    }
    return 0.0;
  }
  if (y < h * y0 || y > h * y1) return 0.0;
  float k = hash2(x, y);
  if (k < 0.975) return 0.0;
  float phase = mod(t * 0.7 + k * 600.0, 6.0);
  if (phase > 5.2) return 0.0;
  return phase < 0.6 ? 1.0 : 2.0;
}
`,
  sky: `
float field(float u, float v, float x, float y) {
  float dx = (u - 0.5) * 1.5;
  float dy = (v - 0.78) * 1.8;
  float f = 0.85 * exp(-(dx * dx + dy * dy) / 0.26);
  f *= 1.0 + 0.06 * sin(t * 0.6 + u * 5.0);
  float k = min(1.0, (1.0 - v) / 0.5);
  f *= k * k * (3.0 - 2.0 * k);
  float hh = hash2(x, y);
  if (f < 0.12 && hh > 0.988 && v < 0.7) f = 0.45 + 0.4 * sin(t * 1.6 + hh * 90.0);
  return f;
}
`,
  // Behind an agent's computer while its screen opens: the web's `ComputerSky`, the same field.
  computer: `
float field(float u, float v, float x, float y) {
  return 0.78 - 0.18 * u - 0.4 * v + 0.06 * sin(u * 5.0 + t * 0.5);
}
`,
  // The launch splash: the sky up to `level` (share of the height from the
  // bottom), a soft wave on its top edge, deepest at the bottom.
  horizon: `
uniform float level;
float field(float u, float v, float x, float y) {
  float edge = v - (1.0 - level) + 0.08 * level * sin(u * 6.0 + t * 1.1);
  float s = clamp(edge / max(0.0001, level), 0.0, 1.0);
  return s * s * (3.0 - 2.0 * s) * 0.97;
}
`,
  fuse: `
uniform float remaining;
float field(float u, float v, float x, float y) {
  float rem = max(0.0, remaining);
  if (u > rem) return mod(floor(u * 140.0), 3.0) < 0.5 ? 0.12 : 0.0;
  float d = rem - u;
  float edge = exp(-(d * d) / 0.0006) * (0.75 + 0.25 * sin(t * 9.0 + u * 40.0));
  return min(1.0, 0.38 + 0.1 * sin(t * 1.4 - u * 18.0) + edge);
}
`,
  bar: `
uniform float value;
float field(float u, float v, float x, float y) {
  if (u > value) return mod(floor(u * 120.0), 3.0) < 0.5 ? 0.12 : 0.0;
  return 0.45 + 0.25 * u;
}
`,
  track: `
uniform float count;
uniform float states[48];
float field(float u, float v, float x, float y) {
  float n = max(1.0, count);
  float k = min(n - 1.0, floor(u * n));
  float loc = u * n - k;
  if (loc > 0.8) return 0.0;
  float st = 0.0;
  for (int i = 0; i < 48; i++) {
    if (abs(float(i) - k) < 0.5) st = states[i];
  }
  if (st > 1.5) return 0.62 + 0.25 * (1.0 - v);
  if (st > 0.5) return 0.3 + 0.32 * (0.5 + 0.5 * sin(t * 4.0 + k));
  bool edge = v < 0.2 || v > 0.8 || loc < 0.12 || loc > 0.68;
  return (edge && mod(x + y, 2.0) < 0.5) ? 0.2 : 0.0;
}
`,
  sweep: `
float field(float u, float v, float x, float y) {
  float c = mod(t * 0.32, 1.6) - 0.3;
  float d = u - c;
  return 0.08 + 0.5 * exp(-(d * d) / 0.035);
}
`,
  pill: `
float field(float u, float v, float x, float y) {
  float e = max(0.0, (u - 0.55) / 0.45);
  return 0.55 * e * e * (0.8 + 0.2 * sin(v * 5.0 + t * 0.7));
}
`,
  pillwork: `
float field(float u, float v, float x, float y) {
  float p = mod(t * 0.42, 1.6) - 0.3;
  float d = u - p;
  return min(0.75, 0.32 * u * u * u + 0.5 * exp(-(d * d) / 0.02) * (0.5 + 0.5 * u)) + 0.04 * sin(v * 6.0 + t);
}
`,
};

/** The full SkSL source of one drawing. */
export const shaderSource = (kind: DitherKind) =>
  `${PRELUDE}${FIELDS[kind]}${OVERLAID.has(kind) ? MAIN_OVERLAY : MAIN}`;
