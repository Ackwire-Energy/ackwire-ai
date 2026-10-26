import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "../testing/dom";

setupDom();

import { cleanup, render } from "@testing-library/react";
import {
  agentGradient,
  agentTones,
  EmptyState,
  EYE,
  glowTones,
  mix,
  PixelSky,
  parseColor,
  pixelOf,
  redrawSkies,
  SKY_TONES,
  SkyGlow,
  softTones,
  spriteTone,
  startSky,
} from "../src";

afterEach(() => cleanup());

const opts = { palette: SKY_TONES, base: () => 0.5 };

describe("sky tones", () => {
  test("parses hex (short and long) and rgb(); anything else is mid gray", () => {
    expect(parseColor("#0063d1")).toEqual([0, 99, 209]);
    expect(parseColor("#fff")).toEqual([255, 255, 255]);
    expect(parseColor("rgb(10, 20, 30)")).toEqual([10, 20, 30]);
    expect(parseColor("rgba(10 20 30 / 0.5)")).toEqual([10, 20, 30]);
    expect(parseColor("var(--bg)")).toEqual([128, 128, 128]);
  });

  test("mixes two colors and packs pixels as little-endian RGBA", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("#123456", "#abcdef", 0)).toBe("#123456");
    expect(mix("#123456", "#abcdef", 1)).toBe("#abcdef");
    expect(pixelOf("#0063d1")).toBe(0xffd16300);
  });

  test("an agent's sky goes from deep to light; sky is the landing's tones", () => {
    expect(agentTones("sky")).toEqual(SKY_TONES);
    const violet = agentTones("violet");
    expect(violet).toHaveLength(8);
    expect(violet[2]).toBe(agentGradient("violet")[1]);
    expect(violet[4]).toBe(agentGradient("violet")[0]);
    const light = (c: string) => parseColor(c).reduce((a, b) => a + b, 0);
    expect(light(violet[0] ?? "")).toBeLessThan(light(violet[7] ?? ""));
  });

  test("glows start on the surface, so they meet the page without a seam", () => {
    expect(glowTones("teal", "#f4f4f1")[0]).toBe("#f4f4f1");
    expect(softTones("sky", "#0a0a09")[0]).toBe("#0a0a09");
    expect(softTones("sky", "#0a0a09").at(-1)).not.toBe(agentGradient("sky")[1]);
  });

  test("eyes are white everywhere; the pixel agents' body is the agent's deep tone", () => {
    expect(EYE).toBe("#ffffff");
    expect(spriteTone("sky")).toBe("#04203f");
    const light = (c: string) =>
      (Number.parseInt(c.slice(1, 3), 16) + Number.parseInt(c.slice(3, 5), 16) + Number.parseInt(c.slice(5, 7), 16)) /
      3;
    expect(light(spriteTone("rose"))).toBeLessThan(light(agentGradient("rose")[1]));
  });
});

describe("PixelSky", () => {
  test("a decorative canvas with nothing to read", () => {
    const { container } = render(
      <div>
        <PixelSky options={opts} />
      </div>,
    );
    const canvas = container.querySelector("canvas");
    expect(canvas?.textContent).toBe("");
    expect(canvas?.classList.contains("ac-sky")).toBe(true);
  });

  test("without a 2D context nothing is drawn and the cleanup is safe", () => {
    const host = document.createElement("div");
    const canvas = document.createElement("canvas");
    canvas.getContext = (() => null) as typeof canvas.getContext;
    host.append(canvas);
    const stop = startSky(canvas, () => opts);
    expect(() => stop()).not.toThrow();
  });

  test("the glow is a decorative block", () => {
    const { container } = render(<SkyGlow color="green" />);
    expect(container.querySelector(".ac-sky-glow")?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("EmptyState with sky", () => {
  test("the glow stands in for the icon; the text stays", () => {
    const { container, getByText } = render(
      <EmptyState sky icon="issues" title="Nada aqui">
        Quando alguém abrir uma issue, ela aparece aqui.
      </EmptyState>,
    );
    expect(container.querySelector(".ac-empty--sky .ac-sky-glow")).not.toBeNull();
    expect(container.querySelector(".ac-empty__icon")).toBeNull();
    expect(getByText("Nada aqui")).toBeTruthy();
  });

  test("without sky it keeps the icon (errors, no results)", () => {
    const { container } = render(<EmptyState icon="alert">Falhou</EmptyState>);
    expect(container.querySelector(".ac-empty__icon")).not.toBeNull();
    expect(container.querySelector(".ac-sky")).toBeNull();
  });
});

/**
 * A sky on a page whose frames run by hand (`frames`), with a 2D context that counts what it draws, and the
 * intersection observer's answer in the test's hands (`onScreen`). The page's own frames asked for before (the
 * other tests' skies) run first: the loop is one for the whole page.
 */
async function skyPage(reduced: boolean) {
  await new Promise((r) => setTimeout(r, 100));
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
  g.cancelAnimationFrame = () => {};
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
    (q: string) => ({ matches: reduced && q.includes("reduce") }) as MediaQueryList,
  );
  const host = document.createElement("div");
  const canvas = document.createElement("canvas");
  host.append(canvas);
  document.body.append(host);
  host.getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, right: 40, bottom: 40, width: 40, height: 40 }) as DOMRect;
  Object.defineProperty(canvas, "offsetParent", { get: () => host });
  let draws = 0;
  canvas.getContext = (() => ({
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: () => {
      draws++;
    },
  })) as unknown as typeof canvas.getContext;
  const stop = startSky(canvas, () => opts);
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
      this.frames(100);
      host.remove();
      now.mockRestore();
      media.mockRestore();
      Object.assign(g, {
        requestAnimationFrame: saved.raf,
        cancelAnimationFrame: saved.caf,
        IntersectionObserver: saved.io,
        ResizeObserver: saved.ro,
      });
    },
  };
}

describe("the sky's loop", () => {
  test("moving: about 30 frames a second while on screen, none and no loop off screen", async () => {
    const page = await skyPage(false);
    try {
      expect(page.draws()).toBe(1);
      page.frames(1000);
      expect(page.draws()).toBeGreaterThanOrEqual(29);
      expect(page.draws()).toBeLessThanOrEqual(32);
      page.onScreen(false);
      page.frames(50);
      const drawn = page.draws();
      page.frames(1000);
      expect(page.draws()).toBe(drawn);
      expect(page.pending()).toBe(0);
      page.onScreen(true);
      page.frames(500);
      expect(page.draws()).toBeGreaterThan(drawn + 10);
    } finally {
      page.close();
    }
  });

  test("with reduced motion: one still frame and no loop after it; asked again (a theme, new options), one more", async () => {
    const page = await skyPage(true);
    try {
      expect(page.draws()).toBe(1);
      page.frames(1000);
      expect(page.draws()).toBe(1);
      expect(page.pending()).toBe(0);
      redrawSkies();
      page.frames(1000);
      expect(page.draws()).toBe(2);
      expect(page.pending()).toBe(0);
    } finally {
      page.close();
    }
  });
});
