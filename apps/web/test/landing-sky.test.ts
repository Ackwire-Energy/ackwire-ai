import { describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { HERO_SKY, startSky } from "../src/pages/landing/sky";

/**
 * The hero's sky on a page whose frames run by hand (`frames`), with a 2D context that counts what it draws, and
 * the intersection observer's answer in the test's hands (`onScreen`).
 */
function heroSky(reduced: boolean) {
  let clock = 0;
  let queue: FrameRequestCallback[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = {
    raf: g.requestAnimationFrame,
    caf: g.cancelAnimationFrame,
    io: g.IntersectionObserver,
    ro: g.ResizeObserver,
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
  const host = document.createElement("div");
  const canvas = document.createElement("canvas");
  host.append(canvas);
  document.body.append(host);
  host.getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, right: 80, bottom: 60, width: 80, height: 60 }) as DOMRect;
  let draws = 0;
  canvas.getContext = (() => ({
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: () => {
      draws++;
    },
  })) as unknown as typeof canvas.getContext;
  const stop = startSky(canvas, () => ({ pixel: 4, sprites: true, ...HERO_SKY }), reduced);
  return {
    draws: () => draws,
    /** Frames still asked for. */
    pending: () => queue.length,
    /** `ms` of a 60 Hz screen. */
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
      stop();
      host.remove();
      now.mockRestore();
      Object.assign(g, {
        requestAnimationFrame: saved.raf,
        cancelAnimationFrame: saved.caf,
        IntersectionObserver: saved.io,
        ResizeObserver: saved.ro,
      });
    },
  };
}

describe("the landing's sky", () => {
  test("about 30 frames a second on a 60 Hz screen while on screen, none off screen", () => {
    const sky = heroSky(false);
    try {
      expect(sky.draws()).toBe(1);
      sky.frames(1000);
      expect(sky.draws()).toBeGreaterThanOrEqual(29);
      expect(sky.draws()).toBeLessThanOrEqual(32);
      sky.onScreen(false);
      const drawn = sky.draws();
      sky.frames(1000);
      expect(sky.draws()).toBe(drawn);
      expect(sky.pending()).toBe(0);
      sky.onScreen(true);
      sky.frames(500);
      expect(sky.draws()).toBeGreaterThan(drawn + 10);
    } finally {
      sky.close();
    }
  });

  test("with reduced motion: one still frame, and no frame asked for after it", () => {
    const sky = heroSky(true);
    try {
      expect(sky.draws()).toBe(1);
      expect(sky.pending()).toBe(0);
      sky.frames(1000);
      expect(sky.draws()).toBe(1);
    } finally {
      sky.close();
    }
  });
});
