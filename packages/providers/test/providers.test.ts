import { describe, expect, test } from "bun:test";
import { costNanoUsd, isKnownModel, MODEL_CATALOG, PROVIDERS, usdToNanoUsd } from "../src";
import { createFakeProvider } from "../src/fake";

const usage = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
});

describe("pricing", () => {
  test("Sonnet 5.5: $2 / $10 per million tokens, $0.10 cache reads", () => {
    expect(costNanoUsd("claude-sonnet-5-5", usage(1_000_000, 0))).toBe(usdToNanoUsd(2));
    expect(costNanoUsd("claude-sonnet-5-5", usage(0, 1_000_000))).toBe(usdToNanoUsd(10));
    expect(costNanoUsd("claude-sonnet-5-5", usage(0, 0, 1_000_000))).toBe(usdToNanoUsd(0.1));
  });

  test("Haiku 5.5 switches to long-context prices above 100K prompt tokens", () => {
    expect(costNanoUsd("claude-haiku-5-5", usage(100_000, 1000))).toBe(100_000 * 100 + 1000 * 500);
    expect(costNanoUsd("claude-haiku-5-5", usage(90_000, 1000, 20_000))).toBe(90_000 * 500 + 1000 * 2500 + 20_000 * 50);
  });

  test("GPT-6.1 Sol: $2 / $0.10 / $2.50 / $10, and $4 / $0.20 / $5 / $15 above 272K prompt tokens", () => {
    // 272,000 prompt tokens exactly: still the base prices.
    expect(costNanoUsd("gpt-6.1-sol", usage(100_000, 1000, 100_000, 72_000))).toBe(
      100_000 * 2000 + 1000 * 10000 + 100_000 * 100 + 72_000 * 2500,
    );
    expect(costNanoUsd("gpt-6.1-sol", usage(100_001, 1000, 100_000, 72_000))).toBe(
      100_001 * 4000 + 1000 * 15000 + 100_000 * 200 + 72_000 * 5000,
    );
  });

  test("GPT-6 Sol and Luna: input, cached input and cache writes 2×, output 1.5× above 272K prompt tokens", () => {
    expect(costNanoUsd("gpt-6-sol", usage(272_000, 1000))).toBe(272_000 * 2000 + 1000 * 10000);
    expect(costNanoUsd("gpt-6-sol", usage(200_000, 1000, 72_001))).toBe(200_000 * 4000 + 1000 * 15000 + 72_001 * 400);
    expect(costNanoUsd("gpt-6-luna", usage(272_001, 1000, 0, 10))).toBe(272_001 * 200 + 1000 * 750 + 10 * 250);
  });

  test("one recommended model per provider: Sonnet 5.5 and GPT-6.1 Sol", () => {
    const recommended = Object.keys(PROVIDERS).map((provider) =>
      Object.entries(MODEL_CATALOG)
        .filter(([, m]) => m.provider === provider && m.recommended)
        .map(([id]) => id),
    );
    expect(recommended).toEqual([["claude-sonnet-5-5"], ["gpt-6.1-sol"]]);
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
