import { describe, expect, test } from "bun:test";
import {
  COMMANDCODE_API,
  commandCodeModelOf,
  costNanoUsd,
  createCommandCodeProvider,
  createModelProviders,
  isOpenRouterModel,
  modelProvider,
  ProviderError,
} from "../src";
import { scripted, sse } from "./scripted";

const chat = (chunks: Record<string, unknown>[]) =>
  `${chunks.map((c) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, ...c })}\n\n`).join("")}data: [DONE]\n\n`;

const message = (events: Record<string, unknown>[]) =>
  sse([
    {
      type: "message_start",
      message: {
        id: "m",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 50, output_tokens: 1 },
      },
    },
    ...events,
    { type: "message_stop" },
  ]);

describe("Command Code's DeepSeek prices", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const flash = "commandcode:deepseek/deepseek-v4.1-flash";

  test("full price in the weekday peak hours, half the rest of the day and all weekend", () => {
    // 2026-11-13 is a Friday, 2026-11-14 a Saturday.
    expect(costNanoUsd(flash, usage, new Date("2026-11-13T02:30:00Z"))).toBe(300_000_000);
    expect(costNanoUsd(flash, usage, new Date("2026-11-13T09:59:00Z"))).toBe(300_000_000);
    expect(costNanoUsd(flash, usage, new Date("2026-11-13T04:00:00Z"))).toBe(150_000_000);
    expect(costNanoUsd(flash, usage, new Date("2026-11-13T10:00:00Z"))).toBe(150_000_000);
    expect(costNanoUsd(flash, usage, new Date("2026-11-14T02:30:00Z"))).toBe(150_000_000);
  });
});

describe("Command Code's Claude and GPT prices", () => {
  test("a long prompt costs what it costs on the maker's own row", () => {
    const at = new Date("2026-11-13T12:00:00Z");
    for (const model of ["claude-haiku-5-5", "gpt-6.1-sol", "gpt-6-luna"]) {
      for (const inputTokens of [50_000, 300_000]) {
        const usage = { inputTokens, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 };
        expect(costNanoUsd(`commandcode:${model}`, usage, at)).toBe(costNanoUsd(model, usage, at));
      }
    }
  });
});

describe("Command Code's ids", () => {
  test("its own id after the prefix, slashes kept; never read as OpenRouter's", () => {
    expect(commandCodeModelOf("commandcode:zai-org/GLM-5.3")).toBe("zai-org/GLM-5.3");
    expect(commandCodeModelOf("commandcode:")).toBeNull();
    expect(commandCodeModelOf("glm-5.3")).toBeNull();
    expect(isOpenRouterModel("commandcode:deepseek/deepseek-v4.1-flash")).toBe(false);
    expect(isOpenRouterModel("deepseek/deepseek-v4.1-flash")).toBe(true);
    expect(modelProvider("commandcode:deepseek/deepseek-v4.1-flash")).toBe("commandcode");
    expect(modelProvider("commandcode:claude-sonnet-5-5")).toBe("commandcode");
  });

  test("the server registers its adapter", () => {
    expect(createModelProviders().commandcode?.id).toBe("commandcode");
  });
});

describe("calls (scripted transport)", () => {
  test("an open model: Chat Completions at Command Code, its own id sent, usage asked, priced at Command Code's rates", async () => {
    const { fetcher, requests } = scripted(
      chat([
        {
          model: "deepseek-v4.1-flash-dedicated",
          choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
        },
        { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 10, cost: 9 } },
      ]),
    );
    const model = "commandcode:deepseek/deepseek-v4.1-flash";
    const result = await createCommandCodeProvider({ fetch: fetcher, maxRetries: 0 }).stream(
      { model, system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 100, effort: "high" },
      { apiKey: "user_k123456789", onDelta: () => {} },
    );
    const req = requests[0];
    expect(req?.url).toBe(`${COMMANDCODE_API}/v1/chat/completions`);
    expect(req?.headers.get("authorization")).toBe("Bearer user_k123456789");
    expect(req?.headers.get("http-referer")).toBeNull();
    expect(req?.body).toMatchObject({ model: "deepseek/deepseek-v4.1-flash", stream_options: { include_usage: true } });
    expect(req?.body.provider).toBeUndefined();
    expect(req?.body.reasoning).toBeUndefined();
    expect(result.model).toBe(model);
    expect(result.costNanoUsd).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    // Off-peak (a Saturday): DeepSeek's half price.
    expect(costNanoUsd(result.model, result.usage, new Date("2026-11-14T12:00:00Z"))).toBe(1000 * 150 + 10 * 600);
  });

  test("Claude: Anthropic Messages at Command Code with its key, its own id sent, the full id back", async () => {
    const { fetcher, requests } = scripted(
      message([
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "oi" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
      ]),
    );
    const result = await createCommandCodeProvider({ fetch: fetcher, maxRetries: 0 }).stream(
      {
        model: "commandcode:claude-sonnet-5-5",
        system: "s",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 100,
      },
      { apiKey: "user_k123456789", onDelta: () => {} },
    );
    const req = requests[0];
    expect(req?.url).toStartWith(`${COMMANDCODE_API}/v1/messages`);
    expect(req?.headers.get("x-api-key")).toBe("user_k123456789");
    expect(req?.body.model).toBe("claude-sonnet-5-5");
    for (const field of ["cache_control", "fallbacks"]) expect(req?.body).not.toHaveProperty(field);
    expect(result.model).toBe("commandcode:claude-sonnet-5-5");
    expect(result.content).toEqual([{ type: "text", text: "oi" }]);
  });

  test("Claude with history and a 1-hour cache asked: every breakpoint stays at 5 minutes", async () => {
    const { fetcher, requests } = scripted(
      message([
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      ]),
    );
    await createCommandCodeProvider({ fetch: fetcher, maxRetries: 0 }).stream(
      {
        model: "commandcode:claude-sonnet-5-5",
        system: [{ text: "agent", cache: true }],
        messages: [
          { role: "user", content: "earlier" },
          { role: "assistant", content: "seen" },
          { role: "user", content: "now" },
        ],
        notes: { at: 2, text: "notes" },
        cacheTtl: "1h",
        maxTokens: 100,
      },
      { apiKey: "user_k123456789", onDelta: () => {} },
    );
    const body = requests[0]?.body as { messages: { content: Record<string, unknown>[] }[] };
    expect(body.messages.at(-1)?.content[0]).toEqual({
      type: "text",
      text: "now",
      cache_control: { type: "ephemeral" },
    });
    expect(JSON.stringify(body)).not.toContain('"ttl"');
  });

  test("structured output on Claude (the router's pick) is a forced tool, thinking off; its input is the reply", async () => {
    const { fetcher, requests } = scripted(
      message([
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "structured_output", input: {} },
        },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"ok":true}' } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } },
      ]),
    );
    const result = await createCommandCodeProvider({ fetch: fetcher, maxRetries: 0 }).stream(
      {
        model: "commandcode:claude-haiku-5-5",
        system: "s",
        messages: [{ role: "user", content: "ok?" }],
        maxTokens: 100,
        effort: "none",
        outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      },
      { apiKey: "user_k123456789", onDelta: () => {} },
    );
    const body = requests[0]?.body;
    expect(body?.tool_choice).toEqual({ type: "any" });
    // The adapter reads Anthropic's own row for the bare id, so that row is what turns thinking off here.
    expect(body?.thinking).toEqual({ type: "disabled" });
    expect(body?.output_config).toBeUndefined();
    expect(JSON.parse(result.content.map((b) => (b.type === "text" ? b.text : "")).join(""))).toEqual({ ok: true });
  });

  test("a refusal keeps Command Code's words; an id that isn't its own fails before any call", async () => {
    const refused = scripted(
      JSON.stringify({
        error: { message: 'Model "x" is not supported on this endpoint.', type: "invalid_request_error" },
      }),
      400,
    );
    const error = await createCommandCodeProvider({ fetch: refused.fetcher, maxRetries: 0 })
      .stream(
        { model: "commandcode:x/y", system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 10 },
        { apiKey: "user_k123456789", onDelta() {} },
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toContain("is not supported on this endpoint");

    const none = scripted("");
    const wrong = await createCommandCodeProvider({ fetch: none.fetcher, maxRetries: 0 })
      .stream(
        { model: "glm-5.3", system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 10 },
        { apiKey: "user_k123456789", onDelta() {} },
      )
      .catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(ProviderError);
    expect(none.requests).toHaveLength(0);
  });
});
