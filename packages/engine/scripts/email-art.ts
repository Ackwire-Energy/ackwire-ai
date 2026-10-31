/**
 * The emails' picture of the workspace's computer, drawn by the app's own portrait engine (`drawComputer` in
 * packages/ui/src/computer/portrait.js) as `COMPUTER` in the layout says, at twice the size the layout shows it:
 *
 *   bun packages/engine/scripts/email-art.ts
 *
 * writes `apps/web/public/email/<COMPUTER.file>`. No browser: the engine paints single cells, so a buffer stands in
 * for the canvas. A changed drawing gets a new file name in `COMPUTER` (Gmail's image proxy caches by name).
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { COMPUTER_ART, COMPUTER_GRID, COMPUTER_ROWS, drawComputer } from "@agenteschat/ui/computer/portrait";
import { COMPUTER } from "../src/email/layout";

const N = COMPUTER_GRID;
/** Straight RGBA, each 0..1. */
const grid = new Float64Array(N * N * 4);
let fill = [0, 0, 0, 1];
const each = (x: number, y: number, w: number, h: number, paint: (at: number) => void) => {
  for (let j = Math.max(0, y); j < Math.min(N, y + h); j++)
    for (let i = Math.max(0, x); i < Math.min(N, x + w); i++) paint((j * N + i) * 4);
};
const ctx = {
  set fillStyle(c: unknown) {
    const s = String(c);
    const rgba = /^rgba?\(([^)]+)\)$/.exec(s)?.[1]?.split(",").map(Number);
    const n = Number.parseInt(s.slice(1, 7), 16);
    fill = rgba
      ? [(rgba[0] ?? 0) / 255, (rgba[1] ?? 0) / 255, (rgba[2] ?? 0) / 255, rgba[3] ?? 1]
      : [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
  },
  get fillStyle() {
    return fill;
  },
  // Source-over, as a canvas paints.
  fillRect: (x: number, y: number, w: number, h: number) =>
    each(x, y, w, h, (at) => {
      const [r = 0, g = 0, b = 0, a = 1] = fill;
      const under = (grid[at + 3] ?? 0) * (1 - a);
      const out = a + under;
      for (const [k, c] of [r, g, b].entries()) grid[at + k] = (c * a + (grid[at + k] ?? 0) * under) / out;
      grid[at + 3] = out;
    }),
  clearRect: (x: number, y: number, w: number, h: number) => each(x, y, w, h, (at) => grid.fill(0, at, at + 4)),
};
drawComputer(ctx, COMPUTER.kind, "online", { t: COMPUTER.t });

const [first, drawn] = COMPUTER_ART[COMPUTER.kind];
const [x0, cols] = [first - COMPUTER.margin, drawn + 2 * COMPUTER.margin];
const [y0, rows] = COMPUTER_ROWS[COMPUTER.kind];
const scale = (COMPUTER.cell * 2) as number;
const [w, h] = [cols * scale, rows * scale];
// Each row starts with its filter byte: 0, none.
const raw = Buffer.alloc((w * 4 + 1) * h);
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++) {
    const from = ((y0 + Math.floor(y / scale)) * N + x0 + Math.floor(x / scale)) * 4;
    for (let k = 0; k < 4; k++) raw[y * (w * 4 + 1) + 1 + x * 4 + k] = Math.round((grid[from + k] ?? 0) * 255);
  }
const chunk = (type: string, data: Buffer) => {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, data.length + 8)), data.length + 8);
  return out;
};
const head = Buffer.alloc(13);
head.writeUInt32BE(w, 0);
head.writeUInt32BE(h, 4);
// 8 bits a channel, RGBA.
head.set([8, 6], 8);
const file = resolve(import.meta.dir, "../../../apps/web/public/email", COMPUTER.file);
writeFileSync(
  file,
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
console.log(`${file}: ${w}×${h}, shown at ${w / 2}×${h / 2}`);
