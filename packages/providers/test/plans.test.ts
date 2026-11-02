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
  planModelById,
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
    // Kimi's own names: `kimi-for-coding-highspeed` is K2.7 Code's high-speed version, not Kimi for Coding's.
    expect(models("kimi").map((m) => m.label)).toEqual([
      "Kimi for Coding",
      "K3.1 Pro",
      "K3.1 Pro Highspeed",
      "K2.7 Code Highspeed",
      "K3",
      "K3 256K",
    ]);
    expect(aliases("kimi")).toEqual({ opus: "k3.1-pro", sonnet: "kimi-for-coding", haiku: "kimi-for-coding" });
    expect(ids("minimax")).toEqual(["MiniMax-M3.1-Flash[1m]"]);
    expect(aliases("opencode")).toEqual({ opus: "minimax-m3", sonnet: "minimax-m3", haiku: "claude-haiku-5-5" });
    // All 28 of OpenCode Go's live list (2026-11-02). The ones that train on what they're sent say so and run only
    // when chosen: "Automático" never picks one.
    expect(ids("opencode")).toHaveLength(28);
    for (const m of models("opencode").filter((m) => /free|contributor/.test(m.id))) {
      expect(m.needs === "paidTraining" || m.needs === "freeTraining").toBe(true);
      expect(m.alias).toBeUndefined();
    }
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

  test("a tag only where its maker or plan says so", () => {
    const tagged = (plan: PlanId, tag: string) =>
      models(plan)
        .filter((m) => m.tag === tag)
        .map((m) => m.id);
    // Flagship: the maker's own word for it (DeepSeek doesn't call V4 Pro that).
    expect(tagged("zai", "smart")).toEqual(["glm-5.3[1m]"]);
    expect(tagged("kimi", "smart")).toEqual(["k3.1-pro"]);
    expect(tagged("opencode", "smart")).toEqual(["glm-5.3", "kimi-k3.1-pro", "qwen3.8-max", "gemini-4-argon"]);
    // Kimi compares K3 256K's quota only with K3's: no model of its plan is the cheapest in its words.
    expect(tagged("kimi", "cheap")).toEqual([]);
  });

  test("a model that answers only once the plan's account allows it says so", () => {
    const needs = PLAN_IDS.flatMap((p) => models(p).flatMap((m) => (m.needs ? [[m.id, m.needs]] : [])));
    expect(needs).toEqual([
      ["deepseek-v4-pro", "globalRegion"],
      ["deepseek-v4.1-flash", "globalRegion"],
      ["muse-spark-1.3-contributor", "paidTraining"],
      ["muse-spark-1.2-contributor", "paidTraining"],
      ["beam-free", "freeTraining"],
      ["iceman-contributor-free", "freeTraining"],
    ]);
  });

  test("a model its plan prices at 0 is marked free; every other one isn't", () => {
    // OpenCode Go's live list (2026-11-02) prices exactly these at 0. Zen's free tier (`*-free` on
    // opencode.ai/zen/v1/models, `big-pickle`) answers only the OpenCode CLI, so no plan here lists it.
    const free = PLAN_IDS.flatMap((p) => models(p).flatMap((m) => (m.free ? [m.id] : [])));
    expect(free).toEqual(["beam-free", "iceman-contributor-free"]);
    expect(ids("opencode")).not.toContain("deepseek-v4.1-flash-free");
    expect(ids("opencode")).toContain("deepseek-v4.1-flash");
    expect(ids("opencode")).toContain("glm-5.3-flash");
  });

  test("a plan that sells several makers' models names each one's maker, each maker's models together", () => {
    const makers = models("opencode").map((m) => m.maker);
    expect(makers.every(Boolean)).toBe(true);
    const runs = makers.filter((m, i) => m !== makers[i - 1]);
    expect(runs).toEqual([
      "minimax",
      "anthropic",
      "zai",
      "moonshot",
      "Alibaba",
      "deepseek",
      "Xiaomi",
      "openai",
      "gemini",
      "xAI",
      "Meituan",
      "Tencent",
      "StepFun",
      "Meta",
      "Reflection",
      "OpenCode",
    ]);
    for (const plan of ["zai", "kimi", "minimax"] as const) expect(models(plan).some((m) => m.maker)).toBe(false);
  });

  test("a stored value: one of the plan's models by id, an alias's model, else sonnet's", () => {
    const go = CODING_PLANS.opencode;
    expect(planModel(go, "deepseek-v4.1-flash").label).toBe("DeepSeek V4.1 Flash");
    expect(planModel(go, "haiku").id).toBe("claude-haiku-5-5");
    for (const other of [null, undefined, "auto", "opus", "k3.1-pro", "glm-5.3[1m]"])
      expect(planModel(go, other).id).toBe("minimax-m3");
    // Chosen and stored by its alias where it has one (portable to Claude), else by its id.
    expect(go.claudeCode.models.slice(0, 3).map(planModelValue)).toEqual(["sonnet", "minimax-m3.1-flash", "haiku"]);
    // Whichever plan has it, by its id.
    expect(planModelById("k3-256k")?.label).toBe("K3 256K");
    expect(planModelById("deepseek-v4.1-flash")?.label).toBe("DeepSeek V4.1 Flash");
    expect(planModelById("sonnet")).toBeUndefined();
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
