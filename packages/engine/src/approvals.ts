import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, inArray, lt, ne, or, schema, sql } from "@agenteschat/db";
import { learnFromRefusal } from "./context/feedback";
import type { MemoryJudging } from "./context/items";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { publishChannelEvent, publishUserEvent } from "./events";
import { notifyApproval, resolveApprovalNotifications } from "./notification-producers";
import { can, requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import type { Approval } from "./tools/gateway";

const {
  approvals,
  organizationMembers,
  channelMembers,
  agents,
  agentRuns,
  agentRunSteps,
  connectorConnections,
  issues,
} = schema;

export interface ApprovalView {
  id: string;
  /** Null for an approval a mission's executor asked (`missionId`). */
  runId: string | null;
  missionId: string | null;
  agentId: string;
  channelId: string;
  threadId: string;
  messageId: string | null;
  tool: string;
  scope: string;
  title: string;
  detail: string;
  params: Record<string, unknown>;
  /** Stable key for the card's title (the tool), and the values it shows: the app words it in the person's language. */
  kind: string;
  titleParams: Record<string, string | number | boolean>;
  status: Approval["status"];
  expiresAt: string;
  createdAt: string;
  decidedByUserId: string | null;
  decidedAt: string | null;
  reason: string | null;
  /** Whether the person asking may approve or refuse it. */
  canDecide: boolean;
  /** The agent's owner at request time (they and admins may decide). */
  ownerUserId: string | null;
  /** When the approved action ran (null: not yet, or never). */
  executedAt: string | null;
  /** What the action returned once it ran (raw tool output, short). */
  result: { ok: boolean; text: string } | null;
  /** The connector the action goes through (`github`), and its account (`acme`); null for built-in tools. */
  connector: string | null;
  connectorAccount: string | null;
  /** What the agent said right before asking (its narration of that turn): the why, in its own words. */
  why: string | null;
  /** The issue the run works on, when there is one. */
  issue: { id: string; number: number; title: string } | null;
  /** How the run got here: what the agent said at each turn before asking (one approval only). */
  trail?: { text: string; at: string }[];
}

/** What the approval row alone doesn't say: the connector, the agent's why, the issue (and, for one, the trail). */
interface ApprovalContext {
  connector: string | null;
  connectorAccount: string | null;
  why: string | null;
  issue: { id: string; number: number; title: string } | null;
  trail: { text: string; at: string }[];
}

const resultOf = (a: Approval): ApprovalView["result"] => {
  const r = a.result as { content?: unknown; isError?: unknown } | null;
  if (!r) return null;
  return { ok: r.isError !== true, text: typeof r.content === "string" ? r.content.slice(0, 600) : "" };
};

/** Batched: connections, the runs' narration up to each approval step, the runs' issues. */
async function approvalContexts(db: Database, rows: Approval[]): Promise<Map<string, ApprovalContext>> {
  const out = new Map<string, ApprovalContext>();
  if (rows.length === 0) return out;
  // Mission approvals (ADR 0029) have no run.
  const runIds = [...new Set(rows.map((r) => r.runId).filter((id): id is string => !!id))];
  const connectionIds = [...new Set(rows.map((r) => r.connectionId).filter((id): id is string => !!id))];
  const [connections, steps, runs] = await Promise.all([
    connectionIds.length
      ? db
          .select({
            id: connectorConnections.id,
            connector: connectorConnections.connector,
            account: connectorConnections.accountLabel,
          })
          .from(connectorConnections)
          .where(inArray(connectorConnections.id, connectionIds))
      : Promise.resolve([]),
    runIds.length
      ? db
          .select({
            runId: agentRunSteps.runId,
            kind: agentRunSteps.kind,
            narration: sql<string | null>`${agentRunSteps.data}->>'narration'`,
            approvalId: sql<string | null>`${agentRunSteps.data}->>'approvalId'`,
            createdAt: agentRunSteps.createdAt,
          })
          .from(agentRunSteps)
          .where(and(inArray(agentRunSteps.runId, runIds), inArray(agentRunSteps.kind, ["model_call", "approval"])))
          .orderBy(agentRunSteps.runId, agentRunSteps.seq)
      : Promise.resolve([]),
    runIds.length
      ? db.select({ id: agentRuns.id, issueId: agentRuns.issueId }).from(agentRuns).where(inArray(agentRuns.id, runIds))
      : Promise.resolve([]),
  ]);
  const issueIds = [...new Set(runs.map((r) => r.issueId).filter((id): id is string => !!id))];
  const issueRows = issueIds.length
    ? await db
        .select({ id: issues.id, number: issues.number, title: issues.title })
        .from(issues)
        .where(inArray(issues.id, issueIds))
    : [];
  const connectionOf = new Map(connections.map((c) => [c.id, c]));
  const issueOfRun = new Map(runs.map((r) => [r.id, issueRows.find((i) => i.id === r.issueId) ?? null]));
  for (const row of rows) {
    // The narration of every turn before this approval's step; the last one is the why.
    const trail: ApprovalContext["trail"] = [];
    for (const s of steps) {
      if (s.runId !== row.runId) continue;
      if (s.kind === "approval" && s.approvalId === row.id) break;
      if (s.kind === "model_call" && s.narration) trail.push({ text: s.narration, at: s.createdAt.toISOString() });
    }
    const connection = row.connectionId ? connectionOf.get(row.connectionId) : undefined;
    out.set(row.id, {
      connector: connection?.connector ?? null,
      connectorAccount: connection?.account ?? null,
      why: trail.at(-1)?.text.slice(0, 1000) ?? null,
      issue: row.runId ? (issueOfRun.get(row.runId) ?? null) : null,
      trail: trail.slice(-12),
    });
  }
  return out;
}

/** Views with their context (connector, why, issue); `trail` only when asked (one approval's details). */
async function viewsOf(db: Database, rows: Approval[], canDecide: (row: Approval) => boolean, trail = false) {
  const contexts = await approvalContexts(db, rows).catch(() => new Map<string, ApprovalContext>());
  return rows.map((r) => {
    const { trail: steps, ...context } = contexts.get(r.id) ?? {
      connector: null,
      connectorAccount: null,
      why: null,
      issue: null,
      trail: [],
    };
    return { ...approvalView(r, canDecide(r)), ...context, ...(trail ? { trail: steps } : {}) };
  });
}

/** Top-level scalar inputs of an approved action ("pullNumber", "owner", "repo", "environment"…), short. */
export function scalarParams(params: Record<string, unknown>) {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(params ?? {}).slice(0, 20)) {
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 200);
  }
  return out;
}

