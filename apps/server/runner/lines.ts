import type { Readable } from "node:stream";

/**
 * Calls `onLine` with each line of a stream (UTF-8, without its newline). A
 * line longer than `max` bytes is never held whole: `onTooLong` is called
 * once and the rest of that line is skipped, so whoever writes to the stream
 * can't grow the reader's memory.
 */
export function readLines(stream: Readable, max: number, onLine: (line: string) => void, onTooLong: () => void) {
  let parts: Buffer[] = [];
  let size = 0;
  let skipping = false;
  stream.on("data", (data: Buffer | string) => {
    let chunk = typeof data === "string" ? Buffer.from(data) : data;
    for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10)) {
      const head = chunk.subarray(0, nl);
      if (!skipping && size + head.length <= max) onLine(Buffer.concat([...parts, head]).toString("utf8"));
      else if (!skipping) onTooLong();
      parts = [];
      size = 0;
      skipping = false;
      chunk = chunk.subarray(nl + 1);
    }
    if (skipping || chunk.length === 0) return;
    if (size + chunk.length > max) {
      parts = [];
      size = 0;
      skipping = true;
      onTooLong();
      return;
    }
    parts.push(chunk);
    size += chunk.length;
  });
}
