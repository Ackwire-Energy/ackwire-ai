/**
 * A picture forming out of the agent's sky, as the agent's own body forms (`drawAgent`'s `progress`): its cells arrive
 * from the bottom-left with a little noise, deeper at the bottom; whole, it holds a moment, fades and starts again
 * (an 8 s loop). Where a picture an agent is making will show (`ImageSky` on the web; the phone's `forming` dither
 * draws the same field in SkSL).
 *
 * The field at (u, v) in 0..1 (v down) at time `t` seconds: 0 is the surface, 1 the color's light end. `t` null: the
 * whole picture, still (reduced motion).
 */
export function formingField(u: number, v: number, t: number | null): number {
  const deep = 0.16 + 0.44 * v;
  if (t === null) return deep;
  const p = (((t % FORMING_LOOP_S) + FORMING_LOOP_S) % FORMING_LOOP_S) / 6;
  const d = (u + (1 - v)) / 2;
  const noise = cellHash(Math.floor(u * 50), Math.floor(v * 50)) * 0.16;
  const reveal = clamp01((p - d + noise) / 0.1);
  const out = p > 1.12 ? clamp01(1 - (p - 1.12) / 0.2) : 1;
  return reveal * out * deep;
}

/** One loop of `formingField`: forming (~6 s), whole, fading. */
export const FORMING_LOOP_S = 8;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** The shaders' `hash2`, so the web and the phone scatter the same cells. */
function cellHash(a: number, b: number) {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
