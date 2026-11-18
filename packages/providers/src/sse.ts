/**
 * The `data` of each server-sent event in a response body, its `data:` lines joined, for an API spoken over plain
 * `fetch` (the SDKs read their own streams). Lines may end in LF, CR or CRLF, and an event may span chunks.
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let afterCr = false;
  try {
    for (let done = false; !done; ) {
      const chunk = await reader.read();
      done = chunk.done;
      let text = decoder.decode(chunk.value, { stream: !done });
      if (text) {
        // A CR already ended its line; a following LF is its second byte, even in another chunk.
        if (afterCr && text.startsWith("\n")) text = text.slice(1);
        afterCr = text.endsWith("\r");
        buffer += text.replace(/\r\n?/g, "\n");
      }
      const events = buffer.split("\n\n");
      buffer = done ? "" : (events.pop() ?? "");
      for (const event of events) {
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
          .join("\n");
        if (data) yield data;
      }
    }
  } finally {
    // A reader that stops early (an error event, a reply it can't read) closes the connection.
    reader.cancel().catch(() => {});
  }
}
