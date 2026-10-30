import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AgentBrainLine, PlanUsage } from "../src/api/types";
import { planMeterText, usageShown } from "../src/lib/plan-usage";

const usage = (windows: PlanUsage["windows"]): PlanUsage => ({
  windows,
  source: "turn",
  at: "2026-10-30T12:00:00.000Z",
});
const HOURS = usage([{ kind: "five_hour", usedPercent: 12 }]);
const onPlan = (over: Partial<AgentBrainLine> = {}): AgentBrainLine => ({
  kind: "claude_code",
  model: "Sonnet",
  account: "Claude Team",
  usage: HOURS,
  ...over,
});

describe("what an agent's usage shows where its budget did (ADR 0063 §5)", () => {
  test("on a plan: its account's limits, and no budget while it spent nothing through the API", () => {
    expect(usageShown(onPlan(), 0)).toEqual({ plan: { account: "Claude Team", usage: HOURS }, budget: false });
    expect(usageShown(onPlan({ kind: "codex", account: "ChatGPT Plus" }), 0).plan?.account).toBe("ChatGPT Plus");
  });

  test("on the API: its budget, even at 0%", () => {
    expect(usageShown({ kind: "model" }, 0)).toEqual({ plan: null, budget: true });
    expect(usageShown(undefined, 41.5)).toEqual({ plan: null, budget: true });
  });

  test("a plan that also spent through the API (its fallback, or the workspace's model this month): both", () => {
    expect(usageShown(onPlan(), 3.5)).toEqual({ plan: { account: "Claude Team", usage: HOURS }, budget: true });
  });

  test("no window known yet: no limits rather than 0%", () => {
    expect(usageShown(onPlan({ usage: undefined }), 0)).toEqual({ plan: null, budget: false });
    expect(usageShown(onPlan({ usage: usage([]) }), 0)).toEqual({ plan: null, budget: false });
    expect(usageShown(onPlan({ usage: undefined }), 2)).toEqual({ plan: null, budget: true });
  });

  test("a plan that refused a request before any window was known: its line, which says it is at the limit", () => {
    const refused: PlanUsage = { ...usage([]), limited: true };
    expect(usageShown(onPlan({ usage: refused }), 0)).toEqual({
      plan: { account: "Claude Team", usage: refused },
      budget: false,
    });
  });
});

test("the compact line names a window short; a provider's own window by its name", () => {
  const t = ((key: string) => key) as unknown as TFunction;
  const text = planMeterText(t, "en");
  expect(text.short({ kind: "five_hour" })).toBe("aiAccounts.usage.short.five_hour");
  expect(text.short({ kind: "seven_day_opus" })).toBe("aiAccounts.usage.short.seven_day_opus");
  expect(text.short({ kind: "other", label: "Extra usage" })).toBe("Extra usage");
  expect(text.short({ kind: "other" })).toBe("aiAccounts.usage.short.other");
  expect(text.window({ kind: "seven_day" })).toBe("aiAccounts.usage.window.seven_day");
});
