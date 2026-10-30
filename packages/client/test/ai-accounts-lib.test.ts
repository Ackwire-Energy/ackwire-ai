import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AiComputer, Credential, MachineAccount, PlanUsage } from "../src/api/types";
import {
  accountChoices,
  existingAi,
  groupPlans,
  ownSignInName,
  ownSignIns,
  planWordOf,
  signInPlan,
} from "../src/lib/ai-accounts";
import { accountName, usageSourcePart } from "../src/lib/plan-usage";

const usage = (at: string, usedPercent: number): PlanUsage => ({
  windows: [{ kind: "five_hour", usedPercent }],
  source: "turn",
  at,
});

/** One of Ana's GLM Coding logins on the Mac, unless said otherwise. */
const login = (
  id: string,
  over: Partial<MachineAccount & { machineId: string }> = {},
): MachineAccount & { machineId: string } => ({
  id,
  kind: "claude_code",
  label: "GLM Coding",
  email: null,
  plan: null,
  status: "active",
  ownerId: "u_ana",
  ownerName: "Ana",
  mine: true,
  usedBy: [],
  usage: null,
  provider: "zai",
  keyHint: "MnOp",
  machineId: "m1",
  ...over,
});

const rows = (accounts: (MachineAccount & { machineId: string })[]) =>
  groupPlans(accounts).map((g) => [g.key, g.logins.map((l) => l.id)]);

describe("groupPlans: one row per account, its logins together", () => {
  test("three logins of one key are one plan: every agent on it, the newest usage, who is signed out", () => {
    const [plan, ...rest] = groupPlans([
      login("a", { usedBy: ["Ada"], usage: usage("2026-10-27T10:00:00.000Z", 40) }),
      login("t", { usedBy: ["Theo"], usage: usage("2026-10-27T11:00:00.000Z", 62), status: "signed_out" }),
      login("l", { usedBy: ["Lia"], usage: null }),
    ]);
    expect(rest).toEqual([]);
    expect(plan?.key).toBe("a");
    expect(plan?.usedBy).toEqual(["Ada", "Theo", "Lia"]);
    expect(plan?.usage?.windows[0]?.usedPercent).toBe(62);
    expect(plan?.signedOut.map((l) => l.id)).toEqual(["t"]);
  });

  test("by the account, never by its name: two keys named alike stay two rows", () => {
    expect(rows([login("a", { label: "Equipe" }), login("b", { label: "Equipe", keyHint: "WxYz" })])).toEqual([
      ["a", ["a"]],
      ["b", ["b"]],
    ]);
  });

  test("a sign-in by its email in any case; another computer, owner or plan is another account", () => {
    const claude = (id: string, email: string, over = {}) =>
      login(id, { provider: null, keyHint: null, email, label: "Claude Max", ...over });
    expect(
      rows([
        claude("a", "ana@example.com"),
        claude("b", "Ana@Example.com"),
        claude("c", "ana@example.com", { machineId: "m2" }),
        claude("d", "ana@example.com", { kind: "codex" }),
        login("e"),
        login("f", { provider: "kimi" }),
      ]),
    ).toEqual([
      ["a", ["a", "b"]],
      ["c", ["c"]],
      ["d", ["d"]],
      ["e", ["e"]],
      ["f", ["f"]],
    ]);
  });

  test("logins whose email or key the viewer can't see stay apart", () => {
    const theirs = { mine: false, ownerId: "u_bia", keyHint: null };
    expect(rows([login("a", theirs), login("b", theirs)])).toEqual([
      ["a", ["a"]],
      ["b", ["b"]],
    ]);
  });
});

describe("accountChoices: an agent's account choice, one entry per account", () => {
  const claude = (id: string, over: Partial<MachineAccount & { machineId: string }> = {}) =>
    login(id, { provider: null, keyHint: null, label: "Claude Max", email: "ana@example.com", ...over });
  const choice = (accounts: (MachineAccount & { machineId: string })[], ids: (string | null)[]) =>
    accountChoices(accounts, ids).map((c) => [c.login.id, c.usedBy, c.also]);

  test("its own login, else a free one, else one more for it where the account may have a login per agent", () => {
    const theo = claude("t", { usedBy: ["Theo"] });
    // Every login another agent's: Claude signs in once more for this one, its agents named.
    expect(choice([theo, claude("l", { usedBy: ["Lia"] })], [null])).toEqual([["t", ["Theo", "Lia"], true]]);
    expect(choice([theo, claude("a", { usedBy: ["Ada"] })], ["a"])).toEqual([["a", ["Theo", "Ada"], false]]);
    // A login that thinks for nobody comes before a new one.
    expect(choice([theo, claude("f")], [null])).toEqual([["f", ["Theo"], false]]);
    // ChatGPT stays one agent per account, and someone else's is never one to sign in to.
    expect(choice([claude("c", { kind: "codex", usedBy: ["Theo"] })], [null])).toEqual([["c", ["Theo"], false]]);
    expect(choice([claude("x", { mine: false, ownerId: "u_bia", email: null, usedBy: ["Theo"] })], [null])).toEqual([
      ["x", ["Theo"], false],
    ]);
  });

  test("the login chosen comes before the one the agent thinks with", () => {
    const logins = [claude("a", { usedBy: ["Ada"] }), claude("b")];
    expect(choice(logins, ["b", "a"])).toEqual([["b", ["Ada"], false]]);
    expect(choice(logins, [null, "a"])).toEqual([["a", ["Ada"], false]]);
  });
});

