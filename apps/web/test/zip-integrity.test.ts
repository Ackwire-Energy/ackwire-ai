import { expect, test } from "bun:test";
import { readZip, ZipError } from "@agenteschat/client/lib/zip";
import { zip } from "./archives";

const blob = (bytes: Uint8Array) => new Blob([bytes.slice()]);
const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const directory = (bytes: Uint8Array) => viewOf(bytes).getUint32(bytes.length - 6, true);

test.each([false, true])(
  "a truncated entry cannot succeed with fewer bytes than declared (deflate: %s)",
  async (deflate) => {
    const entries = await readZip(blob(zip({ "file.txt": "hello" }, { "file.txt": 10 }, { deflate })));
    await expect(entries[0]?.read()).rejects.toEqual(new ZipError("corrupt"));
  },
);

test("ZIP64 sizes must fit inside their own extra field", async () => {
  const original = zip({ "file.txt": "hello" });
  const at = original.length - 22;
  const bytes = new Uint8Array(original.length + 12);
  bytes.set(original.subarray(0, at));
  bytes.set(original.subarray(at), at + 12);
  const view = viewOf(bytes);
  const central = directory(bytes);
  view.setUint32(central + 24, 0xffffffff, true);
  view.setUint16(central + 30, 12, true);
  view.setUint16(at, 1, true);
  // The following empty extra fields would be misread as the ZIP64 size 5.
  view.setUint16(at + 4, 5, true);
  view.setUint32(bytes.length - 10, at - central + 12, true);
  await expect(readZip(blob(bytes))).rejects.toEqual(new ZipError("corrupt"));
});

test("valid ZIP64 entry sizes and offsets remain readable", async () => {
  const original = zip({ "file.txt": "hello" });
  const at = original.length - 22;
  const bytes = new Uint8Array(original.length + 28);
  bytes.set(original.subarray(0, at));
  bytes.set(original.subarray(at), at + 28);
  const view = viewOf(bytes);
  const central = directory(bytes);
  for (const field of [20, 24, 42]) view.setUint32(central + field, 0xffffffff, true);
  view.setUint16(central + 30, 28, true);
  view.setUint16(at, 1, true);
  view.setUint16(at + 2, 24, true);
  view.setBigUint64(at + 4, 5n, true);
  view.setBigUint64(at + 12, 5n, true);
  view.setBigUint64(at + 20, 0n, true);
  view.setUint32(bytes.length - 10, at - central + 28, true);
  const entries = await readZip(blob(bytes));
  expect(new TextDecoder().decode(await entries[0]?.read())).toBe("hello");
});

test("valid stored, deflated, and ZIP64 archives still return the file bytes", async () => {
  for (const deflate of [false, true]) {
    const entries = await readZip(blob(zip({ "file.txt": "hello" }, {}, { deflate })));
    expect(new TextDecoder().decode(await entries[0]?.read())).toBe("hello");
  }
  const original = zip({ "file.txt": "hello" });
  const record = original.length - 22;
  const bytes = new Uint8Array(original.length + 76);
  bytes.set(original.subarray(0, record));
  bytes.set(original.subarray(record), record + 76);
  const view = viewOf(bytes);
  view.setUint32(record, 0x06064b50, true);
  view.setBigUint64(record + 4, 44n, true);
  view.setBigUint64(record + 24, 1n, true);
  view.setBigUint64(record + 32, 1n, true);
  view.setBigUint64(record + 40, BigInt(record - directory(original)), true);
  view.setBigUint64(record + 48, BigInt(directory(original)), true);
  view.setUint32(record + 56, 0x07064b50, true);
  view.setBigUint64(record + 64, BigInt(record), true);
  view.setUint32(record + 72, 1, true);
  view.setUint16(record + 86, 0xffff, true);
  view.setUint32(record + 92, 0xffffffff, true);
  const entries = await readZip(blob(bytes));
  expect(new TextDecoder().decode(await entries[0]?.read())).toBe("hello");
});
