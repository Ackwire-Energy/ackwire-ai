/**
 * The dither drawings as SkSL runtime shaders: one pass per screen pixel, the same steps as Mobile.html's
 * `drawDithers` loop (see ./math.ts, which mirrors these functions and is tested against the web's loop).
 *
 * Uniforms shared by all: `size` (points), `px` (points per cell), `t` (seconds), `last` (index of the
 * last tone), `pal[8]` (tones, padded), `fade` (from this height, as a share, the drawing fades out to
 * the bottom like the web's mask; 2 = no fade). Arrays are only read with loop indices (SkSL rule).
 */
export type DitherKind = "sky" | "fuse" | "bar" | "track";

const PRELUDE = `
uniform float2 size;
uniform float px;
uniform float t;
uniform float last;
uniform float fade;
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
  float4 c = tone(min(idx, last));
  float yy = pos.y / size.y;
  float a = yy < fade ? 1.0 : clamp(1.0 - (yy - fade) / max(0.001, 1.0 - fade), 0.0, 1.0);
  return half4(c.rgb * a, a);
}
`;

const FIELDS: Record<DitherKind, string> = {
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
};

/** The full SkSL source of one drawing. */
export const shaderSource = (kind: DitherKind) => `${PRELUDE}${FIELDS[kind]}${MAIN}`;
