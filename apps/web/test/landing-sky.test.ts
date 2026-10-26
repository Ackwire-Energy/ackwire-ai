import { describe, expect, test } from "bun:test";
import { canvasPage, setupDom } from "@agenteschat/ui/testing";

setupDom();

import { HERO_SKY, startSky } from "../src/pages/landing/sky";

/** The hero's sky on a page whose frames run by hand. */
function heroSky(reduced: boolean) {
  const page = canvasPage({ width: 80, height: 60 });
  const stop = startSky(page.canvas, () => ({ pixel: 4, sprites: true, ...HERO_SKY }), reduced);
  const close = page.close;
  return Object.assign(page, {
    close() {
      stop();
      close();
    },
  });
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
