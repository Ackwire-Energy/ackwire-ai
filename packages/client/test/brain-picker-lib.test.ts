import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AiAccounts, BrainMachine, BrainOption, Model } from "../src/api/types";
import {
  brainModelLine,
  brainPickInput,
  brainPickOptions,
  brainPickText,
  brainPickValue,
  needsOwnSignIn,
  pickGroups,
} from "../src/lib/brain-picker";
import { brainModelChoices, CODING_PLANS } from "../src/lib/plans";
import { AUTO, modelChoices } from "../src/lib/providers";

const t = ((key: string, o?: Record<string, unknown>) => (o ? `${key}${JSON.stringify(o)}` : key)) as TFunction;

const model = (id: string, provider: string, price = 1): Model => ({
  id,
  label: id,
  provider,
  inputUsdPerMTok: price,
  outputUsdPerMTok: price,
});
const MODELS = [
  model("claude-sonnet-5-5", "anthropic"),
  model("gpt-6.1-sol", "openai"),
  model("some-free-model", "openrouter", 0),
];
const claudeCode: BrainOption = {
  kind: "claude_code",
  available: true,

  models: [
    { value: "opus", label: "Opus" },
    { value: "sonnet", label: "Sonnet" },
    { value: "haiku", label: "Haiku" },
  ],
  defaultModel: "sonnet",
};
const codexOff: BrainOption = { ...claudeCode, kind: "codex", available: false, models: [], defaultModel: null };
const MAC: BrainMachine = { machineId: "m1", name: "Mac mini", online: true, options: [claudeCode, codexOff] };
const goKey: AiAccounts["accounts"][number] = {
  id: "acc-go",
  kind: "claude_code",
  label: "OpenCode Go",
  email: null,
  plan: null,
  status: "active",
  ownerId: "u1",
  ownerName: "Ana",
  mine: true,
  usedBy: [],
  usage: null,
  provider: "opencode",
  keyHint: "abcd",
  machineId: "m1",
  computer: "Mac mini",
};

const build = (accounts: AiAccounts["accounts"] = [], withKey = ["anthropic"], ownerIsMe = true) =>
  brainPickOptions(t, "pt-BR", {
    api: modelChoices(
      MODELS,
      withKey.map((provider, i) => ({ id: `k${i}`, provider }) as never),
      false,
    ),
    machines: [MAC],
    accounts,
    ownerIsMe,
  });
const finds = (options: ReturnType<typeof build>, q: string) =>
  options.filter((o) => brainPickText(o).toLowerCase().includes(q)).map((o) => o.value);

