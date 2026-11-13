// The favicon from the pixel "A" (src/brand/ackwire.ts), on a Forest Green tile: `bun packages/ui/scripts/favicon.ts`.
// apps/web/public/unavailable.html carries the same picture inline, its mark as one path: change both together.
import { writeFileSync } from "node:fs";
import { ACKWIRE, BRAND_NAME, PIXEL_MARK_SIZE, pixelMarkRects } from "../src/brand/ackwire";

const size = 32;
const at = { x: (size - PIXEL_MARK_SIZE.w) / 2, y: (size - PIXEL_MARK_SIZE.h) / 2 };
export const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><title>${BRAND_NAME}</title><rect width="${size}" height="${size}" rx="7" fill="${ACKWIRE.forest}" shape-rendering="auto"/><g transform="translate(${at.x} ${at.y})" fill="${ACKWIRE.solar}">${pixelMarkRects()}</g></svg>`;

if (import.meta.main) {
  writeFileSync(new URL("../../../apps/web/public/favicon.svg", import.meta.url), FAVICON);
  console.log(`favicon.svg: ${FAVICON.length} bytes`);
}
