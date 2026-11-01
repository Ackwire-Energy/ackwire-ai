import { describe, expect, test } from "bun:test";
import type { Agent } from "../src/api/types";
import { reachByAccess, reachOf, routineReachWarnings } from "../src/lib/reach";

const agent = (id: string, handle: string, extra: Partial<Agent> = {}) => ({ id, handle, ...extra }) as Agent;
const gil = agent("a-gil", "gil", { canTalk: false, audience: { mode: "owner", userIds: [] } });
const ada = agent("a-ada", "ada", { canTalk: true, audience: { mode: "everyone", userIds: [] } });
const dev = agent("a-dev", "dev", { canTalk: false });

describe("routineReachWarnings", () => {
  test("set to act: the agents its creator can't talk to, never its own agent, nor an email", () => {
    const out = routineReachWarnings("Cobre o @gil e a @ada; avise gil@x.com e @dev", [gil, ada, dev], {
      access: "act",
      agentId: dev.id,
    });
    expect(out.map((w) => [w.agent.id, w.kind])).toEqual([["a-gil", "blocked"]]);
  });

  test("set to only look and tell: every agent not open to everyone", () => {
    const out = routineReachWarnings("@GIL e @ada", [gil, ada], { access: "read", agentId: null });
    expect(out.map((w) => [w.agent.id, w.kind])).toEqual([["a-gil", "read"]]);
  });
});

describe("reachOf", () => {
  test("keeps well formed entries only", () => {
    const entries = reachOf({
      reach: [{ agentId: "a", handle: "ivo", reason: "not_in_channel", consultationId: "c" }, { agentId: 1 }, null],
    });
    expect(entries.map((e) => e.handle)).toEqual(["ivo"]);
    expect(reachOf({})).toEqual([]);
  });

  test("a routine that only looks keeps the agent out by its access", () => {
    const base = { agentId: "a", handle: "gil", reason: "routine_creator_reach" as const };
    expect(reachByAccess({ ...base, routine: { id: "r", name: "R", creatorUserId: "u", access: "read" } })).toBe(true);
    expect(reachByAccess({ ...base, routine: { id: "r", name: "R", creatorUserId: "u", access: "act" } })).toBe(false);
  });
});
