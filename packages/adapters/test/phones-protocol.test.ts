import { expect, test } from "bun:test";
import { PHONES_PROTOCOL, parseRunnerFrame } from "../src/machine-protocol";

const pixel = {
  platform: "android",
  serial: "33141FDH2000AB",
  kind: "device",
  model: "Pixel 8",
  osVersion: "16",
  state: "ready",
  transport: "usb",
  screen: { width: 1080, height: 2400 },
  battery: 81,
  holder: { runId: "r1", agentId: "a1", userId: "u1", label: "Recording a test video", since: "2026-11-09T10:00:00Z" },
};

test("hello carries the phones and toolchains the host reports, each field checked", () => {
  const frame = parseRunnerFrame(
    JSON.stringify({
      type: "hello",
      token: "agm_x",
      version: "1.0.0",
      protocol: PHONES_PROTOCOL,
      phones: [
        pixel,
        { ...pixel, serial: "emulator-5554", kind: "emulator", state: "needs_you", reason: "booting", holder: null },
        { platform: "symbian", serial: "x", state: "ready" },
        { platform: "ios", serial: "", state: "ready" },
        { platform: "ios", serial: "u", state: "sleeping" },
        { ...pixel, serial: "b", reason: "Not A Code!", battery: 400, transport: "bluetooth" },
      ],
      toolchains: { adb: "35.0.2", xcode: "27.0", rogue: "1", java: 17 },
    }),
  );
  if (frame?.type !== "hello") throw new Error("not a hello");
  expect(frame.toolchains).toEqual({ adb: "35.0.2", xcode: "27.0" });
  expect(frame.phones?.map((p) => p.serial)).toEqual(["33141FDH2000AB", "emulator-5554", "b"]);
  expect(frame.phones?.[0]).toMatchObject({
    model: "Pixel 8",
    holder: { runId: "r1", label: "Recording a test video" },
  });
  expect(frame.phones?.[1]).toMatchObject({ kind: "emulator", reason: "booting", holder: null });
  expect(frame.phones?.[2]).not.toHaveProperty("reason");
  expect(frame.phones?.[2]).not.toHaveProperty("battery");
  expect(frame.phones?.[2]).not.toHaveProperty("transport");
});

test("phones.changed carries the whole list; one without a list is no frame", () => {
  expect(parseRunnerFrame(JSON.stringify({ type: "phones.changed", phones: [] }))).toEqual({
    type: "phones.changed",
    phones: [],
  });
  expect(parseRunnerFrame(JSON.stringify({ type: "phones.changed" }))).toBeNull();
});