export const approvalView = (a: Approval, canDecide = false): ApprovalView => ({
  id: a.id,
  runId: a.runId,
  missionId: a.missionId ?? null,
  agentId: a.agentId,
  channelId: a.channelId,
  threadId: a.threadRootId,
  messageId: a.messageId,
  tool: a.tool,
  scope: a.scope,
  title: a.title,
  detail: a.detail,
  params: a.params,
  kind: a.tool,
  titleParams: scalarParams(a.params),
  status: a.status,
  expiresAt: a.expiresAt.toISOString(),
  createdAt: a.createdAt.toISOString(),
  decidedByUserId: a.decidedByUserId,
  decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
  reason: a.reason,
  canDecide: canDecide && a.status === "pending",
  ownerUserId: a.ownerUserId,
  executedAt: a.executedAt ? a.executedAt.toISOString() : null,
  result: resultOf(a),
  connector: null,
  connectorAccount: null,
  why: null,
  issue: null,
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
  const [view = approvalView(approval)] = await viewsOf(deps.db, [approval], () => false);
  await publishChannelEvent(deps.pubsub, { type, channelId: approval.channelId, approval: view });
  const deciders = await approverIds(deps.db, approval);
  for (const userId of deciders) {
    await publishUserEvent(deps.pubsub, approval.orgId, userId, { type, approval: { ...view, canDecide: true } });
  }
  // The inbox (D46): waiting for whoever may decide; out of it once decided or expired.
  if (type === "approval.created" && approval.status === "pending") {
    await notifyApproval(deps, approval, deciders).catch(() => {});
  } else if (type === "approval.decided") {
    await resolveApprovalNotifications(deps, approval.orgId, approval.id).catch(() => {});
  }
}

/**
 * What a decision wakes: the run that asked, or, for an approval asked by a
 * mission's executor (ADR 0029, no run), the task's session on the machine.
 */
async function enqueueResume(tx: Executor, row: Pick<Approval, "id" | "orgId" | "runId" | "missionId">) {
  if (row.runId) {
    await enqueue(tx, {
      orgId: row.orgId,
      kind: "agent_run.execute",
      payload: { runId: row.runId },
      dedupeKey: `agent_run.execute:${row.runId}:approval:${row.id}`,
      maxAttempts: 4,
    });
  } else if (row.missionId) {
    await enqueue(tx, {
      orgId: row.orgId,
      kind: "mission.approval_decided",
      payload: { approvalId: row.id },
      dedupeKey: `mission.approval_decided:${row.id}`,
      maxAttempts: 4,
    });
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
  /** `memory`: how the lesson from a refusal is judged (context/items.ts `MemoryJudging`). */
  deps: { db: Database; pubsub: PubSub; now?: () => Date; memory?: MemoryJudging },
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
    await enqueueResume(tx, row);
    return expired ? { error: "This request has expired" as const, row: updated } : { row: updated };
  });
  if (outcome.row) await publishApproval(deps, outcome.row, "approval.decided");
  if (outcome.error || !outcome.row) throw new ConflictError(outcome.error ?? "approval vanished");
  // A refusal (with its reason) becomes an outcome and a lesson for the agent.
  if (outcome.row.status === "refused") await learnFromRefusal(deps, outcome.row).catch(() => null);
  const [view = approvalView(outcome.row)] = await viewsOf(db, [outcome.row], () => false);
  return view;
}

/** Marks pending approvals past their deadline as expired and resumes their runs (worker, every minute). */
export async function expireApprovals(deps: { db: Database; pubsub: PubSub }, now = new Date()) {
  const expired = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(approvals)
      .set({ status: "expired" })
      .where(and(eq(approvals.status, "pending"), lt(approvals.expiresAt, now)))
      .returning();
    for (const row of rows) await enqueueResume(tx, row);
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
  return viewsOf(db, rows, (r) => admin || r.ownerUserId === actorId);
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
  const [detailed] = await viewsOf(db, [row], () => visible.canDecide, true);
  return { ...visible, trail: detailed?.trail ?? [] };
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
