import { expect, test } from "bun:test";
import {
  BROWSER_LIMITS,
  BROWSER_VIEW_PROTOCOL,
  decodeBrowserFrame,
  encodeBrowserFrame,
  MACHINE_OPS,
  MACHINE_PROTOCOL_VERSION,
  parseServerFrame,
  parseStreamControl,
} from "../src/machine-protocol";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const META = {
  deviceWidth: 1280,
  deviceHeight: 800,
  pageScaleFactor: 1,
  url: "https://shop.example.com/",
  title: "Shop",
};

test("protocol 46: browser.view.open names the live view's data socket (ADR 0040 §7.1)", () => {
  expect(MACHINE_PROTOCOL_VERSION).toBeGreaterThanOrEqual(BROWSER_VIEW_PROTOCOL);
  expect(MACHINE_OPS).toContain("browser.view.open");
  const open = { type: "request", id: "r1", op: "browser.view.open", streamId: "x".repeat(43) };
  expect(parseServerFrame(JSON.stringify(open))).toMatchObject({ op: "browser.view.open", streamId: "x".repeat(43) });
  // The server's answer to each frame on that socket.
  expect(parseStreamControl(JSON.stringify({ type: "ack" }))).toEqual({ type: "ack" });
});

test("a frame's bytes: version, header length, JSON header, then the JPEG, read back as sent", () => {
  const bytes = encodeBrowserFrame({ seq: 7, metadata: META }, JPEG);
  expect(bytes[0]).toBe(1);
  const length = new DataView(bytes.buffer).getUint32(1);
  expect(JSON.parse(new TextDecoder().decode(bytes.subarray(5, 5 + length)))).toEqual({ seq: 7, metadata: META });
  expect([...bytes.subarray(5 + length)]).toEqual([...JPEG]);
  const back = decodeBrowserFrame(bytes);
  expect(back?.seq).toBe(7);
  expect(back?.metadata).toEqual(META);
  expect([...(back?.jpeg ?? [])]).toEqual([...JPEG]);
  // Read from inside a larger buffer too (a socket's message may be a view of one).
  const padded = new Uint8Array(bytes.byteLength + 8);
  padded.set(bytes, 4);
  expect(decodeBrowserFrame(padded.subarray(4, 4 + bytes.byteLength))?.seq).toBe(7);
});

test("bytes that aren't a frame read as null; the header is checked like a browser.frame", () => {
  const good = encodeBrowserFrame({ seq: 1, metadata: META }, JPEG);
  expect(decodeBrowserFrame(new Uint8Array([2, ...good.subarray(1)]))).toBeNull();
  expect(decodeBrowserFrame(good.subarray(0, 5))).toBeNull();
  // A header with no picture after it.
  const head = new TextEncoder().encode(JSON.stringify({ seq: 1, metadata: META }));
  const bare = new Uint8Array(5 + head.byteLength);
  bare[0] = 1;
  new DataView(bare.buffer).setUint32(1, head.byteLength);
  bare.set(head, 5);
  expect(decodeBrowserFrame(bare)).toBeNull();
  const noSize = encodeBrowserFrame({ seq: 1, metadata: { url: "x" } as never }, JPEG);
  expect(decodeBrowserFrame(noSize)).toBeNull();
  // An address and a title are cut to the limits, as on `browser.frame`.
  const long = encodeBrowserFrame(
    { seq: 1, metadata: { ...META, title: "t".repeat(BROWSER_LIMITS.title + 50) } },
    JPEG,
  );
  expect(decodeBrowserFrame(long)?.metadata.title).toHaveLength(BROWSER_LIMITS.title);
});
