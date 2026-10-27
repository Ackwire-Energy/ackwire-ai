import { describe, expect, test } from "bun:test";
import { cheapModelOf, costNanoUsd, createOpenAIProvider, MODEL_CATALOG, ProviderError } from "../src";

const sse = (events: Record<string, unknown>[], tail = "") =>
  events.map((e, i) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`).join("") + tail;

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

const baseResponse = (extra: Record<string, unknown>) => ({
  id: "resp_1",
  object: "response",
  created_at: 1,
  model: "gpt-6-sol-2026-09",
  status: "completed",
  incomplete_details: null,
  output: [],
  usage: {
    input_tokens: 1000,
    input_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 },
    output_tokens: 50,
    output_tokens_details: { reasoning_tokens: 10 },
    total_tokens: 1050,
  },
  ...extra,
});

describe("OpenAI adapter (Responses API, scripted transport)", () => {
  test("maps instructions, input items, tools, JSON Schema and effort; returns neutral blocks and split usage", async () => {
    const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" };
    const output = [
      reasoning,
      {
        type: "message",
        id: "m1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "Checking.", annotations: [] }],
      },
      {
        type: "function_call",
        id: "fc1",
        call_id: "call_1",
        name: "github_get_pr",
        arguments: '{"pr":42}',
        status: "completed",
      },
    ];
    const msgItem = output[1] as Record<string, unknown>;
    const callItem = output[2] as Record<string, unknown>;
    const { fetcher, requests } = scripted(
      sse([
        { type: "response.created", response: baseResponse({ status: "in_progress", output: [] }) },
        { type: "response.output_item.added", output_index: 0, item: reasoning },
        { type: "response.output_item.done", output_index: 0, item: reasoning },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { ...msgItem, status: "in_progress", content: [] },
        },
        {
          type: "response.content_part.added",
          item_id: "m1",
          output_index: 1,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          item_id: "m1",
          output_index: 1,
          content_index: 0,
          delta: "Check",
          logprobs: [],
        },
        {
          type: "response.output_text.delta",
          item_id: "m1",
          output_index: 1,
          content_index: 0,
          delta: "ing.",
          logprobs: [],
        },
        { type: "response.output_item.done", output_index: 1, item: msgItem },
        {
          type: "response.output_item.added",
          output_index: 2,
          item: { ...callItem, arguments: "", status: "in_progress" },
        },
        { type: "response.function_call_arguments.delta", item_id: "fc1", output_index: 2, delta: '{"pr":42}' },
        { type: "response.output_item.done", output_index: 2, item: callItem },
        { type: "response.completed", response: baseResponse({ output }) },
      ]),
    );
    const provider = createOpenAIProvider({ fetch: fetcher, maxRetries: 0 });
    const deltas: string[] = [];
    const result = await provider.stream(
      {
        model: "gpt-6-sol",
        system: [{ text: "org", cache: true }, { text: "agent" }],
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: [
              { type: "opaque", provider: "anthropic", data: { type: "thinking" } },
              { type: "opaque", provider: "openai", data: reasoning },
              { type: "tool_use", id: "call_0", name: "search_context", input: { query: "x" } },
            ],
          },
          { role: "user", content: [{ type: "tool_result", toolUseId: "call_0", content: "nothing", isError: true }] },
        ],
        maxTokens: 900,
        tools: [
          { name: "b", description: "b", inputSchema: { type: "object" } },
          { name: "a", description: "a", inputSchema: { type: "object" } },
        ],
        effort: "low",
      },
      { apiKey: "sk-openai", organization: "org-1", project: "proj-1", onDelta: (d) => deltas.push(d) },
    );
    const req = requests[0];
    expect(req?.url).toContain("/responses");
    expect(req?.headers.get("authorization")).toBe("Bearer sk-openai");
    expect(req?.headers.get("openai-organization")).toBe("org-1");
    expect(req?.headers.get("openai-project")).toBe("proj-1");
    expect(req?.body).toMatchObject({
      model: "gpt-6-sol",
      instructions: "org\n\nagent",
      max_output_tokens: 900,
      store: false,
      include: ["reasoning.encrypted_content"],
      reasoning: { effort: "low" },
      stream: true,
    });
    expect(((req?.body.tools ?? []) as { name: string }[]).map((t) => t.name)).toEqual(["a", "b"]);
    expect(req?.body.input).toEqual([
      { role: "user", content: "hi" },
      reasoning,
      { type: "function_call", call_id: "call_0", name: "search_context", arguments: '{"query":"x"}' },
      { type: "function_call_output", call_id: "call_0", output: "ERROR: nothing" },
    ]);

    expect(deltas).toEqual(["Check", "ing."]);
    expect(result.stopReason).toBe("tool_use");
    expect(result.content).toEqual([
      { type: "opaque", provider: "openai", data: reasoning },
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "call_1", name: "github_get_pr", input: { pr: 42 } },
    ]);
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 50, cacheReadTokens: 600, cacheWriteTokens: 100 });
    expect(result.model).toBe("gpt-6-sol-2026-09");
  });

  test("structured output: JSON Schema in text.format, JSON text back", async () => {
    const msg = {
      type: "message",
      id: "m1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }],
    };
    const { fetcher, requests } = scripted(
      sse([
        { type: "response.created", response: baseResponse({ status: "in_progress", output: [] }) },
        { type: "response.output_item.added", output_index: 0, item: { ...msg, status: "in_progress", content: [] } },
        {
          type: "response.content_part.added",
          item_id: "m1",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          item_id: "m1",
          output_index: 0,
          content_index: 0,
          delta: '{"ok":true}',
          logprobs: [],
        },
        { type: "response.output_item.done", output_index: 0, item: msg },
        { type: "response.completed", response: baseResponse({ output: [msg] }) },
      ]),
    );
    const provider = createOpenAIProvider({ fetch: fetcher, maxRetries: 0 });
    const schema = {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    };
    const result = await provider.stream(
      {
        model: "gpt-6-luna",
        system: "route",
        messages: [{ role: "user", content: "x" }],
        maxTokens: 100,
        outputSchema: schema,
      },
      { apiKey: "k", onDelta: () => {} },
    );
    expect(requests[0]?.body.text).toEqual({ format: { type: "json_schema", name: "output", schema, strict: true } });
    expect(result.text).toBe('{"ok":true}');
    expect(result.stopReason).toBe("end_turn");
  });

  test("effort none: reasoning off on a model that allows it, low on the others", async () => {
    const effortOf = async (model: string) => {
      const { fetcher, requests } = scripted(
        sse([
          { type: "response.created", response: baseResponse({ status: "in_progress", output: [] }) },
          { type: "response.completed", response: baseResponse({ output: [] }) },
        ]),
      );
      const provider = createOpenAIProvider({ fetch: fetcher, maxRetries: 0 });
      await provider.stream(
        { model, system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 10, effort: "none" },
        { apiKey: "k", onDelta: () => {} },
      );
      return requests[0]?.body.reasoning;
    };
    expect(await effortOf("gpt-6-luna")).toEqual({ effort: "none" });
    expect(await effortOf("gpt-6.1-sol")).toEqual({ effort: "low" });
  });

  test("a broken stream reports the output received so far", async () => {
    const { fetcher } = scripted(
      sse([
        { type: "response.created", response: baseResponse({ status: "in_progress", output: [] }) },
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "message", id: "m1", role: "assistant", status: "in_progress", content: [] },
        },
        {
          type: "response.content_part.added",
          item_id: "m1",
          output_index: 0,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        },
        {
          type: "response.output_text.delta",
          item_id: "m1",
          output_index: 0,
          content_index: 0,
          delta: "Half of",
          logprobs: [],
        },
        { type: "error", code: "server_error", message: "boom", param: null },
      ]),
    );
    const provider = createOpenAIProvider({ fetch: fetcher, maxRetries: 0 });
    const error = await provider
      .stream(
        { model: "gpt-6-luna", system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 10 },
        { apiKey: "k", onDelta: () => {} },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).partial).toMatchObject({ inputTokens: null, outputChars: 7 });
  });

  test("catalog: OpenAI models priced per token; cheap model per provider", () => {
    expect(MODEL_CATALOG["gpt-6-sol"]?.provider).toBe("openai");
    expect(
      costNanoUsd("gpt-6-sol", { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ).toBe(200_000_000);
    expect(
      costNanoUsd("gpt-6-luna", {
        inputTokens: 0,
        outputTokens: 1_000_000,
        cacheReadTokens: 100_000,
        cacheWriteTokens: 0,
      }),
    ).toBe(501_000_000);
    expect(cheapModelOf("openai")).toBe("gpt-6-luna");
    expect(cheapModelOf("anthropic")).toBe("claude-haiku-5-5");
  });
});
