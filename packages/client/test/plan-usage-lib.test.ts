import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AgentBrainLine, AiAccounts, AiComputer, AiStatus, PlanUsage } from "../src/api/types";
import { ownPlanLines, planMeterText, usageShown, workspaceUsesApi } from "../src/lib/plan-usage";

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

describe("the workspace's budget only where it uses the API (ADR 0063 §5)", () => {
  const ready = (...ids: string[]): Pick<AiStatus, "agents"> => ({
    agents: ids.map((agentId) => ({ agentId, state: "ready" as const })),
  });
  const onApi = { kind: "model" as const, model: null };

  test("on plans alone, nothing spent through the API: no budget", () => {
    expect(workspaceUsesApi([{ id: "a1", brain: onPlan() }], ready("a1"), 0)).toBe(false);
  });

  test("an agent on the API with a key: the budget, even at 0%", () => {
    expect(
      workspaceUsesApi(
        [
          { id: "a1", brain: onPlan() },
          { id: "a2", brain: onApi },
        ],
        ready("a1", "a2"),
        0,
      ),
    ).toBe(true);
    // A server too old to say who thinks: the API, as an agent's own line reads it.
    expect(workspaceUsesApi([{ id: "a2" }], ready("a2"), 0)).toBe(true);
  });

  test("an agent on the API with no key thinks with nothing: no budget, nor while the AI status loads", () => {
    const noKey: Pick<AiStatus, "agents"> = { agents: [{ agentId: "a2", state: "no_ai", reason: "no_key" }] };
    expect(workspaceUsesApi([{ id: "a2", brain: onApi }], noKey, 0)).toBe(false);
    expect(workspaceUsesApi([{ id: "a2", brain: onApi }], undefined, 0)).toBe(false);
  });

  test("spent through the API this month (a plan's fallback, or a key removed since): the budget", () => {
    expect(workspaceUsesApi([{ id: "a1", brain: onPlan() }], ready("a1"), 1.2)).toBe(true);
    expect(workspaceUsesApi([], undefined, 0.1)).toBe(true);
  });
});

