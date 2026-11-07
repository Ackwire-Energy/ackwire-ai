import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { Agent, AgentSetupResult, ForeignMailbox, OrgRole, OrgSummary } from "../src/api/types";
import {
  agentsReach,
  audienceLines,
  audiencePatch,
  audienceWithMe,
  opensDetails,
  opensOthersPlan,
  setupPlanOpens,
  setupPlanQuestion,
  widenQuestion,
} from "../src/lib/audience";
import { agentWorkingIn, type StreamsState } from "../src/realtime/streams";

const role = (id: string, position: number, kind: OrgRole["kind"] = "custom") =>
  ({ id, name: id, kind, position, color: "amber", icon: "shield" }) as OrgRole;
const roles = [role("suporte", 1), role("produto", 0), role("everyone", 9, "everyone")];
const members = [{ userId: "u-heitor" }, { userId: "u-caio" }, { userId: "u-bia" }];
const agent = (extra: Partial<Agent>) => ({ id: "a-ada", ownerUserId: "u-heitor", ...extra }) as Agent;
const shown = (lines: ReturnType<typeof audienceLines>) =>
  lines.map((l) => (l.kind === "person" ? l.person.userId : l.kind === "role" ? l.role.id : `all:${l.role?.id}`));

describe("audienceLines", () => {
  test("everyone: one line, with the everyone role's mark", () => {
    expect(shown(audienceLines(agent({ audience: { mode: "everyone", userIds: [] } }), roles, members))).toEqual([
      "all:everyone",
    ]);
    expect(shown(audienceLines(agent({}), roles, members))).toEqual(["all:everyone"]);
  });

  test("only its owner: the owner; none without one", () => {
    const owner = { mode: "owner" as const, userIds: [] };
    expect(shown(audienceLines(agent({ audience: owner }), roles, members))).toEqual(["u-heitor"]);
    expect(shown(audienceLines(agent({ audience: owner, ownerUserId: null }), roles, members))).toEqual([]);
  });

  test("some people: roles top first, then the people, never the owner, only who we know", () => {
    const audience = {
      mode: "people" as const,
      userIds: ["u-heitor", "u-caio", "u-gone"],
      roleIds: ["suporte", "produto"],
    };
    expect(shown(audienceLines(agent({ audience }), roles, members))).toEqual(["produto", "suporte", "u-caio"]);
  });
});

describe("audiencePatch", () => {
  test("people and roles only when it answers some people", () => {
    expect(audiencePatch({ mode: "owner", userIds: ["u-caio"], roleIds: ["suporte"] })).toEqual({
      mode: "owner",
      userIds: [],
      roleIds: [],
      consultable: true,
    });
    expect(audiencePatch({ mode: "people", userIds: ["u-caio"], consultable: false })).toEqual({
      mode: "people",
      userIds: ["u-caio"],
      roleIds: [],
      consultable: false,
    });
  });
});

describe("agentWorkingIn", () => {
  test("the channel of a run thinking or writing, none when idle", () => {
    const state = {
      runs: {
        r1: { agentId: "a-ada", channelId: "c-old", status: "done", text: "" },
        r2: { agentId: "a-ada", channelId: "c-launch", status: "running", text: "" },
      },
    } as unknown as StreamsState;
    expect(agentWorkingIn(state, "a-ada")).toBe("c-launch");
    expect(agentWorkingIn(state, "a-theo")).toBeNull();
  });
});

describe("audienceWithMe", () => {
  const admin = { permissions: ["manage_agents", "talk_to_agents"] } as unknown as OrgSummary;
  const member = { permissions: ["talk_to_agents"] } as unknown as OrgSummary;
  const kept = agent({ canTalk: false, audience: { mode: "people", userIds: [], roleIds: ["suporte"] } });
  test("an admin it keeps out lets themselves in, its roles kept; a member outside can't", () => {
    expect(audienceWithMe(admin, kept, "u-caio")).toEqual({
      mode: "people",
      userIds: ["u-caio"],
      roleIds: ["suporte"],
    });
    expect(audienceWithMe(member, kept, "u-bia")).toBeNull();
    expect(audienceWithMe(admin, { ...kept, canTalk: true }, "u-caio")).toBeNull();
  });
  test("on someone else's plan an admin lets themselves in too, asked first; its owner isn't asked", () => {
    const onPlan = { ...kept, brain: { kind: "claude_code", account: "Claude Max" } as Agent["brain"] };
    const next = audienceWithMe(admin, onPlan, "u-caio");
    expect(next).toEqual({ mode: "people", userIds: ["u-caio"], roleIds: ["suporte"] });
    expect(next && opensOthersPlan(onPlan, next, "u-caio")).toBe(true);
    expect(opensOthersPlan(onPlan, { mode: "everyone", userIds: [], roleIds: [] }, "u-heitor")).toBe(false);
    expect(opensOthersPlan(kept, { mode: "everyone", userIds: [], roleIds: [] }, "u-caio")).toBe(false);
    expect(audienceWithMe(member, onPlan, "u-bia")).toBeNull();
    // No plan of anyone's thinks for it there (OpenCode's free tier on a computer nobody connected): nothing to ask.
    const free = { ...kept, brain: { kind: "opencode", model: null } as Agent["brain"] };
    expect(opensOthersPlan(free, { mode: "everyone", userIds: [], roleIds: [] }, "u-caio")).toBe(false);
  });
});

