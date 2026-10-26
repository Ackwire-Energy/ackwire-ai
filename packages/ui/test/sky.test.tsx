import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "../testing/dom";
import { canvasPage } from "../testing/frames";

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
import { lightToward, opaque } from "../src/sky/math";

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

  test("an rgba token as the solid color it shows over a surface (the email palette's hairlines)", () => {
    expect(opaque("rgba(23, 23, 22, 0.12)", "#ffffff")).toBe("#e3e3e3");
    expect(opaque("rgba(255, 255, 255, 0.15)", "#1c1c1b")).toBe("#3e3e3d");
    expect(opaque("rgba(23 23 22 / 0.07)", "#f3f3f0")).toBe("#e4e4e1");
    expect(opaque("#151514", "#ffffff")).toBe("#151514");
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

test("the pointer light follows at the same pace at any frame rate: 5% of the way each 60th of a second", () => {
  expect(lightToward(0, 1, 1 / 60)).toBeCloseTo(0.05, 10);
  let at60 = 0;
  for (let i = 0; i < 60; i++) at60 = lightToward(at60, 1, 1 / 60);
  let at30 = 0;
  for (let i = 0; i < 30; i++) at30 = lightToward(at30, 1, 1 / 30);
  expect(at30).toBeCloseTo(at60, 10);
  expect(at60).toBeCloseTo(1 - 0.95 ** 60, 10);
  // The pointer far off the sky: the light stops 0.3 past its edge.
  expect(lightToward(0, 5, 60)).toBeCloseTo(1.3, 10);
  expect(lightToward(0, -5, 60)).toBeCloseTo(-0.3, 10);
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

describe("the sky's loop", () => {
  /**
   * A sky on a page whose frames run by hand. The page's own frames asked for before (the other tests' skies) run
   * first: the loop is one for the whole page.
   */
  async function skyPage(reduced: boolean) {
    await new Promise((r) => setTimeout(r, 100));
    const page = canvasPage({ width: 40, height: 40, reduced });
    const stop = startSky(page.canvas, () => opts);
    const close = page.close;
    return Object.assign(page, {
      close() {
        stop();
        page.frames(100);
        close();
      },
    });
  }

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

  test("hidden and shown again before the observer called (a phone's width and back): on screen, so new options still draw", async () => {
    const page = await skyPage(true);
    try {
      page.onScreen(false, true);
      page.frames(100);
      // The onboarding's progress bar: a step done is new options, drawn once more.
      redrawSkies();
      page.frames(1000);
      expect(page.draws()).toBe(2);
      // The other way round, it is off screen: nothing more until it shows again.
      page.onScreen(true, false);
      redrawSkies();
      page.frames(1000);
      expect(page.draws()).toBe(2);
      page.onScreen(true);
      page.frames(1000);
      expect(page.draws()).toBe(3);
    } finally {
      page.close();
    }
  });

  test("reduced motion switched while the page is open: a still sky starts moving, a moving one stops", async () => {
    const page = await skyPage(true);
    try {
      page.frames(1000);
      expect(page.draws()).toBe(1);
      // Motion allowed again (the system's switch, a browser's emulated media): about 30 frames a second at once.
      page.motion(false);
      page.frames(1000);
      expect(page.draws()).toBeGreaterThanOrEqual(29);
      // Reduced again: one still frame with the setting, then no loop.
      page.motion(true);
      page.frames(100);
      const drawn = page.draws();
      page.frames(1000);
      expect(page.draws()).toBe(drawn);
      expect(page.pending()).toBe(0);
      expect(page.listening()).toBe(1);
    } finally {
      page.close();
    }
    // Stopped, the sky no longer listens.
    expect(page.listening()).toBe(0);
  });
});
