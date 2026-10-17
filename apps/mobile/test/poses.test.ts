import { expect, test } from "bun:test";
import { orbitCells, orbitHead, RING } from "../src/agent/orbit";
import { agentLayout, poseFor, seedOf } from "../src/agent/poses";

test("run: writing eyes", () => {
  expect(poseFor("run", 1, 0.5).writing).toBe(true);
});

test("think: looks up and aside", () => {
  const p = poseFor("think", 3, 1);
  expect(p.turn?.[1]).toBe(-0.3);
  expect(p.look?.[1]).toBe(-0.14);
});

test("rest: eyes closed, still with reduced motion", () => {
  const p = poseFor("rest", 3, 1, true);
  expect(p.expression).toBe("closed");
  expect(p.squash).toBe(0);
});

test("idle: only happy faces and winks", () => {
  for (let t = 0; t < 60; t += 0.5) {
    const e = poseFor("idle", t, 2).expression;
    if (e) expect(["happy", "wink"]).toContain(e);
  }
});

test("seeds are stable and small", () => {
  expect(seedOf("agent-1")).toBe(seedOf("agent-1"));
  expect(seedOf("agent-1")).toBeLessThan(8);
});

test("layout leaves room for an accessory only from 26 points", () => {
  expect(agentLayout(20, true).withAccessory).toBe(false);
  const big = agentLayout(40, true);
  expect(big.withAccessory).toBe(true);
  expect(big.inner).toBeCloseTo(29.6);
  expect(big.y + big.inner).toBeCloseTo(40);
  expect(agentLayout(16, false).cells).toBe(9);
  expect(agentLayout(30, false).cells).toBe(12);
  expect(agentLayout(80, false).cells).toBeUndefined();
});

test("the pixel orbit walks the 3×3 ring with a three-cell tail", () => {
  expect(RING).toHaveLength(8);
  const cells = orbitCells("sky", "#f4f4f1", 3);
  expect(cells.filter((c) => c.opacity === 1)).toHaveLength(3);
  expect(orbitHead(110 * 9)).toBe(1);
  expect(orbitHead(5000, true)).toBe(0);
});
