import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { AGENT_ACTION_KINDS, type AgentAction } from "../src/api/types";
import {
  actionErrorKey,
  actionPhase,
  actionTextKey,
  actionTextValues,
  actionTimeLeft,
  canUndoAction,
  formatTimeLeft,
  hookToCopy,
  undoableNow,
} from "../src/lib/actions";

const now = Date.parse("2026-10-18T12:00:00Z");
const action = (over: Partial<AgentAction> = {}): AgentAction => ({
  id: "a1",
  kind: "issue.created",
  agentId: "ag",
  messageId: "m1",
  requestedByUserId: "u1",
  target: { type: "issue", id: "i1", number: 23, title: "Prompt" },
  params: { number: 23, title: "Prompt" },
  createdAt: "2026-10-18T11:59:00Z",
  undoableUntil: "2026-10-18T12:04:00Z",
  undoneAt: null,
  undoneByUserId: null,
  redoneAt: null,
  ...over,
});

describe("receipts", () => {
  test("phase: undo, then redo once undone, settled after the window", () => {
    expect(actionPhase(action(), now)).toBe("undo");
    expect(actionPhase(action({ undoneAt: "2026-10-18T11:59:30Z" }), now)).toBe("redo");
    expect(actionPhase(action({ undoableUntil: "2026-10-18T11:00:00Z" }), now)).toBe("settled");
  });

  test("time left and countdown", () => {
    expect(actionTimeLeft(action(), now)).toBe(240_000);
    expect(formatTimeLeft(238_000)).toBe("3:58");
    expect(actionTimeLeft(action({ undoableUntil: "2026-10-18T11:00:00Z" }), now)).toBe(0);
  });

  test("a webhook routine the agent made offers its address to who asked or manages routines; nothing else does", () => {
    const made = action({
      kind: "routine.created",
      target: { type: "routine", id: "rt1", title: "Avisar" },
      params: { name: "Avisar", trigger: "webhook" },
    });
    expect(hookToCopy(made, { userId: "u1", managesRoutines: false })).toBe("rt1");
    expect(hookToCopy(made, { userId: "u2", managesRoutines: true })).toBe("rt1");
    expect(hookToCopy(made, { userId: "u2", managesRoutines: false })).toBeNull();
    expect(
      hookToCopy({ ...made, undoneAt: "2026-10-18T11:59:30Z" }, { userId: "u1", managesRoutines: true }),
    ).toBeNull();
    expect(
      hookToCopy({ ...made, params: { name: "Avisar", trigger: "schedule" } }, { userId: "u1", managesRoutines: true }),
    ).toBeNull();
    expect(hookToCopy(action(), { userId: "u1", managesRoutines: true })).toBeNull();
    // Changed into a webhook routine (or its methods changed): the same button.
    expect(hookToCopy({ ...made, kind: "routine.updated" }, { userId: "u1", managesRoutines: false })).toBe("rt1");
  });

  test("who sees the buttons", () => {
    expect(canUndoAction(action(), { userId: "u1", managesAgents: false, ownsAgent: false })).toBe(true);
    expect(canUndoAction(action(), { userId: "u2", managesAgents: false, ownsAgent: false })).toBe(false);
    expect(canUndoAction(action(), { userId: "u2", managesAgents: true, ownsAgent: false })).toBe(true);
    expect(canUndoAction(action(), { userId: "u2", managesAgents: false, ownsAgent: true })).toBe(true);
  });

  test("Desfazer tudo takes only the undoable ones; i18n keys", () => {
    const list = [action(), action({ id: "a2", undoneAt: "2026-10-18T11:59:30Z" })];
    expect(undoableNow(list, now).map((a) => a.id)).toEqual(["a1"]);
    expect(actionTextKey(action())).toBe("agentActions.issue.created");
    expect(actionErrorKey("action.changed_since")).toBe("agentActions.errors.changed_since");
  });
});

