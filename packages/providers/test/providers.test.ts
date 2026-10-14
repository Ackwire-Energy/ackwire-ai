import { describe, expect, test } from "bun:test";
import { costNanoUsd, isKnownModel, MODEL_CATALOG, usdToNanoUsd } from "../src";
import { createFakeProvider } from "../src/fake";

const usage = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
});

describe("pricing", () => {
  test("Sonnet 5.5: $2 / $10 per million tokens", () => {
    expect(costNanoUsd("claude-sonnet-5-5", usage(1_000_000, 0))).toBe(usdToNanoUsd(2));
    expect(costNanoUsd("claude-sonnet-5-5", usage(0, 1_000_000))).toBe(usdToNanoUsd(10));
    expect(costNanoUsd("claude-sonnet-5-5", usage(0, 0, 1_000_000))).toBe(usdToNanoUsd(0.2));
  });

  test("Haiku 5.5 switches to long-context prices above 100K prompt tokens", () => {
    expect(costNanoUsd("claude-haiku-5-5", usage(100_000, 1000))).toBe(100_000 * 100 + 1000 * 500);
    expect(costNanoUsd("claude-haiku-5-5", usage(90_000, 1000, 20_000))).toBe(90_000 * 500 + 1000 * 2500 + 20_000 * 50);
  });

  test("costs are exact integers", () => {
    for (const model of Object.keys(MODEL_CATALOG)) {
      expect(Number.isInteger(costNanoUsd(model, usage(123, 456, 7, 8)))).toBe(true);
    }
  });

  test("unknown models can't be priced", () => {
    expect(isKnownModel("gpt-5")).toBe(false);
    expect(() => costNanoUsd("gpt-5", usage(1, 1))).toThrow(/unknown model/);
  });

  test("defaults from config are in the catalog", () => {
    expect(isKnownModel("claude-sonnet-5-5")).toBe(true);
    expect(isKnownModel("claude-haiku-5-5")).toBe(true);
  });
});

describe("fake provider", () => {
  test("streams chunks and records the call", async () => {
    const fake = createFakeProvider();
    const deltas: string[] = [];
    const result = await fake.stream(
      { model: "claude-sonnet-5-5", system: "s", messages: [{ role: "user", content: "hello" }], maxTokens: 100 },
      { apiKey: "sk-test", onDelta: (d) => deltas.push(d) },
    );
    expect(deltas.join("")).toBe("Echo: hello.");
    expect(result.text).toBe("Echo: hello.");
    expect(fake.calls[0]?.apiKey).toBe("sk-test");
  });

  test("can be scripted to fail", async () => {
    const fake = createFakeProvider(() => new Error("boom"));
    await expect(
      fake.stream({ model: "m", system: "", messages: [], maxTokens: 1 }, { apiKey: "", onDelta: () => {} }),
    ).rejects.toThrow("boom");
  });
});
