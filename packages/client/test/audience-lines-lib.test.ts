import { describe, expect, test } from "bun:test";
import type { Agent, OrgRole, OrgSummary } from "../src/api/types";
import { audienceBlocked, audienceLines, audiencePatch, audienceWithMe } from "../src/lib/audience";
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
  test("on someone else's plan only its owner lets more people in", () => {
    const onPlan = { ...kept, brain: { kind: "claude_code" } as Agent["brain"] };
    expect(audienceWithMe(admin, onPlan, "u-caio")).toBeNull();
  });
});