describe("existingAi: what a person already has for an agent with no AI", () => {
  const claude = (id: string, email: string, over: Partial<MachineAccount & { machineId: string }> = {}) =>
    login(id, { provider: null, keyHint: null, label: id, email, ...over });
  const key = (id: string, revokedAt: string | null = null): Credential => ({
    id,
    provider: "anthropic",
    label: id,
    keyHint: "7f2a",
    createdAt: "2026-10-01T00:00:00.000Z",
    revokedAt,
  });
  const acts = (
    accounts: (MachineAccount & { machineId: string })[],
    account: string | null,
    keys: Credential[] = [],
  ) =>
    existingAi({ accounts, account }, keys).map((r) =>
      r.kind === "key" ? ["key", r.key.id] : [r.act, r.choice.login.id],
    );

  test("free accounts first, then those to sign in to or move, the keys, someone else's; never its own login", () => {
    expect(
      acts(
        [
          claude("theo", "walt@acme.com", { usedBy: ["Theo"] }),
          claude("plus", "walt@gmail.com", { kind: "codex", usedBy: ["Theo"] }),
          claude("out", "ti@acme.example", { status: "signed_out" }),
          claude("free", "contato@estudio.example"),
          claude("own", "ada@acme.com", { usedBy: ["Ada"], status: "signed_out" }),
          claude("bia", "bia@acme.com", { mine: false, ownerId: "u_bia", email: null }),
        ],
        "own",
        [key("k1"), key("gone", "2026-10-20T00:00:00.000Z")],
      ),
    ).toEqual([
      ["use", "free"],
      ["also", "theo"],
      ["move", "plus"],
      ["again", "out"],
      ["key", "k1"],
      ["locked", "bia"],
    ]);
  });

  test("a signed-out login another agent thinks with is nobody's to use; a free login of an account comes first", () => {
    expect(
      acts([claude("c", "walt@gmail.com", { kind: "codex", usedBy: ["Theo"], status: "signed_out" })], null),
    ).toEqual([]);
    expect(acts([claude("t", "walt@acme.com", { usedBy: ["Theo"] }), claude("f", "walt@acme.com")], null)).toEqual([
      ["use", "f"],
    ]);
  });
});

describe("the computers' own sign-ins", () => {
  const computer = (over: Partial<AiComputer>): AiComputer => ({
    machineId: "mac",
    name: "MacBook Air",
    online: true,
    mine: true,
    canAdd: true,
    keys: true,
    brains: { claude_code: true, codex: true },
    ...over,
  });

  test("each CLI's own sign-in a computer reported, Claude Code first, with its plan and usage", () => {
    const u = usage("2026-10-27T10:00:00.000Z", 40);
    const rows = ownSignIns({
      computers: [
        computer({ own: { codex: { usage: u }, claude_code: { plan: "max" } } }),
        computer({ machineId: "pc", name: "PC", own: {} }),
        // A server too old to say.
        computer({ machineId: "old", name: "Old" }),
      ],
    });
    expect(rows.map((r) => [r.key, r.computer, r.kind, r.plan, r.usage])).toEqual([
      ["mac:claude_code", "MacBook Air", "claude_code", "max", null],
      ["mac:codex", "MacBook Air", "codex", null, u],
    ]);
    expect(ownSignIns(undefined)).toEqual([]);
  });

  test("the plan's word", () => {
    expect(planWordOf("max")).toBe("Max");
    expect(planWordOf("PRO")).toBe("Pro");
    expect(planWordOf(null)).toBeNull();
  });

  test("the plan an agent's sign-in is on: its account's, or with none its computer's own sign-in's", () => {
    const row = computer({ own: { claude_code: { plan: "team" } } });
    const seat = login("acct_team", { plan: "max", provider: null });
    expect(signInPlan({ account: null, accounts: [seat] }, row, "claude_code")).toBe("team");
    expect(signInPlan({ account: "acct_team", accounts: [seat] }, row, "claude_code")).toBe("max");
    // Codex's own sign-in said no plan; a computer whose row isn't there yet says none either.
    expect(signInPlan({ account: null, accounts: [] }, row, "codex")).toBeNull();
    expect(signInPlan({ account: null, accounts: [] }, undefined, "claude_code")).toBeNull();
  });
});

describe("the computer's own sign-in by name", () => {
  const WORDS: Record<string, string> = {
    "connectAi.own.shared": "The account your agents share",
    "agentPage.work.brain.thisComputer": "{{computer}}'s account",
    "usageViews.agent.sharedPart": "{{percent}} on the account your agents share",
    "usageViews.agent.computerPart": "{{percent}} on {{computer}}'s own account",
  };
  const t = ((key: string, o: Record<string, string> = {}) =>
    (WORDS[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, k: string) => o[k] ?? "")) as unknown as TFunction;

  test("the viewer's own computer: the account their agents share; someone else's: that computer's", () => {
    expect(ownSignInName(t, true, "MacBook")).toBe("The account your agents share");
    expect(ownSignInName(t, false, "MacBook")).toBe("MacBook's account");
    const own = { label: null, machineName: "MacBook", mine: true };
    expect(accountName(t, own)).toBe("The account your agents share");
    expect(accountName(t, { ...own, mine: false })).toBe("MacBook's account");
    expect(accountName(t, { ...own, label: "Trabalho" })).toBe("Trabalho");
    const source = (mine: boolean) =>
      ({
        key: "m1:claude_code:computer",
        type: "plan",
        kind: "claude_code",
        account: { accountId: null, label: null, machineName: "MacBook", mine },
        removed: false,
        tokens: 1000,
        share: 97,
        lastDay: null,
        now: true,
      }) as unknown as Parameters<typeof usageSourcePart>[2];
    expect(usageSourcePart(t, "en", source(true))).toBe("97% on the account your agents share");
    expect(usageSourcePart(t, "en", source(false))).toBe("97% on MacBook's own account");
  });
});
