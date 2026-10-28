import { describe, expect, test } from "bun:test";
import {
  cheapModelOf,
  costNanoUsd,
  isKnownModel,
  MODEL_CATALOG,
  MODEL_TIERS,
  modelForTier,
  PROVIDER_IDS,
  PROVIDERS,
  pricesAt,
  routerModelOf,
  summedCostNanoUsd,
  usdToNanoUsd,
} from "../src";
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
    // Many calls' tokens added up never cross it: the sum is no one call's prompt.
    expect(summedCostNanoUsd("claude-haiku-5-5", usage(90_000, 1000, 20_000))).toBe(
      90_000 * 100 + 1000 * 500 + 20_000 * 10,
    );
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

  test("every model's provider exists, and each provider has one recommended model", () => {
    for (const m of Object.values(MODEL_CATALOG)) expect(PROVIDER_IDS).toContain(m.provider);
    const recommended = Object.keys(PROVIDERS).map((provider) =>
      Object.entries(MODEL_CATALOG)
        .filter(([, m]) => m.provider === provider && m.recommended)
        .map(([id]) => id),
    );
    expect(recommended).toEqual([
      ["claude-sonnet-5-5"],
      ["gpt-6.1-sol"],
      ["gemini-3.8-flash"],
      ["deepseek-flash"],
      ["kimi-k3.1-pro"],
      ["glm-5.3"],
      ["MiniMax-M3"],
    ]);
  });

  test("DeepSeek (its peak rates), Kimi, GLM and MiniMax at their published USD per million tokens", () => {
    // Input, output, cache read, cache write.
    const perMTok = (model: string) =>
      [usage(1e6, 0), usage(0, 1e6), usage(0, 0, 1e6), usage(0, 0, 0, 1e6)].map((u) => costNanoUsd(model, u) / 1e9);
    expect(perMTok("deepseek-flash")).toEqual([0.3, 1.2, 0.006, 0.3]);
    expect(perMTok("deepseek-v4-pro")).toEqual([1.32, 3.96, 0.044, 1.32]);
    expect(perMTok("kimi-k3.1-pro")).toEqual([2, 10, 0.2, 2]);
    expect(perMTok("kimi-k3")).toEqual([3, 15, 0.3, 3]);
    expect(perMTok("glm-5.3")).toEqual([1.4, 4.4, 0.26, 1.4]);
    expect(perMTok("glm-5.3-flash")).toEqual([0.15, 0.5, 0.03, 0.15]);
    expect(perMTok("MiniMax-M3.1-Flash")).toEqual([0.15, 0.6, 0.015, 0.15]);
    // MiniMax M3: $0.30 / $1.20 / $0.06 up to 512K prompt tokens, double above.
    expect(costNanoUsd("MiniMax-M3", usage(500_000, 1000, 12_000))).toBe(500_000 * 300 + 1000 * 1200 + 12_000 * 60);
    expect(costNanoUsd("MiniMax-M3", usage(500_000, 1000, 12_001))).toBe(500_000 * 600 + 1000 * 2400 + 12_001 * 120);
  });

  test("system tasks use a provider's cheap model, else its recommended one; Automático's tiers per line", () => {
    expect(PROVIDER_IDS.map((p) => cheapModelOf(p))).toEqual([
      "claude-haiku-5-5",
      "gpt-6-luna",
      "gemini-3.5-flash-lite",
      "deepseek-flash",
      "kimi-k3.1-pro",
      "glm-5.3-flash",
      "MiniMax-M3.1-Flash",
    ]);
    const line = (provider: string) => MODEL_TIERS.map((tier) => modelForTier(provider, tier));
    expect(line("gemini")).toEqual(["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-4-argon"]);
    expect(line("deepseek")).toEqual(["deepseek-flash", "deepseek-flash", "deepseek-v4-pro"]);
    expect(line("moonshot")).toEqual(["kimi-k3.1-pro", "kimi-k3.1-pro", "kimi-k3.1-pro"]);
    expect(line("zai")).toEqual(["glm-5.3-flash", "glm-5.3", "glm-5.3"]);
    expect(line("minimax")).toEqual(["MiniMax-M3.1-Flash", "MiniMax-M3", "MiniMax-M3"]);
  });

  test("routing picks one model per provider, never Kimi's (its cheapest always thinks)", () => {
    expect(PROVIDER_IDS.map((p) => routerModelOf(p))).toEqual([
      "claude-haiku-5-5",
      "gpt-6-luna",
      "gemini-3.5-flash-lite",
      "deepseek-flash",
      null,
      "glm-5.3-flash",
      "MiniMax-M3",
    ]);
    for (const provider of PROVIDER_IDS) {
      const picks = Object.values(MODEL_CATALOG).filter((m) => m.provider === provider && m.router);
      expect(picks).toHaveLength(provider === "moonshot" ? 0 : 1);
    }
    // GLM-5.3 Flash can't stop thinking, Flash-Lite keeps a little, every other pick turns it off.
    expect(MODEL_CATALOG["glm-5.3-flash"]?.leastThinking).toBeUndefined();
    expect(MODEL_CATALOG["gemini-3.5-flash-lite"]?.leastThinking).toBe("minimal");
    expect(MODEL_CATALOG["MiniMax-M3"]?.leastThinking).toBe("off");
  });

  test("Gemini at Google's prices, Argon and 3.8 Flash at half until their day (UTC); the list price shown after", () => {
    // Input, output, cache read, cache write, for a call made at `at`.
    const perMTok = (model: string, at: string) =>
      [usage(1e6, 0), usage(0, 1e6), usage(0, 0, 1e6), usage(0, 0, 0, 1e6)].map(
        (u) => costNanoUsd(model, u, new Date(at)) / 1e9,
      );
    expect(perMTok("gemini-4-argon", "2026-11-30T23:59:59Z")).toEqual([2, 10, 0.1, 2]);
    expect(perMTok("gemini-4-argon", "2026-12-01T00:00:00Z")).toEqual([4, 20, 0.2, 4]);
    expect(perMTok("gemini-3.8-flash", "2026-12-31T23:59:59Z")).toEqual([0.75, 3.75, 0.075, 0.75]);
    expect(perMTok("gemini-3.8-flash", "2027-01-01T00:00:00Z")).toEqual([1.5, 7.5, 0.15, 1.5]);
    expect(perMTok("gemini-3.5-flash-lite", "2026-10-27T12:00:00Z")).toEqual([0.3, 2.5, 0.03, 0.3]);
    expect(perMTok("gemini-3.5-flash-lite", "2027-06-01T00:00:00Z")).toEqual([0.3, 2.5, 0.03, 0.3]);
    const argon = MODEL_CATALOG["gemini-4-argon"];
    if (!argon) throw new Error("no Argon");
    expect(pricesAt(argon, new Date("2026-11-01T00:00:00Z")).input).toBe(2000);
    expect(pricesAt(argon, new Date("2026-12-01T00:00:00Z"))).toBe(argon.prices);
  });

  test("costs are exact integers", () => {
    for (const model of Object.keys(MODEL_CATALOG)) {
      expect(Number.isInteger(costNanoUsd(model, usage(123, 456, 7, 8)))).toBe(true);
      expect(Number.isInteger(costNanoUsd(model, usage(123, 456, 7, 8), new Date("2026-11-01T00:00:00Z")))).toBe(true);
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
