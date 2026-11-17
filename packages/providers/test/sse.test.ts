import { expect, test } from "bun:test";
import { sseData } from "../src/sse";

async function read(chunks: string[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const events: string[] = [];
  for await (const event of sseData(body)) events.push(event);
  return events;
}

test("SSE accepts CR, LF and CRLF line endings, including CRLF split between chunks", async () => {
  expect(await read(["data: first\r\rdata: second\r\r"])).toEqual(["first", "second"]);
  expect(await read(["data: first\r", "\ndata: second\r", "\n\r", "\ndata: third\n\n"])).toEqual([
    "first\nsecond",
    "third",
  ]);
  expect(await read(["data: a\rdata: b\n\rdata: c\r\n\n"])).toEqual(["a\nb", "c"]);
});

test("SSE carries data across chunks and retains a provider's final unterminated event", async () => {
  expect(await read([": heartbeat\r\n", 'data: {"ok":', "true}\r\rdata: [DONE]"])).toEqual(['{"ok":true}', "[DONE]"]);
});
