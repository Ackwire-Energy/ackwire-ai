import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AgentBrain, AgentSetupResult, Model, NewAgentSetup } from "../src/api/types";
import {
  newAgentStart,
  newAgentStartText,
  setupOfBrain,
  setupResultLine,
  sortedResults,
  takers,
} from "../src/lib/agent-setup";

/** Says the key and what it was given, so each line shows which words it picked. */
const t = ((key: string, o?: Record<string, unknown>) =>
  o && Object.keys(o).length ? `${key} ${JSON.stringify(o)}` : key) as unknown as TFunction;
const W = "agentPage.work.brain.copy";

describe("Usar em outros agentes", () => {
  const results: AgentSetupResult[] = [
    { agentId: "a", status: "skipped", reason: "not_allowed" },
    { agentId: "b", status: "same" },
    { agentId: "c", status: "applied" },
    { agentId: "d", status: "applied", keeps: { account: "GLM Coding" } },
  ];

  test("who can take it first, then who already thinks so, then who can't; Todos picks who can", () => {
    expect(sortedResults(results).map((r) => r.agentId)).toEqual(["c", "d", "b", "a"]);
    expect(takers(results)).toEqual(["c", "d"]);
  });

  test("each line says what changes, what it keeps or why not, with whose it is", () => {
    const line = (r: AgentSetupResult, owner?: string) => setupResultLine(t, r, { now: "Automático", owner });
    expect(line({ agentId: "c", status: "applied" })).toBe(`${W}.now {"brain":"Automático"}`);
    expect(line({ agentId: "d", status: "applied", keeps: { account: "GLM Coding" } })).toBe(
      `${W}.keeps {"account":"GLM Coding"}`,
    );
    expect(line({ agentId: "d", status: "applied", keeps: { account: null } })).toBe(`${W}.keepsOwn`);
    expect(line({ agentId: "b", status: "same" })).toBe(`${W}.same`);
    expect(line({ agentId: "a", status: "skipped", reason: "not_allowed" }, "Ana")).toBe(
      `${W}.reasons.not_allowed {"owner":"Ana"}`,
    );
    expect(line({ agentId: "a", status: "skipped", reason: "not_allowed" })).toBe(`${W}.reasons.not_allowedNobody`);
    // The account's owner by first name; none: the caller's own account.
    expect(line({ agentId: "a", status: "skipped", reason: "account_owner", params: { owner: "Ana Souza" } })).toBe(
      `${W}.reasons.account_ownerOf {"owner":"Ana"}`,
    );
    expect(line({ agentId: "a", status: "skipped", reason: "account_owner" })).toBe(`${W}.reasons.account_owner`);
    expect(line({ agentId: "a", status: "skipped", reason: "other_computer", params: { computer: "PC" } })).toBe(
      `${W}.reasons.other_computer {"computer":"PC"}`,
    );
    expect(line({ agentId: "a", status: "skipped", reason: "other_computer" })).toBe(`${W}.reasons.other_computerNone`);
    expect(
      line({ agentId: "a", status: "skipped", reason: "model_missing", params: { plan: "GLM Coding", model: "Opus" } }),
    ).toBe(`${W}.reasons.model_missing {"plan":"GLM Coding","model":"Opus"}`);
    expect(line({ agentId: "a", status: "skipped" })).toBe(`${W}.reasons.failed`);
  });

  test("on the phone the setup is the agent's saved one, on a computer only", () => {
    const view = {
      brain: "claude_code",
      model: "opus",
      effort: "high",
      contextTokens: 400_000,
      fallback: false,
      onlyOwner: true,
      account: "acc",
      computer: { machineId: "m1", name: "MacBook", online: true },
    } as AgentBrain;
    expect(setupOfBrain(view)).toEqual({
      brain: "claude_code",
      machineId: "m1",
      account: "acc",
      model: "opus",
      effort: "high",
      contextTokens: 400_000,
      fallback: false,
      onlyOwner: true,
    });
    expect(setupOfBrain({ ...view, brain: "model" })).toBeNull();
    expect(setupOfBrain({ ...view, computer: null })).toBeNull();
  });
});

describe("a new agent starts with the last setup", () => {
  const plan: NewAgentSetup = {
    brain: "claude_code",
    model: "opus",
    key: null,
    contextTokens: null,
    computer: { machineId: "m1", name: "MacBook" },
    account: { id: "acc", label: "Claude", provider: null, mine: true, free: true },
    ownSignIn: false,
    effort: "high",
    fallback: true,
  };

  test("the API's model and key as they are", () => {
    expect(newAgentStart({ brain: "model", model: "claude-opus-5-5", key: "k", contextTokens: null }, false)).toEqual({
      brain: "model",
      model: "claude-opus-5-5",
      key: "k",
    });
    expect(newAgentStart(null, true)).toBeNull();
  });

  test("a plan only for an agent of the person's own, on their account with room or their computer's sign-in", () => {
    expect(newAgentStart(plan, true)).toEqual({
      brain: "claude_code",
      machineId: "m1",
      computer: "MacBook",
      account: { id: "acc", label: "Claude" },
      input: {
        brain: "claude_code",
        account: "acc",
        model: "opus",
        effort: "high",
        contextTokens: null,
        fallback: true,
      },
    });
    expect(newAgentStart(plan, false)).toBeNull();
    const theirs = { ...plan, account: { id: "acc", label: "Claude", provider: null, mine: false, free: true } };
    expect(newAgentStart(theirs, true)).toBeNull();
    const taken = { ...plan, account: { id: "acc", label: "Claude", provider: null, mine: true, free: false } };
    expect(newAgentStart(taken, true)).toBeNull();
    expect(newAgentStart({ ...plan, account: null, ownSignIn: false }, true)).toBeNull();
    expect(newAgentStart({ ...plan, account: null, ownSignIn: true }, true)).toMatchObject({
      account: null,
      input: { account: null },
    });
  });

  test("said as it starts: the API's model by its label, a coding plan's by the plan's own", () => {
    const models = [{ id: "claude-opus-5-5", label: "Claude Opus 5.5" }] as Model[];
    const say = (start: Parameters<typeof newAgentStartText>[2], provider?: string) =>
      newAgentStartText(t, "pt-BR", start, { models, machines: [], provider });
    expect(say({ brain: "model", model: "claude-opus-5-5", key: null })).toBe("Claude Opus 5.5");
    expect(say({ brain: "model", model: "auto", key: null })).toBe("brain.auto.label");
    const glm = {
      brain: "claude_code" as const,
      machineId: "m1",
      computer: "MacBook",
      account: { id: "acc", label: "GLM Coding" },
      input: { brain: "claude_code" as const, model: "sonnet", effort: "medium" as const },
    };
    expect(say(glm, "zai")).toBe("brain.card.claude_code · GLM-5.3");
  });
});
