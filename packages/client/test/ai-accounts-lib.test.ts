import { describe, expect, test } from "bun:test";
import type { AiComputer, MachineAccount, PlanUsage } from "../src/api/types";
import { groupPlans, ownSignIns, planWordOf } from "../src/lib/ai-accounts";

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
});
