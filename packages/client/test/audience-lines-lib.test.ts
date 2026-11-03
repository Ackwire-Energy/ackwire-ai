import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import type { Agent, ForeignMailbox, OrgRole, OrgSummary } from "../src/api/types";
import { audienceLines, audiencePatch, audienceWithMe, opensOthersPlan, widenQuestion } from "../src/lib/audience";
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
    const onPlan = { ...kept, brain: { kind: "claude_code" } as Agent["brain"] };
    const next = audienceWithMe(admin, onPlan, "u-caio");
    expect(next).toEqual({ mode: "people", userIds: ["u-caio"], roleIds: ["suporte"] });
    expect(next && opensOthersPlan(onPlan, next, "u-caio")).toBe(true);
    expect(opensOthersPlan(onPlan, { mode: "everyone", userIds: [], roleIds: [] }, "u-heitor")).toBe(false);
    expect(opensOthersPlan(kept, { mode: "everyone", userIds: [], roleIds: [] }, "u-caio")).toBe(false);
    expect(audienceWithMe(member, onPlan, "u-bia")).toBeNull();
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
    expect(widenQuestion(t, ada, "Walter", [box])?.description).toMatch(
      /^common\.joinSentences.*reach\.planOpen.*reach\.mailLoss/,
    );
  });
});
