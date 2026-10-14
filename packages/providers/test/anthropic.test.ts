import { describe, expect, test } from "bun:test";
import { createAnthropicProvider, ProviderError } from "../src";

const sse = (events: Record<string, unknown>[], tail?: string) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("") + (tail ?? "");

/** A fetch that records the request body and answers with a scripted SSE stream. No network. */
function scripted(body: string, status = 200) {
  const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")),
      headers: new Headers(init?.headers),
    });
    return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fetcher, requests };
}

const start = (input: number) => ({
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5-5",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 7, cache_creation_input_tokens: 0 },
  },
});

describe("Anthropic adapter (scripted transport)", () => {
  test("maps tools, structured output, cache breakpoints, opaque replay; returns neutral blocks", async () => {
    const { fetcher, requests } = scripted(
      sse([
        start(25),
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "sig" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Let me check." } },
        { type: "content_block_stop", index: 1 },
        {
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use", id: "toolu_1", name: "github__merge", input: {} },
        },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"pr":42}' } },
        { type: "content_block_stop", index: 2 },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 12 },
        },
        { type: "message_stop" },
      ]),
    );
    const provider = createAnthropicProvider({ fetch: fetcher, maxRetries: 0 });
    const deltas: string[] = [];
    const result = await provider.stream(
      {
        model: "claude-sonnet-5-5",
        system: [{ text: "org", cache: true }, { text: "agent", cache: true }, { text: "where" }],
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [
              { type: "opaque", provider: "anthropic", data: { type: "thinking", thinking: "", signature: "abc" } },
              { type: "tool_use", id: "toolu_0", name: "search_context", input: { query: "x" } },
            ],
          },
          { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_0", content: "nothing", isError: true }] },
        ],
        maxTokens: 1000,
        tools: [
          { name: "z_tool", description: "z", inputSchema: { type: "object" } },
          { name: "a_tool", description: "a", inputSchema: { type: "object" } },
        ],
        outputSchema: { type: "object" },
        effort: "low",
      },
      { apiKey: "sk-test", onDelta: (d) => deltas.push(d) },
    );

    const body = requests[0]?.body as Record<string, unknown>;
    expect(requests[0]?.headers.get("x-api-key")).toBe("sk-test");
    expect(body.system).toEqual([
      { type: "text", text: "org", cache_control: { type: "ephemeral" } },
      { type: "text", text: "agent", cache_control: { type: "ephemeral" } },
      { type: "text", text: "where" },
    ]);
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect((body.tools as { name: string }[]).map((t) => t.name)).toEqual(["a_tool", "z_tool"]);
    expect((body.tools as Record<string, unknown>[])[0]).toMatchObject({ eager_input_streaming: true });
    expect(body.output_config).toEqual({ format: { type: "json_schema", schema: { type: "object" } }, effort: "low" });
    expect((body.messages as Record<string, unknown>[])[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "abc" },
        { type: "tool_use", id: "toolu_0", name: "search_context", input: { query: "x" } },
      ],
    });
    expect((body.messages as Record<string, unknown>[])[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_0", content: "nothing", is_error: true }],
    });

    expect(deltas).toEqual(["Let me check."]);
    expect(result.stopReason).toBe("tool_use");
    expect(result.text).toBe("Let me check.");
    expect(result.content).toEqual([
      { type: "opaque", provider: "anthropic", data: { type: "thinking", thinking: "", signature: "sig" } },
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "toolu_1", name: "github__merge", input: { pr: 42 } },
    ]);
    expect(result.usage).toEqual({ inputTokens: 25, outputTokens: 12, cacheReadTokens: 7, cacheWriteTokens: 0 });
  });

  test("a stream that breaks midway reports the usage seen so far", async () => {
    const { fetcher } = scripted(
      sse(
        [
          start(321),
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Half of" } },
        ],
        `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`,
      ),
    );
    const provider = createAnthropicProvider({ fetch: fetcher, maxRetries: 0 });
    const error = await provider
      .stream(
        { model: "claude-haiku-5-5", system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 100 },
        { apiKey: "k", onDelta: () => {} },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).partial).toEqual({
      inputTokens: 321,
      cacheReadTokens: 7,
      cacheWriteTokens: 0,
      outputTokens: null,
      outputChars: 7,
    });
  });
});

test("a workspace id is sent as the anthropic-workspace-id header", async () => {
  const { fetcher, requests } = scripted(
    sse([
      start(1),
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]),
  );
  const provider = createAnthropicProvider({ fetch: fetcher, maxRetries: 0 });
  await provider.stream(
    { model: "claude-haiku-5-5", system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 10 },
    { apiKey: "k", workspaceId: "wrkspc_123", onDelta: () => {} },
  );
  expect(requests[0]?.headers.get("anthropic-workspace-id")).toBe("wrkspc_123");
  await provider.stream(
    { model: "claude-haiku-5-5", system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 10 },
    { apiKey: "k", onDelta: () => {} },
  );
  expect(requests[1]?.headers.get("anthropic-workspace-id")).toBeNull();
});
