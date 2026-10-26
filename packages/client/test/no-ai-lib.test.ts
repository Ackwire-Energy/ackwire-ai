import { describe, expect, test } from "bun:test";
import type { AgentBrain, AiComputer, ComputerSetup } from "../src/api/types";
import { setupView } from "../src/lib/computer";
import {
  type AiChoice,
  defaultChoice,
  firstAgent,
  gateDims,
  kindOf,
  PLAN_CHOICES,
  type PlanChoice,
  type PlanGate,
  planGate,
} from "../src/lib/no-ai";

const setup = (patch: Partial<ComputerSetup> = {}) =>
  setupView({
    mode: "external",
    state: "preparing",
    step: "installing",
    reason: null,
    since: "2026-10-26T10:00:00.000Z",
    requestedAt: "2026-10-26T10:00:00.000Z",
    expectedReadyAt: null,
    secondsLeft: 240,
    secondsWaited: 60,
    notifyByEmail: true,
    specs: null,
    machineId: null,
    ...patch,
  });

const option = (kind: "claude_code" | "codex", over: Partial<AgentBrain["options"][number]> = {}) => ({
  kind,
  available: true,
  experimental: false,
  models: [],
  defaultModel: null,
  ...over,
});

/** Ada on the MacBook, hers: every plan can sign in there. */
const brain = (over: Partial<AgentBrain> = {}): AgentBrain => ({
  agentId: "ada",
  brain: "model",
  model: null,
  effectiveModel: null,
  fallback: true,
  computer: { machineId: "m1", name: "MacBook", online: true },
  options: [option("claude_code"), option("codex")],
  machines: [],
  canEdit: true,
  account: null,
  effort: null,
  accounts: [],
  canManageAccounts: true,
  accountsSupported: true,
  onlyOwner: false,
  canUsePlans: true,
  ownSignIn: false,
  ownUsage: {},
  ...over,
});

const MAC: AiComputer = {
  machineId: "m1",
  name: "MacBook",
  online: true,
  mine: true,
  canAdd: true,
  keys: true,
  brains: { claude_code: true, codex: true },
};

const gate = (patch: Partial<Parameters<typeof planGate>[0]> = {}) =>
  planGate({ choice: "claude", edition: "selfhost", setup: null, brain: brain(), computer: MAC, ...patch });

describe("planGate: what a plan's panel can do now", () => {
  test("the Cloud's computer on its way (preparing, a capacity wait, a problem) waits in place, before anything loads", () => {
    for (const view of [setup(), setup({ state: "waiting", reason: "capacity" }), setup({ state: "problem" })]) {
      expect(gate({ edition: "cloud", setup: view, brain: undefined })).toEqual({ state: "preparing", view });
    }
  });

  test("the setup says ready but the agent's computer comes with the next refresh: still preparing, with no view", () => {
    const ready = setup({ state: "ready", machineId: "m1" });
    expect(gate({ edition: "cloud", setup: ready, brain: brain({ computer: null }) })).toEqual({
      state: "preparing",
      view: null,
    });
  });

  test("loading until the brain view and the edition are known", () => {
    expect(gate({ brain: undefined })).toEqual({ state: "loading" });
    expect(gate({ edition: null })).toEqual({ state: "loading" });
  });

  test("an agent the viewer doesn't own, before anything about its computer", () => {
    expect(gate({ brain: brain({ canUsePlans: false, computer: null }) })).toEqual({ state: "locked", who: "owner" });
  });

  test("self-host with no computer for the agent: missing", () => {
    expect(gate({ brain: brain({ computer: null }) })).toEqual({ state: "missing" });
  });

  test("its computer is offline", () => {
    expect(gate({ brain: brain({ computer: { machineId: "m1", name: "MacBook", online: false } }) })).toEqual({
      state: "offline",
    });
  });

  test("the plan's program isn't there, the runner is old, or the computer takes no plan key: unsupported", () => {
    const missingCodex = brain({ options: [option("claude_code"), option("codex", { available: false })] });
    expect(gate({ choice: "chatgpt", brain: missingCodex })).toEqual({ state: "unsupported", reason: "not_installed" });
    // The same computer still takes Claude.
    expect(gate({ brain: missingCodex })).toEqual({ state: "ready" });
    const old = brain({
      options: [option("claude_code", { available: false, reason: "runner_old" }), option("codex")],
    });
    expect(gate({ brain: old })).toEqual({ state: "unsupported", reason: "runner_old" });
    expect(gate({ brain: brain({ accountsSupported: false }) })).toEqual({
      state: "unsupported",
      reason: "runner_old",
    });
    expect(gate({ choice: "zai", computer: { ...MAC, keys: false } })).toEqual({
      state: "unsupported",
      reason: "keys",
    });
    expect(gate({ choice: "zai", computer: undefined })).toEqual({ state: "unsupported", reason: "keys" });
    expect(gate({ choice: "zai" })).toEqual({ state: "ready" });
  });

  test("someone else's connected computer: only they sign a plan in there", () => {
    expect(gate({ brain: brain({ canManageAccounts: false }) })).toEqual({ state: "locked", who: "computer" });
  });

  test("otherwise ready; only missing and unsupported dim a tile", () => {
    expect(gate()).toEqual({ state: "ready" });
    const dims: PlanGate[] = [{ state: "missing" }, { state: "unsupported", reason: "keys" }];
    expect(dims.map(gateDims)).toEqual([true, true]);
    const lit: PlanGate[] = [
      { state: "ready" },
      { state: "loading" },
      { state: "offline" },
      { state: "preparing", view: null },
      { state: "locked", who: "owner" },
    ];
    expect(lit.map(gateDims)).toEqual([false, false, false, false, false]);
  });
});

