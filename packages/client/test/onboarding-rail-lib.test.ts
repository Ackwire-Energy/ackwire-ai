import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { AiStatus, OrgStanding } from "../src/api/types";
import { teamThinks } from "../src/lib/no-ai";
import { firstJob, landingOf, railState, railStepAt, railSteps } from "../src/lib/onboarding";
import { aboutContext, aboutOf, templateFor } from "../src/lib/team-plan";

describe("the onboarding's rail (ADR 0162)", () => {
  test("the plan step for a first plan, the AI step on the web's rail, no business step when personal", () => {
    expect(railSteps({ plan: true, ai: false, personal: false })).toEqual(["name", "business", "team", "plan"]);
    expect(railSteps({ plan: false, ai: false, personal: false })).toEqual(["name", "business", "team"]);
    expect(railSteps({ plan: true, ai: true, personal: false })).toEqual(["name", "business", "team", "plan", "ai"]);
    expect(railSteps({ plan: false, ai: true, personal: false })).toEqual(["name", "business", "team", "ai"]);
    expect(railSteps({ plan: true, ai: true, personal: true })).toEqual(["name", "team", "plan", "ai"]);
    expect(railSteps({ plan: false, ai: true, personal: true })).toEqual(["name", "team", "ai"]);
  });

  test("the step comes from the workspace's own data, so a workspace left at any step resumes there", () => {
    const at = (f: Partial<Parameters<typeof railStepAt>[0]>) =>
      railStepAt({
        created: true,
        context: true,
        team: true,
        waitsForPlan: false,
        personal: false,
        ai: false,
        thinks: false,
        ...f,
      });
    expect(at({ created: false, context: false, team: false })).toBe("name");
    expect(at({ context: false, team: false })).toBe("business");
    expect(at({ team: false })).toBe("team");
    expect(at({ waitsForPlan: true })).toBe("plan");
    expect(at({})).toBe("open");
    // A context saved some other way still counts: the team is next.
    expect(at({ team: false, waitsForPlan: true })).toBe("team");
    // With the AI step: it comes after the plan, and a team that already thinks opens.
    expect(at({ ai: true })).toBe("ai");
    expect(at({ ai: true, waitsForPlan: true })).toBe("plan");
    expect(at({ ai: true, thinks: true })).toBe("open");
    // A personal workspace is never asked what it does.
    expect(at({ personal: true, context: false, team: false })).toBe("team");
  });

  test("where it stands, web and phone: the data's step, a step gone back to while it stays answered", () => {
    const base = {
      orgId: "o1",
      standing: undefined,
      billingUrl: null,
      context: "",
      team: 0,
      picked: null,
      funnel: null,
    };
    // Before the workspace exists only the server's billing says whether a plan step comes.
    expect(railState({ ...base, orgId: null, billingUrl: "https://billing.example.com" })).toMatchObject({
      steps: ["name", "business", "team", "plan"],
      step: "name",
      reached: 0,
    });
    expect(railState({ ...base, orgId: null }).steps).toEqual(["name", "business", "team"]);
    const held = { ...base, standing: { state: "hold", reason: "payment" } as OrgStanding };
    expect(railState(held)).toMatchObject({ at: "business", step: "business", index: 1, reached: 1 });
    expect(railState({ ...held, context: "  ", team: 3 }).step).toBe("business");
    expect(railState({ ...held, context: "Loja online", team: 3 })).toMatchObject({
      at: "plan",
      step: "plan",
      index: 3,
    });
    expect(railState({ ...held, context: "Loja online", team: 3, picked: "name" })).toMatchObject({
      step: "name",
      index: 0,
      reached: 3,
    });
    // Only an answered step can be gone back to.
    expect(railState({ ...held, picked: "team" }).step).toBe("business");
    // No plan to wait for (a self-hosted server, or paid meanwhile): three steps, and it opens once the team is there.
    expect(railState({ ...base, context: "Agência", team: 2 })).toMatchObject({ at: "open", step: "team", reached: 3 });
    expect(railState({ ...base, context: "Agência", team: 2, picked: "plan" }).step).toBe("team");
    // The phone's personal workspace opens once made, whatever its data (ADR 0159).
    expect(railState({ ...base, personal: true }).at).toBe("open");
  });

  test("the web's funnel (ADR 0162, amended 2026-11-10): the AI step last, answered by the data", () => {
    const funnel = { thinks: false, passed: "context" as const };
    const base = {
      orgId: "o1",
      standing: undefined,
      billingUrl: null,
      context: "Loja online",
      team: 3,
      picked: null,
      funnel,
    };
    const payment = { state: "hold", reason: "payment" } as OrgStanding;
    // A team made with no AI: the AI step; once every agent thinks, it opens.
    expect(railState(base)).toMatchObject({ steps: ["name", "business", "team", "ai"], at: "ai", step: "ai" });
    expect(railState({ ...base, funnel: { ...funnel, thinks: true } })).toMatchObject({ at: "open", step: "ai" });
    // Not known yet reads as not yet: the page waits for it before showing a step.
    expect(railState({ ...base, funnel: { ...funnel, thinks: undefined } }).at).toBe("ai");
    // Waiting for its first plan: the plan step, then the AI step.
    expect(railState({ ...base, standing: payment })).toMatchObject({
      steps: ["name", "business", "team", "plan", "ai"],
      at: "plan",
      waitsForPlan: true,
      hasPlanStep: true,
    });
    // Paid once the plan step was shown ("computer" saved): it stays on the rail, answered, and may be gone back to.
    const paid = { ...base, funnel: { ...funnel, passed: "computer" as const } };
    expect(railState(paid)).toMatchObject({
      steps: ["name", "business", "team", "plan", "ai"],
      at: "ai",
      reached: 4,
      waitsForPlan: false,
      hasPlanStep: true,
    });
    expect(railState({ ...paid, picked: "plan" })).toMatchObject({ step: "plan", index: 3 });
    // A server with billing that never held the workspace: no plan step, once the workspace exists.
    expect(railState({ ...base, billingUrl: "https://billing.example.com" })).toMatchObject({
      steps: ["name", "business", "team", "ai"],
      hasPlanStep: false,
    });
    // A step gone back to is shown only while it stays answered: the AI step isn't, the plan step on a hold isn't.
    expect(railState({ ...base, standing: payment, picked: "ai" }).step).toBe("plan");
    expect(railState({ ...base, picked: "plan" }).step).toBe("ai");
    // "No agents yet" saved in a team's workspace doesn't answer its team step: its templates still make the team.
    expect(railState({ ...base, team: 0, funnel: { ...funnel, passed: "agents" } }).at).toBe("team");
  });

  test("the AI step's answer: every agent thinks, read only from a status that lists them all", () => {
    const status = (states: Record<string, AiStatus["agents"][number]["state"]>): AiStatus => ({
      any: Object.values(states).some((s) => s !== "no_ai"),
      agents: Object.entries(states).map(([agentId, state]) => ({ agentId, state })),
    });
    // Waiting for its computer still thinks.
    expect(teamThinks(["lodi", "nina"], status({ lodi: "ready", nina: "waiting" }))).toBe(true);
    expect(teamThinks(["lodi", "nina"], status({ lodi: "ready", nina: "no_ai" }))).toBe(false);
    // Not read yet, or read before an agent was made: no answer, so the page waits for a fresh read.
    expect(teamThinks(["lodi"], undefined)).toBeUndefined();
    expect(teamThinks(["lodi", "nina"], status({ lodi: "ready" }))).toBeUndefined();
    expect(teamThinks([], status({}))).toBe(false);
  });

  test("a personal workspace walks the same funnel with no business step (ADR 0159)", () => {
    const funnel = { thinks: false, passed: "context" as const };
    const base = {
      orgId: "o1",
      standing: undefined,
      billingUrl: null,
      context: "",
      team: 0,
      picked: null,
      personal: true,
      funnel,
    };
    // Before it exists, "For me" already shows its path; self-hosted 3 steps, agentes.chat Cloud 4.
    expect(railState({ ...base, orgId: null }).steps).toEqual(["name", "team", "ai"]);
    expect(railState({ ...base, orgId: null, billingUrl: "https://billing.example.com" })).toMatchObject({
      steps: ["name", "team", "plan", "ai"],
      at: "name",
    });
    // Made, with no context and no agents: the team step's question, never "what it does".
    expect(railState(base)).toMatchObject({ steps: ["name", "team", "ai"], at: "team", step: "team", reached: 1 });
    // Agents brought in, or "no agents yet" saved ("agents"), answer it.
    expect(railState({ ...base, team: 2 }).at).toBe("ai");
    expect(railState({ ...base, funnel: { ...funnel, passed: "agents" } }).at).toBe("ai");
    expect(railState({ ...base, funnel: { thinks: true, passed: "agents" } }).at).toBe("open");
    // On a hold for its first plan: the plan step after the team's.
    const held = { ...base, standing: { state: "hold", reason: "payment" } as OrgStanding };
    expect(railState({ ...held, funnel: { ...funnel, passed: "agents" } })).toMatchObject({
      steps: ["name", "team", "plan", "ai"],
      at: "plan",
      index: 2,
    });
  });

  test("the plan step says what each agent does first: its first routine, else its role", () => {
    const iara = { id: "a1", role: "Atendimento" };
    expect(firstJob(iara, [{ agentId: "a2", name: "Posts da semana" }])).toBe("Atendimento");
    expect(firstJob(iara, [{ agentId: "a1", name: "Resumir o que ficou sem resposta" }])).toBe(
      "Resumir o que ficou sem resposta",
    );
    expect(firstJob(iara)).toBe("Atendimento");
  });

  test("step 2's type and sentence are saved together and read back, on any device", () => {
    const words: Record<string, string> = {
      "teamPlan.business.store": "Loja online",
      "teamPlan.business.clinic": "Clínica ou consultório",
    };
    const t = ((key: string) => words[key] ?? key) as TFunction;
    expect(aboutContext(t, "clinic", " Atendemos com hora marcada ")).toBe(
      "Clínica ou consultório · Atendemos com hora marcada",
    );
    expect(aboutContext(t, "store", "")).toBe("Loja online");
    expect(aboutContext(t, "other", "Roupas sob medida")).toBe("Roupas sob medida");
    expect(aboutContext(t, null, "")).toBe("");
    expect(aboutOf(t, "Clínica ou consultório · Atendemos com hora marcada")).toEqual({
      business: "clinic",
      line: "Atendemos com hora marcada",
    });
    expect(aboutOf(t, "Loja online")).toEqual({ business: "store", line: "" });
    // A sentence alone (Outra coisa, or written in Configurações): no type, the whole sentence.
    expect(aboutOf(t, "Lojas online de roupas")).toEqual({ business: null, line: "Lojas online de roupas" });
  });

  test("the team step's template: the one picked, else the business's, else the first", () => {
    const list = [{ id: "agency" }, { id: "store" }];
    expect(templateFor(list, null, "store")?.id).toBe("store");
    expect(templateFor(list, "agency", "store")?.id).toBe("agency");
    expect(templateFor(list, null, "other")?.id).toBe("agency");
    expect(templateFor(list, null, null)?.id).toBe("agency");
    expect(templateFor([], null, "store")).toBeUndefined();
  });

  test("where it opens: #general once paid or done, its right hand's DM when the plan was left", () => {
    expect(landingOf("paid")).toBe("general");
    expect(landingOf("done")).toBe("general");
    expect(landingOf("skipped")).toBe("rightHand");
  });
});
