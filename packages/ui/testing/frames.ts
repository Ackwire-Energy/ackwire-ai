/**
 * A canvas on a page whose animation frames run by hand, for tests of drawing loops: `frames(ms)` runs that long
 * of a 60 Hz screen (`performance.now()` follows), the canvas's 2D context counts what it draws, and the
 * intersection observer's answer is the test's (`onScreen`). With `reduced`, `matchMedia` says the person asked
 * for reduced motion. Needs the DOM (`setupDom`); `close` puts everything back.
 */
import { spyOn } from "bun:test";

export function canvasPage({ width, height, reduced = false }: { width: number; height: number; reduced?: boolean }) {
  let clock = 0;
  let queue: FrameRequestCallback[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = {
    requestAnimationFrame: g.requestAnimationFrame,
    cancelAnimationFrame: g.cancelAnimationFrame,
    IntersectionObserver: g.IntersectionObserver,
    ResizeObserver: g.ResizeObserver,
  };
  let seen: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
  g.requestAnimationFrame = (cb: FrameRequestCallback) => queue.push(cb);
  g.cancelAnimationFrame = () => {
    queue = [];
  };
  g.IntersectionObserver = class {
    constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
      seen = cb;
    }
    observe() {}
    disconnect() {}
  };
  g.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  const now = spyOn(performance, "now").mockImplementation(() => clock);
  const media = spyOn(window, "matchMedia").mockImplementation(
    (query: string) => ({ matches: reduced && query.includes("reduce") }) as MediaQueryList,
  );
  const host = document.createElement("div");
  const canvas = document.createElement("canvas");
  host.append(canvas);
  document.body.append(host);
  host.getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height }) as DOMRect;
  Object.defineProperty(canvas, "offsetParent", { get: () => host });
  let draws = 0;
  canvas.getContext = (() => ({
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: () => {
      draws++;
    },
  })) as unknown as typeof canvas.getContext;
  return {
    canvas,
    /** Frames drawn on the canvas so far. */
    draws: () => draws,
    /** Animation frames asked for and not run yet. */
    pending: () => queue.length,
    /** Runs `ms` of a 60 Hz screen. */
    frames(ms: number) {
      for (const end = clock + ms; clock < end; ) {
        clock += 1000 / 60;
        const due = queue;
        queue = [];
        for (const cb of due) cb(clock);
      }
    },
    onScreen: (on: boolean) => seen?.([{ isIntersecting: on }]),
    close() {
      host.remove();
      now.mockRestore();
      media.mockRestore();
      Object.assign(g, saved);
    },
  };
}
