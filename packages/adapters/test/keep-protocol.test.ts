import { expect, test } from "bun:test";
import {
  KEEP_RUNNING_PROTOCOL,
  MACHINE_OPS,
  MACHINE_PROTOCOL_VERSION,
  parseRunnerFrame,
  parseServerFrame,
} from "../src/machine-protocol";

/** `keep_running` on the wire (ADR 0176): holds by id, the reasons one ends, nothing else believed. */

const ID = "0193f6b4-1111-7000-8000-000000000001";

test("hello's holds: ids only, each ended one with a reason the server knows", () => {
  expect(MACHINE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(KEEP_RUNNING_PROTOCOL);
  const frame = parseRunnerFrame(
    JSON.stringify({
      type: "hello",
      token: "agm_x",
      version: "1.0.0",
      protocol: KEEP_RUNNING_PROTOCOL,
      holds: {
        live: [ID, "not-a-uuid", 7],
        ended: [
          { id: ID, reason: "expired" },
          { id: ID, reason: "lost" },
          { id: "x", reason: "exited" },
        ],
      },
    }),
  );
  expect(frame?.type === "hello" && frame.holds).toEqual({ live: [ID], ended: [{ id: ID, reason: "expired" }] });
});

test("keep.ended: a hold's id and why; anything else is dropped", () => {
  expect(parseRunnerFrame(JSON.stringify({ type: "keep.ended", holdId: ID, reason: "exited" }))).toEqual({
    type: "keep.ended",
    holdId: ID,
    reason: "exited",
  });
  expect(parseRunnerFrame(JSON.stringify({ type: "keep.ended", holdId: ID, reason: "gone" }))).toBeNull();
  expect(parseRunnerFrame(JSON.stringify({ type: "keep.ended", holdId: "x", reason: "exited" }))).toBeNull();
});

test("the server's keep ops reach a runner that knows them, the request's own id kept apart from the hold's", () => {
  expect(MACHINE_OPS).toContain("keep.start");
  expect(MACHINE_OPS).toContain("keep.end");
  const frame = parseServerFrame(
    JSON.stringify({
      type: "request",
      id: "r1",
      op: "keep.start",
      holdId: ID,
      pid: 4242,
      agent: { id: "a", handle: "a" },
    }),
  );
  expect(frame).toMatchObject({ type: "request", id: "r1", op: "keep.start", holdId: ID, pid: 4242 });
});
