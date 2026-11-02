import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  addChannelMember,
  approverIds,
  createApprovalRequestToolSource,
  decideApproval,
  drainOutbox,
  ForbiddenError,
  listApprovals,
  postPersonMessage,
  toolPolicy,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const WHY = "The agent's instructions say the board approves every query on the sales database.";

/** Asks `request_approval` with `extra` when told "run the query"; records what each tool result said. */
function agentAsking(extra: Record<string, unknown>, results: string[]) {
  return (req: ModelRequest) => {
    const last = JSON.stringify(req.messages.at(-1)?.content);
    if (last.includes("tool_result")) {
      results.push(last);
      return { chunks: ["Ok."] };
    }
    if (last.includes("run the query"))
      return {
        chunks: [],
        toolUses: [
          {
            name: "request_approval",
            input: { why: WHY, summary: "Query last month's sales", details: "select sum(total) from sales", ...extra },
          },
        ],
      };
    return { chunks: ["Feito."] };
  };
}

/** A member (not an admin) asks the agent, which the workspace's owner owns, for a query that needs approval. */
async function memberAsks(extra: Record<string, unknown> = {}) {
  const results: string[] = [];
  f = await setup({ toolSources: [createApprovalRequestToolSource()], reply: agentAsking(extra, results) });
  const bia = await addMember(f.db, f.org.id, "member", "bia");
  const carla = await addMember(f.db, f.org.id, "member", "carla");
  for (const u of [bia, carla]) await addChannelMember(f.db, f.owner.id, f.org.id, f.general.id, { userId: u.id });
  const [role] = await f.db.insert(schema.orgRoles).values({ orgId: f.org.id, name: "Diretoria" }).returning();
  if (!role) throw new Error("no role");
  await f.db.insert(schema.organizationMemberRoles).values({ orgId: f.org.id, userId: carla.id, roleId: role.id });
  return { bia, carla, roleId: role.id, results };
}

async function ask(userId: string) {
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, userId, f.org.id, f.general.id, {
    body: "@dev run the query",
  });
  await drainOutbox(f.db, f.handlers);
}

const runStatus = async () => (await f.db.select().from(schema.agentRuns))[0]?.status;

test("the built-in request_approval may be asked from any run; the mission's stays the mission's", () => {
  const routine = { kind: "routine", personId: null, brief: null } as const;
  expect(toolPolicy(routine, { name: "request_approval", scope: "", sensitive: true })).toEqual({ action: "allow" });
  expect(toolPolicy(routine, { name: "request_approval", scope: "sandbox:run" }).action).toBe("refuse");
});

test("a member's request goes to the agent's owner, never back to the member, and the decision wakes the agent", async () => {
  const { bia, results } = await memberAsks();
  await ask(bia.id);
  expect(await runStatus()).toBe("waiting_approval");

  const [mine] = await listApprovals(f.db, bia.id, f.org.id, { status: "pending" });
  expect(mine?.tool).toBe("request_approval");
  expect(mine?.title).toBe("Query last month's sales");
  expect(mine?.canDecide).toBe(false);
  expect(mine?.approvers).toEqual({ label: f.owner.name, requestedByUserId: bia.id, requesterDecides: false });
  const [row] = await f.db.select().from(schema.approvals);
  if (!row) throw new Error("no approval");
  expect(await approverIds(f.db, row)).toEqual([f.owner.id]);

  await expect(
    decideApproval({ db: f.db, pubsub: f.pubsub }, bia.id, f.org.id, row.id, { decision: "approve" }),
  ).rejects.toBeInstanceOf(ForbiddenError);

  await decideApproval({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, row.id, {
    decision: "approve",
    reason: "only this month",
  });
  await drainOutbox(f.db, f.handlers);
  expect(await runStatus()).toBe("done");
  expect(results.at(-1)).toContain(`Approved by ${f.owner.name}, with the note: only this month`);
  expect(results.at(-1)).toContain("select sum(total) from sales");
});

test("a role named in the request decides it; a refusal says who refused", async () => {
  const { bia, carla, results } = await memberAsks({ role: "diretoria" });
  await ask(bia.id);
  const [row] = await f.db.select().from(schema.approvals);
  if (!row) throw new Error("no approval");
  expect(row.approvers).toEqual({
    userIds: [carla.id],
    label: "Diretoria",
    requestedBy: bia.id,
    requesterDecides: false,
  });
  expect(await approverIds(f.db, row)).toEqual([carla.id]);
  // The agent's owner is no longer asked, but an admin may still decide.
  const [owners] = await listApprovals(f.db, f.owner.id, f.org.id, { status: "pending" });
  expect(owners?.canDecide).toBe(true);
  const [hers] = await listApprovals(f.db, carla.id, f.org.id, { status: "pending" });
  expect(hers?.canDecide).toBe(true);

  await decideApproval({ db: f.db, pubsub: f.pubsub }, carla.id, f.org.id, row.id, {
    decision: "refuse",
    reason: "not this quarter",
  });
  await drainOutbox(f.db, f.handlers);
  expect(results.at(-1)).toContain("carla refused this action");
  expect(results.at(-1)).toContain("not this quarter");
});

test("an approver by role may decide their own request, and it says so", async () => {
  const { carla } = await memberAsks({ role: "Diretoria" });
  await ask(carla.id);
  const [view] = await listApprovals(f.db, carla.id, f.org.id, { status: "pending" });
  expect(view?.canDecide).toBe(true);
  expect(view?.approvers).toEqual({ label: "Diretoria", requestedByUserId: carla.id, requesterDecides: true });
  await decideApproval({ db: f.db, pubsub: f.pubsub }, carla.id, f.org.id, view?.id ?? "", { decision: "approve" });
});

test("named alone, the requester's request goes to the owner and admins instead", async () => {
  const { bia } = await memberAsks({ people: ["@bia"] });
  await f.db.update(schema.agents).set({ ownerUserId: bia.id }).where(eq(schema.agents.id, f.agent.id));
  await ask(bia.id);
  const [row] = await f.db.select().from(schema.approvals);
  if (!row) throw new Error("no approval");
  expect(row.approvers?.userIds).toEqual([]);
  // Bia owns the agent, but it's her own request: the admins decide.
  expect(await approverIds(f.db, row)).toEqual([f.owner.id]);
  const [hers] = await listApprovals(f.db, bia.id, f.org.id, { status: "pending" });
  expect(hers?.canDecide).toBe(false);
});

test("a role that isn't there is refused with the workspace's roles, and nothing is asked", async () => {
  const { bia, results } = await memberAsks({ role: "Conselho" });
  await ask(bia.id);
  expect(await f.db.select().from(schema.approvals)).toEqual([]);
  expect(results.at(-1)).toContain('No role named \\"Conselho\\"');
  expect(results.at(-1)).toContain("Diretoria");
});
