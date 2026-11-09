import { describe, expect, test } from "bun:test";
import { landingOf, planStepShows, railStepAt, railSteps } from "../src/lib/onboarding";

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
