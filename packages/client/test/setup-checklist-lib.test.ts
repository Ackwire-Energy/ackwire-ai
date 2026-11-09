import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AgentSetupChecklist } from "../src/api/types";
import {
  askedLine,
  beatRow,
  FIRST_RUN_STEPS,
  type FirstRunFacts,
  type FirstRunPowers,
  firstRunAiLabel,
  firstRunAppList,
  firstRunApps,
  firstRunAsks,
  firstRunBeats,
  firstRunDone,
  firstRunRow,
  firstRunRowState,
  firstRunSteps,
  nextStep,
  type SetupRowFacts,
  setupDone,
  setupRole,
  setupRow,
  setupSteps,
  setupTaskKeys,
  suggestedChannels,
  suggestedLevels,
  teamRole,
} from "../src/lib/setup-checklist";

// A new agent's setup checklist (ADR 0155 §2): who sees which steps, what counts as done, what it suggests.

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
    // The sentence that says it back closes it: no ".." at its end.
    expect(askedLine("Responde dúvidas sobre os planos.")).toBe("Responde dúvidas sobre os planos");
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

describe("the right hand's first run (ADR 0155 §6, ADR 0158)", () => {
  const lodi = (setup: AgentSetupChecklist | null = { role: null, done: [] }) => ({
    setup,
    builtin: "right_hand" as const,
  });
  const owner: FirstRunPowers = { owner: true, connectAi: true, pay: true, connectors: true, invite: true };
  const none: FirstRunFacts = { ai: false, apps: false, people: false };

  test("what the onboarding leaves, one order everywhere, for the owners, each row by what they may do", () => {
    expect(FIRST_RUN_STEPS).toEqual(["ai", "apps", "people"]);
    expect(firstRunSteps(lodi(), owner)).toEqual(["ai", "apps", "people"]);
    expect(firstRunSteps(lodi(), { ...owner, connectors: false, invite: false })).toEqual(["ai"]);
    // An invited person sees none of it, nor anyone once the right hand has no checklist; nor on another agent.
    expect(firstRunSteps(lodi(), { ...owner, owner: false })).toEqual([]);
    expect(firstRunSteps(lodi(null), owner)).toEqual([]);
    expect(firstRunSteps({ setup: { role: null, done: [] }, builtin: null }, owner)).toEqual([]);
  });

  test("each row reads done from its data; only a skip of apps or people is stored", () => {
    const setup = { role: null, done: [] };
    expect([...firstRunDone(setup, none)]).toEqual([]);
    expect([...firstRunDone(setup, { ai: true, apps: true, people: true })]).toEqual(["ai", "apps", "people"]);
    expect([...firstRunDone({ role: null, done: ["apps", "people"] }, none)]).toEqual(["apps", "people"]);
    // A stored step of a new agent's checklist ticks nothing here.
    expect([...firstRunDone({ role: null, done: ["ai", "who"] }, none)]).toEqual([]);
  });

  test("on a hold every row waits for the plan, a skipped one stays done, and no ask shows", () => {
    const done = firstRunDone({ role: null, done: ["apps"] }, none);
    const state = (s: Parameters<typeof firstRunRowState>[0], held: boolean) => firstRunRowState(s, { done, held });
    expect(FIRST_RUN_STEPS.map((s) => state(s, true))).toEqual(["afterPlan", "done", "afterPlan"]);
    expect(FIRST_RUN_STEPS.map((s) => state(s, false))).toEqual(["open", "done", "open"]);
    const thinks = new Set([...done, "ai" as const]);
    expect(firstRunAsks(thinks, true, true)).toBe(false);
    expect(firstRunAsks(thinks, false, true)).toBe(true);
    // The asks are for a team: none before there is one.
    expect(firstRunAsks(thinks, false, false)).toBe(false);
    expect(firstRunAsks(done, false, true)).toBe(false);
  });

  test("its words: open rows ask, done rows say what is there, apps and people may be skipped", () => {
    const t = ((key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key)) as TFunction;
    const f = { org: "Acme", label: "Claude", apps: "Gmail", members: 1, invited: null };
    expect(firstRunRow(t, "apps", "open", f, false)).toEqual({
      title: 'agentSetup.firstRun.apps.todo {"org":"Acme"}',
      desc: 'agentSetup.firstRun.apps.todoDesc {"org":"Acme"}',
      action: "agentSetup.firstRun.apps.action",
      skip: "agentSetup.firstRun.notNow",
    });
    expect(firstRunRow(t, "ai", "done", f, false).title).toBe('agentSetup.firstRun.ai.done {"label":"Claude"}');
    expect(firstRunRow(t, "ai", "done", { ...f, label: null }, false).title).toBe("agentSetup.firstRun.ai.doneAny");
    expect(firstRunRow(t, "people", "done", f, true).title).toBe("agentSetup.firstRun.people.doneNone");
    expect(firstRunRow(t, "ai", "afterPlan", f, false)).toEqual({
      title: 'agentSetup.firstRun.ai.todo {"org":"Acme"}',
      desc: "agentSetup.firstRun.afterPlan",
      action: "",
    });
  });

  test("the AI it names: a plan's line, else its API's maker, the workspace key's on Automático", () => {
    expect(firstRunAiLabel({ text: "Sonnet pelo plano do Claude", kind: "claude_code" }, "anthropic")).toBe(
      "Sonnet pelo plano do Claude",
    );
    expect(firstRunAiLabel({ text: "Automático", kind: "agent" }, "anthropic")).toBe("Claude");
    expect(firstRunAiLabel({ text: "Automático", kind: "agent" }, undefined)).toBeNull();
  });

  test("an invitation waiting for its answer finishes the people row, by who was invited", () => {
    const t = ((key: string, o?: Record<string, unknown>) => (o ? `${key} ${JSON.stringify(o)}` : key)) as TFunction;
    expect([...firstRunDone({ role: null, done: [] }, { ...none, people: true })]).toEqual(["people"]);
    const f = { org: "Acme", label: null, apps: null, members: 1, invited: "joao.lima@example.com" };
    expect(firstRunRow(t, "people", "done", f, false).title).toBe(
      'agentSetup.firstRun.people.invited {"names":"joao.lima@example.com"}',
    );
    // Once someone joined, how many people are here.
    expect(firstRunRow(t, "people", "done", { ...f, members: 2 }, false).title).toBe(
      'agentSetup.firstRun.people.done {"count":2}',
    );
  });

  test("an invitation only sent is a beat of its own, so the right hand says it went out; someone joining is the one it celebrates", () => {
    expect(firstRunBeats(["ai", "people"], { members: 1, invited: 1 })).toEqual(["ai", "invited"]);
    // The same row turns `people` as the invitee joins: a beat of its own, so it has its line then.
    expect(firstRunBeats(["ai", "people"], { members: 2, invited: 0 })).toEqual(["ai", "people"]);
    // Skipped with nobody invited: `people`, which says nothing (the card's rule for a skip).
    expect(firstRunBeats(["people"], { members: 1, invited: 0 })).toEqual(["people"]);
    expect(beatRow("invited")).toBe("people");
    expect(beatRow("apps")).toBe("apps");
  });

  test("the apps a team made from a template would use, the most suggested first", () => {
    const a = (handle: string) => ({ handle, setup: null });
    expect(teamRole(a("iara-2"))).toBe("support");
    expect(teamRole({ handle: "zed", setup: { role: "dev", done: [] } })).toBe("dev");
    expect(teamRole(a("zed"))).toBeNull();
    expect(firstRunApps([a("iara"), a("bia")]).slice(0, 1)).toEqual(["intercom"]);
    expect(firstRunApps([a("zed")])).toEqual([]);
  });

  test("the apps row lists the apps that connect in one click here, not connected yet, the team's first", () => {
    const def = (
      id: string,
      more: Partial<{
        auth: ("oauth" | "api_key")[];
        oauthConfigured: boolean;
        available: boolean;
        soon: boolean;
      }> = {},
    ) => ({
      id,
      auth: ["oauth" as const],
      oauthConfigured: true,
      available: true,
      ...more,
    });
    const defs = [
      def("gmail"),
      def("intercom"),
      def("apikey", { auth: ["api_key"] }),
      def("off", { oauthConfigured: false }),
      def("later", { available: false }),
      def("vendor", { soon: true }),
      def("notion"),
    ];
    const list = firstRunAppList(defs, new Set(["notion"]), [{ handle: "iara", setup: null }]);
    expect(list.map((x) => [x.def.id, x.suggested])).toEqual([
      ["intercom", true],
      ["gmail", false],
    ]);
    expect(
      firstRunAppList(
        Array.from({ length: 9 }, (_, i) => def(`app${i}`)),
        new Set(),
        [],
      ),
    ).toHaveLength(6);
  });
});
