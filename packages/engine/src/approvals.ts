import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, eq, inArray, lt, ne, or, schema, sql } from "@agenteschat/db";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { publishChannelEvent, publishUserEvent } from "./events";
import { can, requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import type { Approval } from "./tools/gateway";

const { approvals, organizationMembers, channelMembers, agents } = schema;

export interface ApprovalView {
  id: string;
  runId: string;
  agentId: string;
  channelId: string;
  threadId: string;
  messageId: string | null;
  tool: string;
  scope: string;
  title: string;
  detail: string;
  params: Record<string, unknown>;
  status: Approval["status"];
  expiresAt: string;
  createdAt: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  reason: string | null;
  /** Whether the person asking may approve or refuse it. */
  canDecide: boolean;
}

export const approvalView = (a: Approval, canDecide = false): ApprovalView => ({
  id: a.id,
  runId: a.runId,
  agentId: a.agentId,
  channelId: a.channelId,
  threadId: a.threadRootId,
  messageId: a.messageId,
  tool: a.tool,
  scope: a.scope,
  title: a.title,
  detail: a.detail,
  params: a.params,
  status: a.status,
  expiresAt: a.expiresAt.toISOString(),
  createdAt: a.createdAt.toISOString(),
  decidedByUserId: a.decidedByUserId,
  decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
  reason: a.reason,
  canDecide: canDecide && a.status === "pending",
});

/** People who may decide: the agent's owner and the organization's admins and owners. */
export async function approverIds(db: Database, approval: Pick<Approval, "orgId" | "ownerUserId">) {
  const admins = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, approval.orgId), inArray(organizationMembers.role, ["owner", "admin"])));
  const ids = new Set(admins.map((a) => a.userId));
  if (approval.ownerUserId) {
    const [owner] = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, approval.orgId), eq(organizationMembers.userId, approval.ownerUserId)));
    if (owner) ids.add(owner.userId);
  }
  return [...ids];
}

/** Tells the channel and every approver about an approval (card in the chat, badge on the Approvals screen). */
export async function publishApproval(
  deps: { db: Database; pubsub: PubSub },
  approval: Approval,
  type: "approval.created" | "approval.decided",
) {
  const view = approvalView(approval);
  await publishChannelEvent(deps.pubsub, { type, channelId: approval.channelId, approval: view });
  for (const userId of await approverIds(deps.db, approval)) {
    await publishUserEvent(deps.pubsub, approval.orgId, userId, { type, approval: { ...view, canDecide: true } });
  }
}

async function mayDecide(db: Database, actorId: string, approval: Approval) {
  const membership = await requirePermission(db, actorId, approval.orgId, "read");
  return approval.ownerUserId === actorId || can(membership.role, "manage_agents");
}

/**
 * Approves or refuses a pending approval. Only the agent's owner and org
 * admins may. The decision and the job that resumes the run commit together;
 * the run then executes exactly the hashed action, or tells the model it was
 * refused (with the reason).
 */
export async function decideApproval(
  deps: { db: Database; pubsub: PubSub; now?: () => Date },
  actorId: string,
  orgId: string,
  approvalId: string,
  input: { decision: "approve" | "refuse"; reason?: string },
): Promise<ApprovalView> {
  const { db } = deps;
  const at = deps.now?.() ?? new Date();
  const [current] = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, approvalId), eq(approvals.orgId, orgId)));
  if (!current) throw new NotFoundError("Approval not found");
  if (!(await mayDecide(db, actorId, current))) {
    throw new ForbiddenError("Only the agent's owner or an admin can decide this");
  }

  const outcome = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(approvals).where(eq(approvals.id, approvalId)).for("update");
    if (row?.status !== "pending") return { error: "This request was already decided" as const };
    const expired = row.expiresAt <= at;
    const [updated] = await tx
      .update(approvals)
      .set(
        expired
          ? { status: "expired" }
          : {
              status: input.decision === "approve" ? "approved" : "refused",
              decidedByUserId: actorId,
              decidedAt: at,
              reason: input.reason?.trim().slice(0, 1000) || null,
            },
      )
      .where(eq(approvals.id, approvalId))
      .returning();
    await enqueue(tx, {
      orgId,
      kind: "agent_run.execute",
      payload: { runId: row.runId },
      dedupeKey: `agent_run.execute:${row.runId}:approval:${row.id}`,
      maxAttempts: 4,
    });
    return expired ? { error: "This request has expired" as const, row: updated } : { row: updated };
  });
  if (outcome.row) await publishApproval(deps, outcome.row, "approval.decided");
  if (outcome.error || !outcome.row) throw new ConflictError(outcome.error ?? "approval vanished");
  return approvalView(outcome.row);
}

/** Marks pending approvals past their deadline as expired and resumes their runs (worker, every minute). */
export async function expireApprovals(deps: { db: Database; pubsub: PubSub }, now = new Date()) {
  const expired = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(approvals)
      .set({ status: "expired" })
      .where(and(eq(approvals.status, "pending"), lt(approvals.expiresAt, now)))
      .returning();
    for (const row of rows) {
      await enqueue(tx, {
        orgId: row.orgId,
        kind: "agent_run.execute",
        payload: { runId: row.runId },
        dedupeKey: `agent_run.execute:${row.runId}:approval:${row.id}`,
        maxAttempts: 4,
      });
    }
    return rows;
  });
  for (const row of expired) await publishApproval(deps, row, "approval.decided");
  return expired.length;
}

/**
 * Approvals a person can see: admins see all; others see those of agents they
 * own and those in channels they belong to. Each carries `canDecide`.
 */
export async function listApprovals(
  db: Database,
  actorId: string,
  orgId: string,
  options: { status?: "pending" | "decided"; agentId?: string; limit?: number } = {},
): Promise<ApprovalView[]> {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const admin = can(membership.role, "manage_agents");
  const myChannels = db
    .select({ id: channelMembers.channelId })
    .from(channelMembers)
    .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.userId, actorId)));
  const rows = await db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.orgId, orgId),
        options.status === "pending"
          ? eq(approvals.status, "pending")
          : options.status === "decided"
            ? ne(approvals.status, "pending")
            : undefined,
        options.agentId ? eq(approvals.agentId, options.agentId) : undefined,
        admin ? undefined : or(eq(approvals.ownerUserId, actorId), inArray(approvals.channelId, myChannels)),
      ),
    )
    .orderBy(desc(approvals.createdAt))
    .limit(Math.min(options.limit ?? 100, 500));
  return rows.map((r) => approvalView(r, admin || r.ownerUserId === actorId));
}

export async function getApproval(db: Database, actorId: string, orgId: string, approvalId: string) {
  const list = await db
    .select()
    .from(approvals)
    .where(and(eq(approvals.id, approvalId), eq(approvals.orgId, orgId)));
  const row = list[0];
  if (!row) throw new NotFoundError("Approval not found");
  const visible = (await listApprovals(db, actorId, orgId, { agentId: row.agentId, limit: 500 })).find(
    (a) => a.id === row.id,
  );
  if (!visible) throw new NotFoundError("Approval not found");
  return visible;
}

/** Pending approvals per agent, for badges. */
export async function pendingApprovalCounts(db: Database, orgId: string) {
  return db
    .select({ agentId: approvals.agentId, handle: agents.handle, pending: sql<number>`count(*)::int` })
    .from(approvals)
    .innerJoin(agents, eq(agents.id, approvals.agentId))
    .where(and(eq(approvals.orgId, orgId), eq(approvals.status, "pending")))
    .groupBy(approvals.agentId, agents.handle);
}
