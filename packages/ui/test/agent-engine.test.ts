import { describe, expect, test } from "bun:test";
import {
  AGENT_GRADIENTS,
  bodyPath,
  bodyTones,
  EYE_COLOR,
  EYE_STYLES,
  eyeShapes,
  inBody,
  spriteBody,
  spriteGrid,
} from "../src/agent/engine.js";
import { agentGradient } from "../src/components/AgentLook";
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
});