describe("defaultChoice: what the picker opens on", () => {
  const ready: PlanGate = { state: "ready" };
  test("an intent picks its option", () => {
    const picks: [Parameters<typeof defaultChoice>[0]["intent"], AiChoice][] = [
      ["claude", "claude"],
      ["chatgpt", "chatgpt"],
      ["api_key", "key"],
      ["any", "claude"],
      ["task", "claude"],
    ];
    for (const [intent, choice] of picks) {
      expect(defaultChoice({ intent, ownsAgents: true, mayAddKey: true, claudeGate: ready })).toBe(choice);
    }
  });

  test("the key for someone who owns no agent but may add keys, and where Claude can't sign in at all", () => {
    expect(defaultChoice({ ownsAgents: false, mayAddKey: true, claudeGate: ready })).toBe("key");
    expect(defaultChoice({ ownsAgents: true, mayAddKey: true, claudeGate: { state: "missing" } })).toBe("key");
  });

  test("Claude otherwise, even while its computer is prepared or the person may not add keys", () => {
    expect(defaultChoice({ ownsAgents: false, mayAddKey: false, claudeGate: ready })).toBe("claude");
    expect(
      defaultChoice({ ownsAgents: true, mayAddKey: true, claudeGate: { state: "preparing", view: setup() } }),
    ).toBe("claude");
  });
});

describe("the agent a plan starts on, and the order of the plans", () => {
  const agents = [{ id: "ada" }, { id: "theo" }, { id: "lia" }];
  test("the one asked for, then the first with no AI, then the first", () => {
    expect(firstAgent(agents, () => true, "lia")?.id).toBe("lia");
    expect(firstAgent(agents, (id) => id === "ada")?.id).toBe("theo");
    expect(firstAgent(agents, () => true)?.id).toBe("ada");
    expect(firstAgent(agents, () => false, "someone-else")?.id).toBe("ada");
    expect(firstAgent([], () => false)).toBeUndefined();
  });

  test("Claude, ChatGPT, then the coding plans; ChatGPT alone signs in through Codex", () => {
    expect(PLAN_CHOICES).toEqual(["claude", "chatgpt", "zai", "kimi", "minimax", "opencode"]);
    expect(PLAN_CHOICES.map((c: PlanChoice) => kindOf(c))).toEqual([
      "claude_code",
      "codex",
      "claude_code",
      "claude_code",
      "claude_code",
      "claude_code",
    ]);
  });
});