describe("Quem pensa as one list (the new agent's step)", () => {
  test("Automático first, then the API's models by provider, then each plan on the computer that runs it", () => {
    const options = build();
    expect(options[0]?.value).toBe(AUTO);
    expect(options[0]?.disabled).toBe(false);
    const groups = pickGroups(options).map((g) => g.group);
    expect(groups[0]).toBeUndefined();
    expect(groups).toContain("Claude");
    // Claude's plan on the Mac mini, ChatGPT's unavailable there (said, unpickable), every coding plan.
    expect(groups.some((g) => g?.startsWith("brain.line.claudeAuto"))).toBe(true);
    expect(groups.some((g) => g?.startsWith("brain.line.chatgptAuto"))).toBe(true);
    for (const id of ["zai", "kimi", "minimax", "opencode"] as const)
      expect(groups).toContain(`brain.line.codingAuto${JSON.stringify({ model: "", plan: CODING_PLANS[id].label })}`);
    expect(options.find((o) => o.value === "none:chatgpt")?.disabled).toBe(true);
    // Cursor and OpenCode show only where a computer runs them.
    expect(options.some((o) => o.value.startsWith("cursor") || o.value.startsWith("zen"))).toBe(false);
    // A model without the provider's key says so and can't be picked.
    const gpt = options.find((o) => o.value === "gpt-6.1-sol");
    expect(gpt?.disabled).toBe(true);
    expect(gpt?.description).toStartWith("newAgent.modelNeedsKey");
  });

  test("Claude's plan ready here: Claude's models read as the plan's, none says it needs a Claude API key", () => {
    const options = build([], []);
    expect(options.some((o) => o.value === "claude-sonnet-5-5")).toBe(false);
    const plan = options.filter((o) => o.value.startsWith("claude@m1/"));
    expect(plan.map((o) => o.label)).toEqual(["brain.auto.label", "Opus", "Sonnet", "Haiku"]);
    expect(plan.every((o) => !o.disabled)).toBe(true);
    // ChatGPT's plan isn't ready there: its models still say what they need.
    expect(options.find((o) => o.value === "gpt-6.1-sol")?.description).toStartWith("newAgent.modelNeedsKey");
    const noComputer = brainPickOptions(t, "pt-BR", {
      api: modelChoices(MODELS, [], false),
      machines: [],
      accounts: [],
      ownerIsMe: true,
    });
    expect(noComputer.find((o) => o.value === "claude-sonnet-5-5")?.disabled).toBe(true);
  });

  test("a plan offers what the agent's page offers there: Automático and the same models", () => {
    const options = build([goKey]);
    const claude = options.filter((o) => o.pick.kind === "claude_code" && !("accountId" in o.pick && o.pick.accountId));
    expect(claude.map((o) => (o.pick as { model: string }).model)).toEqual([
      AUTO,
      ...brainModelChoices(undefined, claudeCode.models).map((m) => m.value),
    ]);
    const go = options.filter((o) => o.pick.kind === "claude_code" && "accountId" in o.pick && o.pick.accountId);
    expect(go.map((o) => (o.pick as { model: string }).model)).toEqual([
      AUTO,
      ...brainModelChoices(CODING_PLANS.opencode, []).map((m) => m.value),
    ]);
    expect(go.every((o) => !o.disabled && o.mark !== undefined)).toBe(true);
  });

  test("a coding plan with no key of the person's: one pick connects it, its models show unpickable", () => {
    const options = build();
    const connect = options.find((o) => o.value === "connect:opencode");
    expect(connect?.disabled).toBe(false);
    expect(connect?.pick).toEqual({ kind: "connect", choice: "opencode" });
    const models = options.filter((o) => o.value.startsWith("connect:opencode/"));
    expect(models).toHaveLength(CODING_PLANS.opencode.claudeCode.models.length);
    expect(models.every((o) => o.disabled)).toBe(true);
  });

  test("search finds free models by 'free', and a plan's model by its name or maker", () => {
    const options = build([goKey]);
    const free = finds(options, "free");
    expect(free).toContain("some-free-model");
    expect(free).toContain("opencode@m1#acc-go/beam-free");
    expect(free).toContain("opencode@m1#acc-go/iceman-contributor-free");
    expect(options.filter((o) => o.free).map((o) => o.value)).toEqual([
      "some-free-model",
      "opencode@m1#acc-go/beam-free",
      "opencode@m1#acc-go/iceman-contributor-free",
    ]);
    expect(finds(options, "deepseek-v4.1-flash")).toEqual(["opencode@m1#acc-go/deepseek-v4.1-flash"]);
    expect(options.find((o) => o.value.endsWith("/beam-free"))?.description).toBe("brain.free");
  });

  test("the choice shows as its option, and a plan saves its account and model", () => {
    const options = build([goKey]);
    expect(brainPickValue(options, { kind: "model", model: AUTO })).toBe(AUTO);
    expect(brainPickValue(options, { kind: "claude_code", machineId: "m1" })).toBe("claude@m1/auto");
    expect(brainPickValue(options, { kind: "connect", choice: "kimi" })).toBe("connect:kimi");
    expect(
      brainPickValue(options, { kind: "claude_code", machineId: "m1", accountId: "acc-go", model: "glm-5.3" }),
    ).toBe("opencode@m1#acc-go/glm-5.3");
    // A model without a key isn't a choice to show.
    expect(brainPickValue(options, { kind: "model", model: "gpt-6.1-sol" })).toBeUndefined();
    expect(brainPickInput({ kind: "claude_code", accountId: "acc-go", model: "glm-5.3" })).toEqual({
      brain: "claude_code",
      account: "acc-go",
      model: "glm-5.3",
    });
    expect(brainPickInput({ kind: "codex", model: AUTO })).toEqual({ brain: "codex" });
  });

  test("a model's line: free and what it's sold as, Claude's by what each is for", () => {
    expect(brainModelLine(t, "claude_code", CODING_PLANS.opencode, { value: "x", label: "X", free: true })).toBe(
      "brain.free",
    );
    expect(
      brainModelLine(t, "claude_code", CODING_PLANS.opencode, { value: "x", label: "X", free: true, tag: "cheap" }),
    ).toBe("brain.free · brain.modelTag.cheap");
    expect(brainModelLine(t, "claude_code", undefined, { value: "opus", label: "Opus" })).toBe(
      "agentPage.work.brain.modelLine.opus",
    );
    expect(brainModelLine(t, "codex", undefined, { value: "gpt", label: "GPT" })).toBeUndefined();
  });

  test("the accounts the agent's page offers: one row per account of mine that can think for it at once", () => {
    const work = { ...goKey, id: "acc-work", label: "Trabalho", plan: "max", provider: null, email: "a@example.test" };
    // Two logins of one account: one row, the free one.
    const options = build([{ ...work, id: "acc-work-0", usedBy: ["Ada"] }, work]);
    const rows = options.filter((o) => "accountId" in o.pick && o.pick.accountId?.startsWith("acc-work"));
    expect(rows.map((o) => (o.pick as { model: string }).model)).toEqual([
      AUTO,
      ...brainModelChoices(undefined, claudeCode.models).map((m) => m.value),
    ]);
    expect(rows.every((o) => (o.pick as { accountId: string }).accountId === "acc-work")).toBe(true);
    expect(rows[0]?.group).toStartWith("brain.line.claudeAuto");
    expect(rows[0]?.group).toEndWith(" · Trabalho · Max");
    expect(rows[1]?.title).toEndWith(" · Trabalho · Max");
    // A proposal's or the last setup's account is a choice to show, with its model.
    expect(
      brainPickValue(options, { kind: "claude_code", machineId: "m1", accountId: "acc-work", model: "opus" }),
    ).toBe("claude@m1#acc-work/opus");
  });

  test("no account the server would refuse: in use by another agent, someone else's, or for another person's agent", () => {
    const has = (accounts: AiAccounts["accounts"], ownerIsMe = true) =>
      build(accounts, ["anthropic"], ownerIsMe).some((o) => "accountId" in o.pick && o.pick.accountId);
    expect(has([goKey])).toBe(true);
    expect(has([{ ...goKey, usedBy: ["Ada"] }])).toBe(false);
    // Made for all of its owner's agents there: it thinks for this one too.
    expect(has([{ ...goKey, usedBy: ["Ada"], shared: true }])).toBe(true);
    expect(has([{ ...goKey, mine: false }])).toBe(false);
    expect(has([{ ...goKey, status: "signed_out" }])).toBe(false);
    expect(has([goKey], false)).toBe(false);
    // With no key it can use, the coding plan is one pick that connects one.
    expect(build([{ ...goKey, usedBy: ["Ada"] }]).some((o) => o.value === "connect:opencode")).toBe(true);
  });

  test("a computer's own sign-in that can't think for the person's agent yet opens its sign-in once it exists", () => {
    const mine = { machineId: "m1", name: "Mac", online: true, mine: true, canAdd: true, keys: true };
    const plan = { kind: "claude_code" as const, machineId: "m1" };
    expect(needsOwnSignIn([{ ...mine, own: { claude_code: {} } }] as never, plan)).toBe(false);
    expect(needsOwnSignIn([{ ...mine, own: {} }] as never, plan)).toBe(true);
    expect(needsOwnSignIn([{ ...mine, mine: false, own: { claude_code: {} } }] as never, plan)).toBe(true);
    expect(needsOwnSignIn(undefined, plan)).toBe(true);
    expect(needsOwnSignIn([], { ...plan, accountId: "acc-1" })).toBe(false);
  });
});

describe("OpenCode (ADR 0132) in Quem pensa", () => {
  test("on a computer that runs it: Automático and the models its CLI listed, the free ones marked Free", () => {
    const opencode: BrainOption = {
      kind: "opencode",
      available: true,
      models: [
        { value: "opencode/big-pickle", label: "Big Pickle", free: true },
        { value: "opencode/glm-5.3", label: "glm-5.3" },
      ],
      defaultModel: null,
    };
    const box: BrainMachine = { machineId: "m2", name: "Box", online: true, options: [opencode] };
    const options = brainPickOptions(t, "en", { api: [], machines: [box], accounts: [], ownerIsMe: true });
    const rows = options.filter((o) => o.pick.kind === "opencode");
    expect(rows.map((o) => [(o.pick as { model: string }).model, o.free, o.mark])).toEqual([
      [AUTO, false, "opencode"],
      ["opencode/big-pickle", true, "opencode"],
      ["opencode/glm-5.3", false, "opencode"],
    ]);
    expect(rows[1]?.description).toBe("brain.free");
    expect(rows[1]?.keywords).toContain("free");
    expect(rows[0]?.description).toBe("brain.opencodeText");
  });
});
