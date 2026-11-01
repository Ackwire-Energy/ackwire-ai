import { describe, expect, test } from "bun:test";
import {
  AGENT_GRADIENTS,
  bodyPath,
  bodyTones,
  customGradient,
  EYE_COLOR,
  EYE_STYLES,
  eyeShapes,
  gradientOf,
  hexToHsv,
  hsvToHex,
  inBody,
  luminance,
  nearestPreset,
  pickerStart,
  spriteBody,
  spriteGrid,
} from "../src/agent/engine.js";
import { agentGradient, appearanceStyle, normalizeAppearance } from "../src/components/AgentLook";
import { SPRITE } from "../src/sky/engine";

describe("agent engine: one agent everywhere", () => {
  test("the eyes are white and mirror each other around the middle, in every style and pose", () => {
    expect(EYE_COLOR).toBe("#ffffff");
    for (const style of Object.keys(EYE_STYLES)) {
      for (const pose of [{}, { writing: true }, { blink: true }]) {
        const [l, r] = eyeShapes(style, pose);
        expect(l && r).toBeTruthy();
        if (!l || !r) continue;
        expect(l.x + l.w / 2 + (r.x + r.w / 2)).toBeCloseTo(1, 6);
        expect(l.y).toBe(r.y);
        expect(l.w).toBe(r.w);
      }
    }
  });

  test("writing turns any style into short dashes; blinking closes them", () => {
    const [dash] = eyeShapes("happy", { writing: true });
    expect(dash?.kind).toBe("pill");
    expect(dash && dash.w > dash.h).toBe(true);
    const [open] = eyeShapes("round");
    const [closed] = eyeShapes("round", { blink: true });
    expect((closed?.h ?? 1) < (open?.h ?? 0)).toBe(true);
  });

  test("the sky's pixel agent is the same shape: cut corner at bottom-left, two eyes, symmetric", () => {
    const g = spriteGrid(9);
    expect(SPRITE).toEqual(g);
    expect(g[0]?.[0]).toBe(".");
    expect(g[8]?.[0]).toBe("X");
    expect(g[8]?.[8]).toBe(".");
    const eyes = g.flatMap((row, y) => [...row].flatMap((c, x) => (c === "o" ? [[x, y]] : [])));
    expect(eyes.length).toBeGreaterThanOrEqual(2);
    for (const [x, y] of eyes) expect(g[y as number]?.[8 - (x as number)]).toBe("o");
  });

  test("colors, tones and shape agree with the components", () => {
    expect(agentGradient("rose")).toEqual(AGENT_GRADIENTS.rose);
    const light = (c: string) => [1, 3, 5].reduce((s, i) => s + Number.parseInt(c.slice(i, i + 2), 16), 0);
    const tones = bodyTones("teal");
    expect(light(tones[0] ?? "")).toBeLessThan(light(tones[4] ?? ""));
    expect(light(bodyTones("teal", true)[4] ?? "")).toBeLessThan(light(tones[4] ?? ""));
    expect(spriteBody("sky")).toBe("#04203f");
    expect(inBody(0.5, 0.5)).toBe(true);
    expect(inBody(0.01, 0.01)).toBe(false);
    expect(inBody(0.04, 0.96)).toBe(true);
    expect(bodyPath(0, 0, 1).startsWith("M")).toBe(true);
  });

  test("a custom #rrggbb is built like the presets and kept readable", () => {
    // A preset's own bottom comes back as the bottom, with a lighter top of the same hue.
    for (const [top, bottom] of Object.values(AGENT_GRADIENTS)) {
      const [ctop, cbottom] = customGradient(bottom);
      expect(cbottom).toBe(bottom);
      expect(luminance(ctop)).toBeGreaterThan(luminance(bottom));
      expect(Math.abs(hexToHsv(ctop)[0] - hexToHsv(top)[0]) % 360).toBeLessThan(12);
    }
    // Extremes are clamped: white eyes still read (about 3:1) and the body never vanishes into black.
    for (const hex of ["#ffffff", "#ffff00", "#00ff00", "#000000", "#00ffff", "#7f7f7f"]) {
      const [top, bottom] = customGradient(hex);
      expect(luminance(bottom)).toBeLessThanOrEqual(0.28);
      expect(luminance(bottom)).toBeGreaterThan(0.05);
      expect(luminance(top)).toBeGreaterThan(luminance(bottom));
    }
    expect(gradientOf("#0063D1")).toEqual(customGradient("#0063d1"));
    expect(gradientOf("rose")).toEqual(AGENT_GRADIENTS.rose);
    expect(gradientOf("#12345")).toEqual(AGENT_GRADIENTS.sky);
    expect(bodyTones("#1f8a4c").slice(0, 2)).toEqual(bodyTones("green").slice(0, 2));
  });

  test("a custom top never washes out more than amber's (the light tones behind the eyes)", () => {
    const behindEyes = (color: string) => 1.05 / (luminance(bodyTones(color)[2] ?? "") + 0.05);
    const amber = behindEyes("amber");
    for (const hex of ["#ffff00", "#00ffff", "#00ff00", "#ffffff", "#ccff00", "#ffd000"]) {
      expect(behindEyes(hex)).toBeGreaterThanOrEqual(amber - 0.01);
      expect(luminance(gradientOf(hex)[0])).toBeLessThanOrEqual(0.59);
    }
  });

  test("a custom color maps to the closest preset by hue, graphite when nearly gray", () => {
    for (const name of Object.keys(AGENT_GRADIENTS)) expect(nearestPreset(name)).toBe(name as never);
    expect(nearestPreset("#e0457b")).toBe("rose");
    expect(nearestPreset("#ffd000")).toBe("amber");
    expect(nearestPreset("#20c060")).toBe("green");
    expect(nearestPreset("#808080")).toBe("graphite");
    expect(nearestPreset("nonsense")).toBe("sky");
  });

  test("the picker starts from the current color: a preset's own tone, a custom one as is", () => {
    expect(pickerStart("amber")).toBe(AGENT_GRADIENTS.amber[1]);
    expect(pickerStart("#ABCDEF")).toBe("#abcdef");
    expect(pickerStart(undefined)).toBe(AGENT_GRADIENTS.sky[1]);
  });

  test("hex and hsv round-trip (the picker's area and hue slider)", () => {
    for (const hex of ["#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff", "#1a2b3c", "#c07d0b", "#808080"]) {
      const [h, s, v] = hexToHsv(hex);
      expect(hsvToHex(h, s, v)).toBe(hex);
    }
    expect(hexToHsv("#ff0000")).toEqual([0, 1, 1]);
    expect(hsvToHex(240, 1, 1)).toBe("#0000ff");
  });

  test("a stored custom color survives normalizing and paints the symbol", () => {
    expect(normalizeAppearance({ color: "#ABCDEF" }).color).toBe("#abcdef");
    expect(normalizeAppearance({ color: "#abc" }).color).toBeUndefined();
    expect(normalizeAppearance({ color: "teal" }).color).toBe("teal");
    const [top, bottom] = customGradient("#abcdef");
    expect(appearanceStyle({ color: "#abcdef" })).toEqual({ "--av-top": top, "--av-bottom": bottom } as never);
  });
});
