import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { Agent, AgentAudience, AgentBrain, AiComputer, ComputerSetup } from "../src/api/types";
import { setupView } from "../src/lib/computer";
import { serverBody } from "../src/lib/message-body";
import {
  type AgentAi,
  type AiChoice,
  ALL_AGENTS,
  agentAi,
  allAgents,
  defaultChoice,
  defaultTarget,
  firstAgent,
  gateDims,
  kindOf,
  noAiCardOf,
  onlyOwnerReplies,
  ownSignInFor,
  PLAN_CHOICES,
  type PlanChoice,
  type PlanGate,
  planGate,
  signInAgainPlan,
  signsInPerAgent,
} from "../src/lib/no-ai";
import { LOGIN_PER_AGENT } from "../src/lib/plans";

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

  test("the computer's own sign-in, to share: the person connected that computer, and Claude is signed in there", () => {
    const signedIn: AiComputer = { ...MAC, own: { claude_code: { plan: "max" } } };
    const own = brain({ ownSignIn: true });
    expect(ownSignInFor("claude", own, signedIn)).toBe(true);
    // Claude Code isn't signed in there (or the row isn't in yet): no account to share.
    expect(ownSignInFor("claude", own, MAC)).toBe(false);
    expect(ownSignInFor("claude", own, undefined)).toBe(false);
    // ChatGPT's own sign-in isn't reported: taken as there.
    expect(ownSignInFor("chatgpt", own, MAC)).toBe(true);
    // A coding plan signs in with its key; someone else's computer's sign-in is never the person's.
    expect(ownSignInFor("zai", own, signedIn)).toBe(false);
    expect(ownSignInFor("claude", brain({ ownSignIn: false }), signedIn)).toBe(false);
    expect(ownSignInFor("claude", undefined, signedIn)).toBe(false);
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

describe("All agents: one login per agent, the key pasted once", () => {
  test("Claude and the coding plans sign in once per agent; ChatGPT stays one agent per account", () => {
    expect(LOGIN_PER_AGENT).toEqual({ claude_code: true, codex: false, key: true });
    expect(PLAN_CHOICES.filter(signsInPerAgent)).toEqual(["claude", "zai", "kimi", "minimax", "opencode"]);
  });

  /** Ada and Theo have no AI, Lia is on GLM Coding, Bo on the API key, Cy on Claude, Di on the other computer. */
  const team = ["ada", "theo", "lia", "bo", "cy", "di"].map((id) => ({ id }));
  const ai: Record<string, AgentAi> = { ada: null, theo: null, lia: "zai", bo: "key", cy: "claude", di: null };
  const machines: Record<string, string> = { di: "m2" };
  const set = (choice: PlanChoice, agents = team, aiOf = (id: string) => ai[id] ?? null) =>
    allAgents({ choice, agents, aiOf, machineOf: (id) => machines[id] ?? "m1" }).map((a) => a.id);

  test("the agents with no AI on the first one's computer and those on this plan; never one on the key or another plan", () => {
    expect(set("zai")).toEqual(["ada", "theo", "lia"]);
    expect(set("kimi")).toEqual(["ada", "theo"]);
    // The first one's computer decides: with Di first, Di's, where nobody else fits.
    expect(set("zai", [...team.filter((a) => a.id === "di"), ...team.filter((a) => a.id !== "di")])).toEqual([]);
    // No computer yet (the Cloud's on its way) is one place for all of them.
    expect(
      allAgents({ choice: "zai", agents: team, aiOf: () => null, machineOf: () => null }).map((a) => a.id),
    ).toEqual(["ada", "theo", "lia", "bo", "cy", "di"]);
  });

  test("Claude's like a coding plan's; none for ChatGPT, and none for a single agent", () => {
    expect(set("claude")).toEqual(["ada", "theo", "cy"]);
    expect(set("chatgpt")).toEqual([]);
    expect(set("zai", [{ id: "ada" }, { id: "bo" }])).toEqual([]);
  });

  test("the panel opens on the agent asked for, then all of them while two have no AI, then the first with no AI", () => {
    const agents = team;
    const all = allAgents({
      choice: "zai",
      agents,
      aiOf: (id) => ai[id] ?? null,
      machineOf: (id) => machines[id] ?? "m1",
    });
    const hasAi = (id: string) => ai[id] !== null;
    expect(defaultTarget({ agents, set: all, hasAi, asked: "theo" })).toBe("theo");
    expect(defaultTarget({ agents, set: all, hasAi })).toBe(ALL_AGENTS);
    expect(defaultTarget({ agents, set: all, hasAi, asked: "someone-else" })).toBe(ALL_AGENTS);
    // One left with no AI, or no set at all (Claude): the first with no AI.
    expect(defaultTarget({ agents, set: all, hasAi: (id) => id !== "theo" })).toBe("theo");
    expect(defaultTarget({ agents, set: [], hasAi })).toBe("ada");
    expect(defaultTarget({ agents: [], set: [], hasAi })).toBeUndefined();
  });

  test("the agent whose face asks comes before the first with no AI, while it has none; All agents still comes first", () => {
    const hasAi = (id: string) => ai[id] !== null;
    const zai = allAgents({ choice: "zai", agents: team, aiOf: (id) => ai[id] ?? null, machineOf: () => "m1" });
    expect(defaultTarget({ agents: team, set: [], hasAi, host: "theo" })).toBe("theo");
    expect(defaultTarget({ agents: team, set: [], hasAi, host: "di" })).toBe("di");
    // Once it has an AI, the next plan goes to the first with none.
    expect(defaultTarget({ agents: team, set: [], hasAi, host: "lia" })).toBe("ada");
    expect(defaultTarget({ agents: team, set: zai, hasAi, host: "theo" })).toBe(ALL_AGENTS);
    expect(defaultTarget({ agents: team, set: [], hasAi, host: "theo", picked: ALL_AGENTS })).toBe("theo");
    expect(defaultTarget({ agents: team, set: [], hasAi, host: "theo", picked: "ada" })).toBe("ada");
  });

  test("a pick holds while the plan allows it: All agents elsewhere is the first with no AI", () => {
    const hasAi = (id: string) => ai[id] !== null;
    const zai = allAgents({ choice: "zai", agents: team, aiOf: (id) => ai[id] ?? null, machineOf: () => "m1" });
    expect(defaultTarget({ agents: team, set: zai, hasAi, asked: "theo", picked: ALL_AGENTS })).toBe(ALL_AGENTS);
    expect(defaultTarget({ agents: team, set: [], hasAi, asked: "theo", picked: ALL_AGENTS })).toBe("ada");
    expect(defaultTarget({ agents: team, set: zai, hasAi, asked: "theo", picked: "lia" })).toBe("lia");
    // With no set, whose computer the panel reads: the first with no AI, where All agents is too.
    expect(defaultTarget({ agents: team, set: [], hasAi, picked: ALL_AGENTS })).toBe("ada");
    expect(zai[0]?.id).toBe("ada");
  });

  test("the set is on the first with no AI's computer, even after one on this plan", () => {
    const agents = [{ id: "lia" }, { id: "ada" }, { id: "theo" }];
    const aiOf = (id: string): AgentAi => (id === "lia" ? "zai" : null);
    const machineOf = (id: string) => (id === "lia" ? "m2" : "m1");
    expect(allAgents({ choice: "zai", agents, aiOf, machineOf }).map((a) => a.id)).toEqual(["ada", "theo"]);
  });

  test("what an agent thinks with, from its row and its AI status", () => {
    expect(agentAi({ brain: { kind: "codex", model: null } }, "ready")).toBe("chatgpt");
    expect(agentAi({ brain: { kind: "claude_code", model: null } }, "no_ai")).toBe("claude");
    expect(agentAi({ brain: { kind: "claude_code", model: null, provider: "zai" } }, "ready")).toBe("zai");
    expect(agentAi({ brain: { kind: "model", model: null } }, "ready")).toBe("key");
    expect(agentAi({ brain: { kind: "model", model: null } }, "no_ai")).toBeNull();
    expect(agentAi(undefined, undefined)).toBeNull();
  });
});

describe("the note before inviting: no agent would answer anyone else", () => {
  const ME = "u_ana";
  const ONLY_ME: AgentAudience = { mode: "owner", userIds: [] };
  const agent = (id: string, audience: AgentAudience, ownerUserId: string | null = ME): Agent => ({
    id,
    name: id,
    handle: id,
    role: "",
    instructions: "",
    model: "auto",
    ownerUserId,
    hasCredential: false,
    createdAt: "2026-10-27T10:00:00.000Z",
    audience,
  });
  const everyone: AgentAudience = { mode: "everyone", userIds: [] };

  test("every agent with an AI is mine and answers only me", () => {
    const team = [agent("ada", ONLY_ME), agent("theo", ONLY_ME), agent("lia", everyone)];
    // Lia has no AI yet: she answers nobody, whatever her audience says.
    expect(onlyOwnerReplies(team, (id) => id !== "lia", ME)).toBe(true);
  });

  test("not while one on the API key answers everyone, one answers some people, or someone else's agent thinks", () => {
    const hasAi = () => true;
    expect(onlyOwnerReplies([agent("ada", ONLY_ME), agent("bo", everyone)], hasAi, ME)).toBe(false);
    expect(
      onlyOwnerReplies([agent("ada", ONLY_ME), agent("bo", { mode: "people", userIds: ["u_bia"] })], hasAi, ME),
    ).toBe(false);
    expect(onlyOwnerReplies([agent("ada", ONLY_ME), agent("bo", ONLY_ME, "u_bia")], hasAi, ME)).toBe(false);
  });

  test("not while no agent has an AI", () => {
    expect(onlyOwnerReplies([agent("ada", ONLY_ME)], () => false, ME)).toBe(false);
    expect(onlyOwnerReplies([], () => true, ME)).toBe(false);
  });
});

describe("a card whose plan's sign-in ended", () => {
  const meta = (reason: string) => ({
    bodyCode: "no_ai",
    noAi: { agentId: "ada", forUserId: null, reason, intent: "task", runId: "r1" },
  });

  test("the agent says its AI is signed out, not that it has none", () => {
    expect(noAiCardOf(meta("not_signed_in"))?.signedOut).toBe(true);
    expect(noAiCardOf(meta("no_key"))?.signedOut).toBeUndefined();
    const t = ((key: string) => key) as unknown as TFunction;
    expect(serverBody(t, "…", meta("not_signed_in"))).toBe("chat.body.no_ai_signed_out");
    expect(serverBody(t, "…", meta("cli_missing"))).toBe("chat.body.no_ai");
  });

  test("Sign in again opens on the agent's own plan; with no plan left to sign in to, Connect at the card's step", () => {
    const out = { signedOut: true };
    const on = (kind: "claude_code" | "codex" | "model", provider?: string): Pick<Agent, "brain"> => ({
      brain: { kind, model: null, ...(provider ? { provider } : {}) },
    });
    expect(signInAgainPlan(out, on("claude_code"))).toBe("claude");
    expect(signInAgainPlan(out, on("codex"))).toBe("chatgpt");
    expect(signInAgainPlan(out, on("claude_code", "zai"))).toBe("zai");
    expect(signInAgainPlan(out, on("model"))).toBeNull();
    expect(signInAgainPlan(out, undefined)).toBeNull();
    expect(signInAgainPlan({}, on("codex"))).toBeNull();
  });
});
