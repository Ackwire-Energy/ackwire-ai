import { describe, expect, test } from "bun:test";
import { parseAgentPointer, parseRunnerFrame } from "../src/machine-protocol";

const frame = (extra: Record<string, unknown>) =>
  parseRunnerFrame(JSON.stringify({ agentId: "a1", x: 320, y: 200, width: 1280, height: 800, act: "click", ...extra }));

describe("the agent's pointer on the wire", () => {
  test("a point on its page and on its desktop, with what it does there", () => {
    expect(frame({ type: "browser.pointer" })).toEqual({
      type: "browser.pointer",
      agentId: "a1",
      x: 320,
      y: 200,
      width: 1280,
      height: 800,
      act: "click",
    });
    expect(frame({ type: "desktop.pointer", act: "type" })).toMatchObject({ type: "desktop.pointer", act: "type" });
  });

  test("a point past the surface lands on its edge, in whole pixels", () => {
    expect(parseAgentPointer({ x: 1500.6, y: -4, width: 1280, height: 800, act: "move" })).toEqual({
      x: 1280,
      y: 0,
      width: 1280,
      height: 800,
      act: "move",
    });
  });

  test("no agent, no size, an unknown act or a number that isn't one: dropped", () => {
    expect(frame({ type: "browser.pointer", agentId: 7 })).toBeNull();
    expect(frame({ type: "browser.pointer", width: 0 })).toBeNull();
    expect(frame({ type: "browser.pointer", height: 99_999 })).toBeNull();
    expect(frame({ type: "browser.pointer", act: "smash" })).toBeNull();
    expect(frame({ type: "desktop.pointer", x: "12" })).toBeNull();
    expect(frame({ type: "desktop.pointer", y: Number.NaN })).toBeNull();
  });
});
