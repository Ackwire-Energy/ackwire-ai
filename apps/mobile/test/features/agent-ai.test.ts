import { describe, expect, test } from "bun:test";
import type { AgentBrain, MachineAccount, PlanUsage } from "@agenteschat/client";
import { sharePlanBody } from "@agenteschat/client/lib/plans";
import { accountKindOf, agentAccounts, takenFrom, thinkingUsage } from "../../src/features/ai/logic";
import { translator } from "./fixtures";

const usage = (used: number): PlanUsage => ({
  windows: [{ kind: "five_hour", usedPercent: used }],
  source: "turn",
  at: "2026-10-27T12:00:00.000Z",
});

const account = (id: string, over: Partial<MachineAccount> = {}): MachineAccount => ({
  id,
  kind: "claude_code",
  label: id,
  email: null,
  plan: "max",
  status: "active",
  ownerId: "u1",
  ownerName: "Walter Nogueira",
  mine: true,
  usedBy: [],
  usage: null,
  provider: null,
  keyHint: null,
  ...over,
});

type View = Pick<AgentBrain, "accounts" | "account" | "ownSignIn" | "ownUsage">;

describe("the agent's AI", () => {
  test("only a plan brain has accounts to pick", () => {
    expect(accountKindOf("claude_code")).toBe("claude_code");
    expect(accountKindOf("codex")).toBe("codex");
    expect(accountKindOf("model")).toBeNull();
    expect(accountKindOf(undefined)).toBeNull();
  });

  test("its page lists the viewer's own accounts of that kind, and someone else's only while it's this agent's", () => {
    const view: View = {
      account: "theirs-now",
      ownSignIn: false,
      ownUsage: {},
      accounts: [
        account("mine"),
        account("codex", { kind: "codex" }),
        account("theirs", { mine: false }),
        account("theirs-now", { mine: false }),
      ],
    };
    expect(agentAccounts(view, "claude_code").map((a) => a.id)).toEqual(["mine", "theirs-now"]);
    expect(agentAccounts(view, "codex").map((a) => a.id)).toEqual(["codex"]);
  });

  test("the usage shown is its account's, or the computer's own sign-in's only where that thinks for it", () => {
    const base: View = { account: "a1", ownSignIn: true, ownUsage: { claude_code: usage(40) }, accounts: [] };
    expect(thinkingUsage({ ...base, accounts: [account("a1", { usage: usage(90) })] }, "claude_code")).toEqual(
      usage(90),
    );
    expect(thinkingUsage({ ...base, accounts: [account("a1")] }, "claude_code")).toBeUndefined();
    expect(thinkingUsage({ ...base, account: null }, "claude_code")).toEqual(usage(40));
    expect(thinkingUsage({ ...base, account: null, ownSignIn: false }, "claude_code")).toBeUndefined();
    expect(thinkingUsage({ ...base, account: null }, "codex")).toBeUndefined();
  });

  test("picking an account another agent thinks with takes it from that one", () => {
    expect(takenFrom(account("a", { usedBy: ["Infra"] }), "Dev")).toEqual(["Infra"]);
    expect(takenFrom(account("a", { usedBy: ["Dev"] }), "Dev")).toEqual([]);
  });

  test("before it replies to everyone on a plan: the words of the plan, a seat or a coding plan's maker", async () => {
    const t = await translator("en");
    expect(sharePlanBody(t, "claude_code", "max")).toContain("Claude's terms say your plan is for your own use");
    expect(sharePlanBody(t, "claude_code", "Team")).toContain("each seat is for one person");
    expect(sharePlanBody(t, "codex", null)).toContain("ChatGPT plans are meant for personal use");
    expect(sharePlanBody(t, "claude_code", "max", "Z.ai")).toContain("Z.ai says the plan is for its subscriber only");
  });

  test("Claude's sign-in asks for no address: Claude's page picks the account, an account already there is offered", async () => {
    // The flow is a component the tests can't render: what it wires in, as text.
    const flow = await Bun.file(new URL("../../src/features/ai/AddAccount.tsx", import.meta.url).pathname).text();
    expect(flow).not.toMatch(/TextInput|emailAddress|aiAccounts\.add\.email/);
    // The hint (the account's own email, signing in again) goes through the shared start the client tests pin.
    expect(flow).toMatch(/beginLogin\(\s*\(input\) => api\.machines\.beginAccountLogin\(/);
    expect(flow).toMatch(/\{\s*again,\s*provider,\s*hint,\s*\}/);
    expect(flow).toContain("freeDuplicate(result)");
    expect(flow).toContain('t("connectAi.useAnyway"');
    const t = await translator("pt-BR");
    expect(t("agentPage.work.brain.add.duplicate.claude_code", { account: "ana@acme.com" })).toBe(
      "O Claude entrou como ana@acme.com, uma conta que você já conectou. Para usar outra, saia na página do Claude e tente de novo.",
    );
    expect(t("connectAi.own.one", { for: "para a", name: "Ada" })).toBe("Uma conta só para a Ada");
  });
});
