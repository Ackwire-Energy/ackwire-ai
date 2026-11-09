import { describe, expect, test } from "bun:test";
import type { OrgStanding } from "../src/api/types";
import { firstJob, landingOf, planStepShows, railState, railStepAt, railSteps } from "../src/lib/onboarding";
import { templateFor } from "../src/lib/team-plan";

describe("the onboarding's rail (ADR 0158)", () => {
  test("four steps where the workspace waits for its first plan, three anywhere else (a self-hosted server)", () => {
    expect(railSteps(true)).toEqual(["name", "business", "team", "plan"]);
    expect(railSteps(false)).toEqual(["name", "business", "team"]);
  });

  test("the step comes from the workspace's own data, so a workspace left at any step resumes there", () => {
    const at = (f: Partial<Parameters<typeof railStepAt>[0]>) =>
      railStepAt({ created: true, context: true, team: true, waitsForPlan: false, ...f });
    expect(at({ created: false, context: false, team: false })).toBe("name");
    expect(at({ context: false, team: false })).toBe("business");
    expect(at({ team: false })).toBe("team");
    expect(at({ waitsForPlan: true })).toBe("plan");
    expect(at({})).toBe("open");
    // A context saved some other way still counts: the team is next.
    expect(at({ team: false, waitsForPlan: true })).toBe("team");
  });

  test("where it stands, web and phone: the data's step, a step gone back to while it stays answered", () => {
    const base = { orgId: "o1", standing: undefined, billingUrl: null, context: "", team: 0, picked: null };
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
  });

  test("the plan step says what each agent does first: its first routine, else its role", () => {
    const iara = { id: "a1", role: "Atendimento" };
    expect(firstJob(iara, [{ agentId: "a2", name: "Posts da semana" }])).toBe("Atendimento");
    expect(firstJob(iara, [{ agentId: "a1", name: "Resumir o que ficou sem resposta" }])).toBe(
      "Resumir o que ficou sem resposta",
    );
    expect(firstJob(iara)).toBe("Atendimento");
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

  test("the phone's plan step shows no price and no way to pay, the web's a price only when the billing says one", () => {
    expect(planStepShows("phone", { price: "$49" })).toEqual({ price: false, billing: false });
    expect(planStepShows("web", { price: "$49" })).toEqual({ price: true, billing: true });
    expect(planStepShows("web", {})).toEqual({ price: false, billing: true });
    expect(planStepShows("web", null)).toEqual({ price: false, billing: true });
  });
});