describe("widenQuestion", () => {
  const t = ((key: string, o?: Record<string, string>) =>
    `${key}${o ? JSON.stringify(o) : ""}`) as unknown as TFunction;
  const ada = { name: "Ada", brain: { kind: "claude_code" } as Agent["brain"] };
  const box = { accountId: "m1", address: "w@x.test", ownerName: "Walter" } as ForeignMailbox;
  test("nothing to ask, the mailboxes alone, or the plan with the mailboxes in one question", () => {
    expect(widenQuestion(t, ada, null, [])).toBeNull();
    expect(widenQuestion(t, ada, null, [box])?.title).toBe("reach.mailLossTitle");
    const plan = widenQuestion(t, ada, "Walter", []);
    expect(plan?.title).toBe('reach.planTitle{"owner":"Walter"}');
    expect(plan?.description).toContain('"plan":"aiAccounts.connect.claude_code"');
    const glm = { name: "Ada", brain: { kind: "claude_code", provider: "zai" } as Agent["brain"] };
    expect(widenQuestion(t, glm, "Walter", [])?.description).toContain('"plan":"Z.ai"');
    expect(widenQuestion(t, ada, "Walter", [box])?.description).toMatch(
      /^common\.joinSentences.*reach\.planOpen.*reach\.mailLoss/,
    );
  });
});

describe("setupPlanQuestion (Usar em outros agentes)", () => {
  const t = ((key: string, o?: Record<string, unknown>) =>
    `${key}${o ? JSON.stringify(o) : ""}`) as unknown as TFunction;
  const claude = { kind: "claude_code" as const, provider: null };
  const agents = new Map([
    ["a-1", { name: "Ada", ownerUserId: "u-joao" }],
    ["a-2", { name: "Atlas", ownerUserId: "u-joao" }],
    ["a-3", { name: "Lia", ownerUserId: "u-bia" }],
    ["a-4", { name: "Theo", ownerUserId: "u-bia" }],
  ]);
  const names: Record<string, string> = { "u-joao": "João", "u-bia": "Bia" };
  const results: AgentSetupResult[] = [
    { agentId: "a-1", status: "applied", opensPlan: true },
    { agentId: "a-2", status: "applied", opensPlan: true },
    { agentId: "a-3", status: "applied", opensPlan: true },
    { agentId: "a-4", status: "applied" },
  ];
  const opens = (ids: string[]) =>
    setupPlanOpens(
      results,
      ids,
      (id) => agents.get(id),
      (id) => names[id] ?? "",
    );

  test("none picked on someone else's plan: nothing to ask", () => {
    expect(opens(["a-4"])).toEqual([]);
    expect(setupPlanQuestion(t, claude, opens(["a-4"]))).toBeNull();
  });

  test("one owner: their plan, their agents in one line", () => {
    const q = setupPlanQuestion(t, claude, opens(["a-1", "a-2", "a-4"]));
    expect(q?.title).toBe('reach.planTitle{"owner":"João"}');
    expect(q?.description).toBe(
      'reach.planOpen{"name":"format.list{\\"names\\":[\\"Ada\\",\\"Atlas\\"]}","owner":"João","plan":"aiAccounts.connect.claude_code"}',
    );
  });

  test("several owners: all of them in the title, one line each", () => {
    const q = setupPlanQuestion(t, claude, opens(["a-1", "a-3"]));
    expect(q?.title).toBe('reach.plansTitle{"owners":"format.list{\\"names\\":[\\"João\\",\\"Bia\\"]}"}');
    const lines = q?.description.split("\n") ?? [];
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"owner":"João"');
    expect(lines[1]).toContain('"owner":"Bia"');
  });
});

test("an agent's picture leads to its details unless it left the team or the viewer sees only its public card", () => {
  expect(opensDetails({})).toBe(true);
  expect(opensDetails({ seesDetails: true })).toBe(true);
  expect(opensDetails({ seesDetails: false })).toBe(false);
  expect(opensDetails({ former: "archived" })).toBe(false);
  expect(opensDetails(undefined)).toBe(false);
});

describe("agentsReach: whether a narrowed audience holds for agents too", () => {
  const owner = { mode: "owner" as const, userIds: [] };
  test("everyone talks to it: nothing to say", () => {
    expect(agentsReach({ mode: "everyone", userIds: [] }, true, "u-heitor")).toBeNull();
  });
  test("other agents still consult it unless switched off", () => {
    expect(agentsReach(owner, false, "u-heitor")).toBe("consulted");
    expect(agentsReach({ ...owner, consultable: false }, false, "u-heitor")).toBe("blocked");
    expect(agentsReach({ mode: "people", userIds: ["u-bia"] }, true, "u-heitor")).toBe("consulted");
  });
  test("on its owner's plan answering only its owner, nobody else, agents included", () => {
    expect(agentsReach(owner, true, "u-heitor")).toBe("plan");
    expect(agentsReach({ mode: "people", userIds: [] }, true, "u-heitor")).toBe("plan");
  });
});