describe("receipt sentence values", () => {
  const t = ((key: string, o?: Record<string, unknown>) =>
    key === "format.list"
      ? new Intl.ListFormat("pt-BR").format(o?.names as string[])
      : key.startsWith("agentActions.")
        ? (key.split(".").pop() ?? key)
        : String(o?.defaultValue ?? key)) as unknown as TFunction;

  test("issue: number and title; one field picks a context", () => {
    expect(actionTextValues(action(), t)).toEqual({ number: "23", title: "Prompt" });
    const status = action({
      kind: "issue.updated",
      params: { number: 23, title: "P", fields: ["status"], status: "done" },
    });
    expect(actionTextValues(status, t)).toMatchObject({ context: "status", status: "done" });
    const two = action({ kind: "issue.updated", params: { number: 23, title: "P", fields: ["title", "labels"] } });
    expect(actionTextValues(two, t).fields).toBe("title e labels");
    expect(actionTextValues(two, t).context).toBeUndefined();
  });

  test("assigned: to the agent itself, or to the viewer", () => {
    const self = action({ kind: "issue.assigned", params: { number: 2, title: "T", assigneeIsSelf: true } });
    expect(actionTextValues(self, t).context).toBe("self");
    const viewer = action({
      kind: "issue.assigned",
      params: { number: 2, title: "T", assigneeType: "user", assigneeId: "u9", assigneeName: "Bia" },
    });
    expect(actionTextValues(viewer, t, "u9").assignee).toBe("you");
    expect(actionTextValues(viewer, t, "u1").assignee).toBe("Bia");
  });

  test("a change applied at once says what it changed; a card's settings stay settings", () => {
    const applied = action({
      kind: "agent.settings_changed",
      target: { type: "agent", id: "a" },
      params: { agentName: "Ada", fields: ["instructions"] },
    });
    expect(actionTextValues(applied, t)).toEqual({ agentName: "Ada", context: "instructions" });
    const card = action({
      kind: "agent.settings_changed",
      target: { type: "agent", id: "a" },
      params: { agentName: "Ada", fields: ["model"] },
    });
    expect(actionTextValues(card, t)).toEqual({ agentName: "Ada" });
  });

  test("routine paused, channel, thread", () => {
    const paused = action({
      kind: "routine.updated",
      target: { type: "routine", id: "r" },
      params: { name: "Daily", fields: ["active"], active: false },
    });
    expect(actionTextValues(paused, t)).toMatchObject({ name: "Daily", context: "paused" });
    const added = action({
      kind: "channel.agent_added",
      target: { type: "channel", id: "c", title: "tech" },
      params: { agentName: "Theo" },
    });
    expect(actionTextValues(added, t)).toEqual({ agentName: "Theo", channel: "tech" });
    const renamed = action({
      kind: "thread.renamed",
      target: { type: "thread", id: "t" },
      params: { from: "a", to: "b" },
    });
    expect(actionTextValues(renamed, t).to).toBe("b");
  });

  test("a deleted routine says its name; a kind this build doesn't know still gives values", () => {
    const deleted = action({
      kind: "routine.deleted",
      target: { type: "routine", id: "r", title: "Daily" },
      params: { name: "Daily" },
    });
    expect(actionTextValues(deleted, t)).toEqual({ name: "Daily" });
    const unknown = action({ kind: "something.new" as AgentAction["kind"] });
    expect(actionTextValues(unknown, t)).toEqual({});
    // Its sentence: "Fiz uma mudança", never the raw key.
    expect(actionTextKey(unknown)).toBe("agentActions.other");
  });

  test("a merge done without asking: its pull request, or the branch of a plain git merge, and nothing to undo", () => {
    const pr = action({
      kind: "pr.merged",
      target: { type: "repository", id: "acme/app", title: "acme/app" },
      params: { repo: "acme/app", number: 12 },
    });
    expect(actionTextValues(pr, t)).toEqual({ repo: "acme/app", number: "12" });
    expect(actionTextKey(pr)).toBe("agentActions.pr.merged");
    const branch = action({ ...pr, params: { repo: "acme/app", ref: "feature/x" } });
    expect(actionTextValues(branch, t)).toEqual({ repo: "acme/app", ref: "feature/x", context: "branch" });
    const now = Date.now();
    expect(actionPhase(action({ ...pr, undoableUntil: new Date(now).toISOString() }), now)).toBe("settled");
  });

  test("a workspace change: its words, and its action as the context when this build knows it", () => {
    const made = action({
      kind: "workspace.changed",
      target: { type: "role", id: "r1", title: "Marketing" },
      params: { action: "create_role", name: "Marketing" },
    });
    expect(actionTextValues(made, t)).toEqual({ name: "Marketing", context: "create_role" });
    expect(actionTextKey(made)).toBe("agentActions.workspace.changed");
    // A newer server's action reads the plain sentence.
    const newer = action({ ...made, params: { action: "paint_office", color: "red" } });
    expect(actionTextValues(newer, t)).toEqual({ color: "red", context: "" });
  });

  test("every kind the app knows has its own case (the default gives no values)", () => {
    const missing = AGENT_ACTION_KINDS.filter((kind) => !Object.keys(actionTextValues(action({ kind }), t)).length);
    expect(missing).toEqual([]);
  });
});