describe("your plans with their limits (Sua conta, the profile menu near a limit)", () => {
  const words: Record<string, string> = {
    "aiAccounts.connect.claude_code": "Claude",
    "aiAccounts.page.on": "on {{computer}}",
  };
  const t = ((key: string, o?: Record<string, string>) =>
    (words[key] ?? key).replace(/{{(\w+)}}/g, (_, k: string) => o?.[k] ?? "")) as unknown as TFunction;
  const ME = "u_ana";
  const computer = (own: AiComputer["own"], machineId = "m1", name = "MacBook"): AiComputer => ({
    machineId,
    name,
    online: true,
    mine: true,
    canAdd: true,
    keys: true,
    brains: { claude_code: true, codex: true },
    own,
  });
  const account = (id: string, over: Partial<AiAccounts["accounts"][number]> = {}): AiAccounts["accounts"][number] => ({
    id,
    kind: "claude_code",
    label: "Claude Team",
    email: `${id}@acme.com`,
    plan: "team",
    status: "active",
    ownerId: ME,
    ownerName: "Ana",
    mine: true,
    usedBy: ["Atlas"],
    usage: HOURS,
    provider: null,
    keyHint: null,
    machineId: "m1",
    computer: "MacBook",
    ...over,
  });
  /** One of Ana's agents on her MacBook's own sign-in (no account, no coding plan). */
  const onOwn = (name = "Ada", over: Partial<AgentBrainLine> = {}, ownerUserId: string | null = ME) => ({
    name,
    ownerUserId,
    brain: onPlan({ account: "Claude Max", computer: "MacBook", ...over }),
  });

  test("the computers' own sign-ins, then the accounts: each with its maker's mark, its name and its limits", () => {
    const glm = account("a2", {
      label: "GLM Coding",
      plan: null,
      provider: "zai",
      email: null,
      keyHint: "MnOp",
      usedBy: ["Iris"],
    });
    const view = {
      computers: [computer({ claude_code: { plan: "max", usage: HOURS } })],
      accounts: [account("a1"), account("a3", { label: "Trabalho" }), glm],
    };
    // Named as "Seus planos" names them: the plan once, after a name that doesn't say it.
    expect(ownPlanLines(t, view, [onOwn()], ME)).toEqual([
      { key: "m1:claude_code", logo: "claude_code", name: "Claude · Max", usage: HOURS },
      { key: "a1", logo: "claude_code", name: "Claude Team", usage: HOURS },
      { key: "a3", logo: "claude_code", name: "Trabalho · Team", usage: HOURS },
      { key: "a2", logo: "zai", name: "GLM Coding", usage: HOURS },
    ]);
  });

  test("no window known yet: nothing; a plan that refused a request before any window: its line", () => {
    const refused: PlanUsage = { ...usage([]), limited: true };
    const view = {
      computers: [computer({ codex: {} })],
      accounts: [
        account("a1", { usage: null }),
        account("a2", { usage: usage([]) }),
        account("a3", { usage: refused }),
      ],
    };
    expect(ownPlanLines(t, view, [onOwn("Ada", { kind: "codex" })], ME).map((p) => p.key)).toEqual(["a3"]);
    expect(ownPlanLines(t, undefined, [], ME)).toEqual([]);
  });

  test("an account's logins are one line, and every plan has its own", () => {
    const view = {
      computers: [],
      accounts: [account("a1"), account("a1b", { email: "a1@acme.com" }), account("a2"), account("a3"), account("a4")],
    };
    expect(ownPlanLines(t, view, [], ME).map((p) => p.key)).toEqual(["a1", "a2", "a3", "a4"]);
  });

  test("an account no agent thinks with, or signed out on every login, isn't one of the workspace's plans", () => {
    const view = {
      computers: [],
      accounts: [
        account("a1", { usedBy: [] }),
        account("a2", { status: "signed_out" }),
        // One login of a3 is still in: its agent thinks with it.
        account("a3", { status: "signed_out", usedBy: [] }),
        account("a3b", { email: "a3@acme.com" }),
      ],
    };
    expect(ownPlanLines(t, view, [], ME).map((p) => p.key)).toEqual(["a3"]);
  });

  test("a computer's own sign-in: while one of your agents there thinks with it, with no account", () => {
    const view = { computers: [computer({ claude_code: { plan: "max", usage: HOURS } })], accounts: [account("a1")] };
    const lines = (agents: ReturnType<typeof onOwn>[]) => ownPlanLines(t, view, agents, ME).map((p) => p.key);
    expect(lines([onOwn()])).toEqual(["m1:claude_code", "a1"]);
    // Nobody there, someone else's agent (the sign-in thinks only for its pairer's), an agent on one of your accounts
    // there, on a coding plan's key, on another computer, or on Codex.
    expect(lines([])).toEqual(["a1"]);
    expect(lines([onOwn("Ada", {}, "u_bia")])).toEqual(["a1"]);
    expect(lines([onOwn("Atlas", { account: "Claude Team" })])).toEqual(["a1"]);
    expect(lines([onOwn("Iris", { provider: "zai", account: "GLM Coding" })])).toEqual(["a1"]);
    expect(lines([onOwn("Ada", { computer: "iMac" })])).toEqual(["a1"]);
    expect(lines([onOwn("Ada", { kind: "codex" })])).toEqual(["a1"]);
  });

  test("own sign-ins on more than one computer say which", () => {
    const view = {
      computers: [
        computer({ claude_code: { plan: "max", usage: HOURS } }),
        computer({ claude_code: { plan: "max", usage: HOURS } }, "m2", "iMac"),
      ],
      accounts: [],
    };
    const agents = [onOwn(), onOwn("Bia", { computer: "iMac" })];
    expect(ownPlanLines(t, view, agents, ME).map((p) => p.name)).toEqual([
      "Claude · Max on MacBook",
      "Claude · Max on iMac",
    ]);
    expect(ownPlanLines(t, { ...view, computers: view.computers.slice(0, 1) }, agents, ME)[0]?.name).toBe(
      "Claude · Max",
    );
  });
});
