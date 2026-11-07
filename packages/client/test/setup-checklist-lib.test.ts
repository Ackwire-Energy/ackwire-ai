import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AgentSetupChecklist } from "../src/api/types";
import {
  askedLine,
  nextStep,
  type SetupRowFacts,
  setupDone,
  setupRole,
  setupRow,
  setupSteps,
  setupTaskKeys,
  suggestedChannels,
  suggestedLevels,
} from "../src/lib/setup-checklist";

// A new agent's setup checklist (ADR 0152 §2): who sees which steps, what counts as done, what it suggests.

const fresh = (role: string | null = "support"): AgentSetupChecklist => ({ role, done: [] });
const agent = (setup: AgentSetupChecklist | null, ownerUserId: string | null = "u_owner") => ({
  setup,
  ownerUserId,
  builtin: null,
});

describe("setup checklist", () => {
  test("who manages agents sees every step; its owner the ones they may change; anyone else none", () => {
    expect(setupSteps(agent(fresh()), { meId: "u_admin", admin: true })).toEqual(["ai", "apps", "where", "who", "how"]);
    expect(setupSteps(agent(fresh()), { meId: "u_owner", admin: false })).toEqual(["ai", "where", "who"]);
    expect(setupSteps(agent(fresh()), { meId: "u_other", admin: false })).toEqual([]);
  });

  test("an agent made before it, or the right hand, has none", () => {
    expect(setupSteps(agent(null), { meId: "u_admin", admin: true })).toEqual([]);
    expect(setupSteps({ ...agent(fresh()), builtin: "right_hand" }, { meId: "u_admin", admin: true })).toEqual([]);
  });

  test("a step is done when confirmed or when its data says so; the next is the first not done", () => {
    const done = setupDone({ role: null, done: ["who"] }, { ai: true, apps: false, where: true });
    expect([...done].sort()).toEqual(["ai", "where", "who"]);
    expect(nextStep(["ai", "apps", "where", "who", "how"], done)).toBe("apps");
    expect(nextStep(["ai", "where", "who"], done)).toBeNull();
  });

  test("the role's suggestions: its apps, its channels by name, else #general", () => {
    expect(setupRole(fresh("support"))).toBe("support");
    expect(setupRole(fresh("not-a-role"))).toBeNull();
    expect(suggestedLevels("support")).toMatchObject({ intercom: "write" });
    expect(suggestedLevels(null)).toEqual({});
    const channels = [
      { id: "c1", name: "general" },
      { id: "c2", name: "Suporte" },
    ];
    expect(suggestedChannels("support", channels)).toEqual(["c2"]);
    expect(suggestedChannels("dev", channels)).toEqual(["c1"]);
    expect(suggestedChannels(null, [{ id: "c3", name: "random" }])).toEqual([]);
  });

  test("what an agent from scratch was asked is said back only when it is one short line", () => {
    expect(askedLine("  Responde dúvidas sobre os planos ")).toBe("Responde dúvidas sobre os planos");
    expect(askedLine("one\ntwo")).toBeNull();
    expect(askedLine("")).toBeNull();
  });

  test("its first tasks: a ready-made role's three, a blank agent's own two", () => {
    expect(setupTaskKeys("support")).toEqual([
      "newAgent.roles.support.tasks.a",
      "newAgent.roles.support.tasks.b",
      "newAgent.roles.support.tasks.c",
    ]);
    expect(setupTaskKeys(null)).toEqual(["agentSetup.tasks.a", "agentSetup.tasks.b"]);
  });

  test("a row's words, the same on the web and the phone: the suggestion while left, what it has once done", () => {
    // The key and its values, so each case shows which sentence it picked.
    const t = ((key: string, o?: Record<string, unknown>) =>
      o ? `${key} ${JSON.stringify(o)}` : key) as never as TFunction;
    const facts: SetupRowFacts = {
      org: "Acme",
      role: "support",
      granted: null,
      suggested: "o Intercom",
      channels: null,
      firstChannel: "#suporte",
      audience: "everyone",
      otherOwner: null,
      onPlan: false,
    };
    expect(setupRow(t, "ai", false, facts)).toEqual({
      title: "agentSetup.ai.todo",
      desc: "agentSetup.ai.todoDesc",
      action: "agentSetup.ai.action",
    });
    expect(setupRow(t, "apps", false, facts).title).toBe('agentSetup.apps.todo {"apps":"o Intercom"}');
    expect(setupRow(t, "apps", true, facts).title).toBe("agentSetup.apps.doneNone");
    expect(setupRow(t, "apps", false, { ...facts, suggested: null }).action).toBe("agentSetup.choose");
    expect(setupRow(t, "where", false, facts).title).toBe('agentSetup.where.todo {"channel":"#suporte"}');
    expect(setupRow(t, "where", true, { ...facts, channels: "#suporte" }).title).toBe(
      'agentSetup.where.done {"channels":"#suporte"}',
    );
    expect(setupRow(t, "who", false, { ...facts, onPlan: true }).title).toBe("agentSetup.who.todoPlan");
    expect(setupRow(t, "who", true, { ...facts, audience: "owner", otherOwner: "Ana" }).title).toBe(
      'agentSetup.who.doneOwner {"name":"Ana"}',
    );
    expect(setupRow(t, "who", true, { ...facts, audience: "owner" }).title).toBe("agentSetup.who.doneYou");
    expect(setupRow(t, "how", false, { ...facts, role: null }).desc).toBe("agentSetup.how.todoDescBlank");
    expect(setupRow(t, "how", true, facts)).toEqual({ title: "agentSetup.how.done", action: "agentSetup.see" });
  });
});
