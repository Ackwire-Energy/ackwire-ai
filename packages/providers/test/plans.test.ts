import { describe, expect, test } from "bun:test";
import {
  CODING_PLANS,
  claudeCodeModel,
  isPlanModelId,
  PLAN_ALIASES,
  PLAN_IDS,
  type PlanId,
  type PlanModel,
  planModel,
  planModelValue,
} from "../src/plans";

const models = (plan: PlanId): readonly PlanModel[] => CODING_PLANS[plan].claudeCode.models;
const ids = (plan: PlanId) => models(plan).map((m) => m.id);
/** What each alias runs on a plan, as the runner pins it (`ANTHROPIC_DEFAULT_*_MODEL`). */
const aliases = (plan: PlanId) => Object.fromEntries(PLAN_ALIASES.map((a) => [a, planModel(CODING_PLANS[plan], a).id]));

describe("coding plans' models", () => {
  test("every plan: one model runs sonnet, no alias twice, no id twice", () => {
    for (const id of PLAN_IDS) {
      expect(models(id).filter((m) => m.alias === "sonnet")).toHaveLength(1);
      const named = models(id).flatMap((m) => (m.alias ? [m.alias] : []));
      expect(new Set(named).size).toBe(named.length);
      expect(new Set(ids(id)).size).toBe(models(id).length);
    }
  });

  test("each plan lists every model it runs through Claude Code; its aliases keep the documented defaults", () => {
    expect(ids("zai")).toEqual(["glm-5.3[1m]", "glm-5.3-flash[1m]"]);
    expect(aliases("zai")).toEqual({ opus: "glm-5.3[1m]", sonnet: "glm-5.3[1m]", haiku: "glm-5.3-flash[1m]" });
    expect(ids("kimi")).toEqual([
      "kimi-for-coding",
      "k3.1-pro",
      "k3.1-pro-highspeed",
      "kimi-for-coding-highspeed",
      "k3",
      "k3-256k",
    ]);
    expect(aliases("kimi")).toEqual({ opus: "k3.1-pro", sonnet: "kimi-for-coding", haiku: "kimi-for-coding" });
    expect(ids("minimax")).toEqual(["MiniMax-M3.1-Flash[1m]"]);
    expect(aliases("opencode")).toEqual({ opus: "minimax-m3", sonnet: "minimax-m3", haiku: "claude-haiku-5-5" });
    expect(ids("opencode")).toHaveLength(24);
    // The free models and the ones that train on what they're sent stay out.
    expect(ids("opencode").some((m) => /free|contributor/.test(m))).toBe(false);
    const cheap = models("opencode")
      .filter((m) => m.tag === "cheap")
      .map((m) => m.id);
    expect(cheap).toEqual([
      "glm-5.3-flash",
      "qwen3.8-flash",
      "qwen3.7-plus",
      "deepseek-v4.1-flash",
      "mimo-v2.6-flash",
      "gpt-6-luna",
      "longcat-2.0",
      "hy3",
    ]);
  });

  test("a stored value: one of the plan's models by id, an alias's model, else sonnet's", () => {
    const go = CODING_PLANS.opencode;
    expect(planModel(go, "deepseek-v4.1-flash").label).toBe("DeepSeek V4.1 Flash");
    expect(planModel(go, "haiku").id).toBe("claude-haiku-5-5");
    for (const other of [null, undefined, "auto", "opus", "k3.1-pro", "glm-5.3[1m]"])
      expect(planModel(go, other).id).toBe("minimax-m3");
    // Chosen and stored by its alias where it has one (portable to Claude), else by its id.
    expect(go.claudeCode.models.slice(0, 3).map(planModelValue)).toEqual(["sonnet", "haiku", "minimax-m3.1-flash"]);
  });

  test("a turn's --model: an alias as is, the plan's own model by id, Claude's ids without a plan, else sonnet", () => {
    const kimi = CODING_PLANS.kimi;
    expect(claudeCodeModel(kimi, "opus")).toBe("opus");
    expect(claudeCodeModel(kimi, "k3-256k")).toBe("k3-256k");
    for (const other of ["glm-5.3", "claude-opus-5-5", "auto", undefined, 3])
      expect(claudeCodeModel(kimi, other)).toBe("sonnet");
    expect(claudeCodeModel(undefined, "haiku")).toBe("haiku");
    expect(claudeCodeModel(undefined, "claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    // Another plan's model kept while Claude thinks.
    expect(claudeCodeModel(undefined, "deepseek-v4.1-flash")).toBe("sonnet");
    expect(isPlanModelId("deepseek-v4.1-flash")).toBe(true);
    expect(isPlanModelId("MiniMax-M3.1-Flash[1m]")).toBe(true);
    expect(isPlanModelId("gpt-6-sol")).toBe(false);
  });
});
