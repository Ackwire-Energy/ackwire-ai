import { expect, test } from "bun:test";
import { INK_ALPHAS, inkOrbitCells, orbitCells, orbitHead, RING, STOP_CELLS, stopTurn } from "../src/agent/orbit";
import { agentLayout, framedByDefault, framedLayout, poseFor, seedOf } from "../src/agent/poses";

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

test("framed: list and chat faces get the sky tile, tiny faces and heroes don't (like the web)", () => {
  expect(framedByDefault(18)).toBe(false);
  expect(framedByDefault(32)).toBe(true);
  expect(framedByDefault(50)).toBe(true);
  expect(framedByDefault(78)).toBe(false);
});

test("framed layout: the agent stands centered above the bottom edge, smaller with an accessory", () => {
  const plain = framedLayout(50, false);
  expect(plain.inner).toBeCloseTo(33);
  expect(plain.x).toBeCloseTo(8.5);
  expect(plain.y + plain.inner).toBeCloseTo(50 - 7);
  const hat = framedLayout(50, true);
  expect(hat.withAccessory).toBe(true);
  expect(hat.inner).toBeLessThan(plain.inner);
  expect(framedLayout(22, true).withAccessory).toBe(false);
});

test("the ink orbit: the head in full ink, a fading trail, the rest faint", () => {
  const cells = inkOrbitCells(2);
  expect(cells).toHaveLength(8);
  expect(cells[2]?.opacity).toBe(INK_ALPHAS[0]);
  expect(cells[1]?.opacity).toBe(INK_ALPHAS[1]);
  expect(cells[0]?.opacity).toBe(INK_ALPHAS[2]);
  expect(cells[3]?.opacity).toBe(INK_ALPHAS[3]);
});

test("the 2×2 stop square: one cell dims in turn every 220 ms, none when still", () => {
  expect(STOP_CELLS).toHaveLength(4);
  expect(stopTurn(0)).toBe(0);
  expect(stopTurn(230)).toBe(1);
  expect(stopTurn(4 * 220)).toBe(0);
  expect(stopTurn(500, true)).toBe(-1);
});
