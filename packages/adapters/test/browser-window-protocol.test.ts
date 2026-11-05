import { expect, test } from "bun:test";
import {
  BROWSER_FRAME_WINDOW,
  BROWSER_WINDOW_PROTOCOL,
  MACHINE_PROTOCOL_VERSION,
  parseServerFrame,
} from "../src/machine-protocol";

test("protocol 46: the live view's frame window (ADR 0040 §7.1)", () => {
  expect(MACHINE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(BROWSER_WINDOW_PROTOCOL);
  expect(BROWSER_FRAME_WINDOW).toBeGreaterThan(0);
  const start = { type: "request", id: "r1", op: "browser.stream.start", mode: "watch", window: 2 };
  expect(parseServerFrame(JSON.stringify(start))).toMatchObject({ op: "browser.stream.start", window: 2 });
});

test("browser.ack names the agent and the frame; anything else isn't one", () => {
  expect(parseServerFrame(JSON.stringify({ type: "browser.ack", agentId: "a1", seq: 3 }))).toEqual({
    type: "browser.ack",
    agentId: "a1",
    seq: 3,
  });
  expect(parseServerFrame(JSON.stringify({ type: "browser.ack", seq: 3 }))).toBeNull();
  expect(parseServerFrame(JSON.stringify({ type: "browser.ack", agentId: "a1", seq: "3" }))).toBeNull();
});
