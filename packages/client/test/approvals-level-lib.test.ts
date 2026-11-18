import { expect, test } from "bun:test";
import {
  APPROVALS_LEVELS,
  approvalsLevelOf,
  auditUnasked,
  changesWhenAsks,
  followsWorkspace,
  levelsBefore,
  ownApprovalsCount,
  shownApprovalsLevel,
} from "../src/lib/approvals-level";

test("an agent's level: its own, and risky from a server that doesn't say", () => {
  expect(APPROVALS_LEVELS).toEqual(["always", "risky", "never"]);
  expect(approvalsLevelOf({ approvalsLevel: "never" })).toBe("never");
  expect(approvalsLevelOf({})).toBe("risky");
  expect(approvalsLevelOf(undefined)).toBe("risky");
});

test("while a change is on its way the row shows what was asked for", () => {
  const agent = { approvalsLevel: "risky" as const };
  expect(shownApprovalsLevel(agent, { isPending: false, variables: { approvalsLevel: "never" } })).toBe("risky");
  expect(shownApprovalsLevel(agent, { isPending: true, variables: { approvalsLevel: "never" } })).toBe("never");
  // Another field of the agent is being saved: the level stays as saved.
  expect(shownApprovalsLevel(agent, { isPending: true, variables: {} })).toBe("risky");
});

test("the audit marks a call that ran without its card because the agent never asks", () => {
  expect(auditUnasked({ details: { approvalsLevel: "never" } })).toBe(true);
  expect(auditUnasked({ details: { approvalRules: ["r1"] } })).toBe(false);
});

test("an agent follows the workspace only when the server says so, and the own ones are counted", () => {
  expect(followsWorkspace({ approvalsLevelOwn: false })).toBe(true);
  expect(followsWorkspace({ approvalsLevelOwn: true })).toBe(false);
  expect(followsWorkspace({})).toBe(false);
  expect(ownApprovalsCount([{ approvalsLevelOwn: true }, { approvalsLevelOwn: false }, {}])).toBe(1);
});

test("Mudar quando perguntar: a waiting request, for who decides it and manages agents", () => {
  const admin = { permissions: ["manage_agents"] };
  expect(changesWhenAsks(admin, { status: "pending", canDecide: true })).toBe(true);
  expect(changesWhenAsks(admin, { status: "pending", canDecide: false })).toBe(false);
  expect(changesWhenAsks(admin, { status: "approved", canDecide: true })).toBe(false);
  expect(changesWhenAsks({ permissions: ["approve_actions"] }, { status: "pending", canDecide: true })).toBe(false);
});

test("what Desfazer puts back: one agent's choice, or every own choice with the workspace's level", () => {
  const agents = [
    { id: "ada", approvalsLevel: "never" as const, approvalsLevelOwn: true },
    { id: "atlas", approvalsLevel: "risky" as const, approvalsLevelOwn: false },
  ];
  expect(levelsBefore("risky", agents, "atlas")).toEqual({
    workspace: "risky",
    agents: [{ id: "atlas", level: null }],
  });
  expect(levelsBefore("risky", agents, "ada")).toEqual({ workspace: "risky", agents: [{ id: "ada", level: "never" }] });
  expect(levelsBefore("always", agents)).toEqual({ workspace: "always", agents: [{ id: "ada", level: "never" }] });
});
