import { expect, test } from "bun:test";
import { readCapped } from "../src/read-capped";

test("a response rejected from Content-Length closes its body without reading it", async () => {
  let canceled = false;
  let pulled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        pulled = true;
      },
      cancel() {
        canceled = true;
      },
    },
    { highWaterMark: 0 },
  );
  expect(await readCapped(new Response(body, { headers: { "content-length": "100" } }), 10)).toBeNull();
  expect(canceled).toBe(true);
  expect(pulled).toBe(false);
  expect(body.locked).toBe(false);
});

test("readCapped releases its reader after success, overflow and a failed read", async () => {
  for (const limit of [1, 5]) {
    const res = new Response("hello");
    const result = await readCapped(res, limit);
    expect(result === null).toBe(limit < 5);
    expect(res.body?.locked).toBe(false);
  }
  const error = new Error("connection lost");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(error);
    },
  });
  await expect(readCapped(new Response(body), 10)).rejects.toBe(error);
  expect(body.locked).toBe(false);
});

test("a failed cancellation keeps the size-limit result", async () => {
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      throw new Error("already closed");
    },
  });
  expect(await readCapped(new Response(body, { headers: { "content-length": "100" } }), 10)).toBeNull();
});
