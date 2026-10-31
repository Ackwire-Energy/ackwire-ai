import { and, asc, type Database, type Executor, eq, inArray, schema } from "@agenteschat/db";
import { getAgent } from "./agents";
import { recordAudit } from "./audit";
import { ForbiddenError, NotFoundError } from "./errors";
import { can, requirePermission } from "./organizations";

const { approvalRules, connectorConnections, customTools } = schema;

/**
 * "Aprovar sempre" (docs/adr/0015): someone who decides an agent's approvals approves a kind of call for good, and
 * the Tool Gateway runs the next calls of that kind without asking. The kind is the agent, the connection, the
 * server's own tool name and, for a tool that runs other actions, each action (`''`: the tool itself); never the
 * params. A rule only skips the question: access, the run policy and the arguments' checks still decide first.
 */

/** What "Aprovar sempre" covers on one approval (`approvals.approve_always`). */
export interface RememberedKind {
  tool: string;
  /** The wrapped actions; none: the tool itself. */
  actions: string[];
}

export interface RuleScope {
  orgId: string;
  agentId: string;
  connectionId: string;
}

const actionsOf = (kind: RememberedKind) => (kind.actions.length > 0 ? kind.actions : [""]);

/** The stored kind of an approval, read safely; null when it wasn't offered. */
export function rememberedKindOf(value: unknown): RememberedKind | null {
  const v = value as Partial<RememberedKind> | null | undefined;
  if (!v || typeof v.tool !== "string" || !v.tool || !Array.isArray(v.actions)) return null;
  if (!v.actions.every((a) => typeof a === "string" && a)) return null;
  return { tool: v.tool, actions: v.actions };
}

/** The ids of the rules that cover this call, or null when one is missing. Read fresh: a removed rule asks at once. */
export async function coveringRules(db: Executor, at: RuleScope, kind: RememberedKind): Promise<string[] | null> {
  const wanted = actionsOf(kind);
  const rows = await db
    .select({ id: approvalRules.id, action: approvalRules.action })
    .from(approvalRules)
    .where(
      and(
        eq(approvalRules.orgId, at.orgId),
        eq(approvalRules.agentId, at.agentId),
        eq(approvalRules.connectionId, at.connectionId),
        eq(approvalRules.tool, kind.tool),
        inArray(approvalRules.action, wanted),
      ),
    );
  const have = new Set(rows.map((r) => r.action));
  return wanted.every((a) => have.has(a)) ? rows.map((r) => r.id) : null;
}

/** Keeps a kind for good (in the decision's transaction); rules already there stay as they are. */
export async function addApprovalRules(tx: Executor, at: RuleScope, kind: RememberedKind, createdByUserId: string) {
  await tx
    .insert(approvalRules)
    .values(actionsOf(kind).map((action) => ({ ...at, tool: kind.tool, action, createdByUserId })))
    .onConflictDoNothing();
}

export interface ApprovalRuleView {
  id: string;
  connectionId: string;
  /** The connection's name ("Cmposio"). */
  server: string;
  /** The server's own tool name. */
  tool: string;
  /** How the workspace labelled that tool (its review), else the tool's name. */
  toolLabel: string;
  /** The wrapped action; `''`: the tool itself. */
  action: string;
  createdByUserId: string | null;
  createdAt: string;
}

/** An agent's rules, oldest first, for anyone in the workspace (its page lists them). */
export async function listApprovalRules(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
): Promise<ApprovalRuleView[]> {
  await requirePermission(db, actorId, orgId, "read");
  if (!(await getAgent(db, orgId, agentId))) throw new NotFoundError("Agent not found");
  const rows = await db
    .select({
      id: approvalRules.id,
      connectionId: approvalRules.connectionId,
      server: connectorConnections.label,
      tool: approvalRules.tool,
      toolLabel: customTools.label,
      action: approvalRules.action,
      createdByUserId: approvalRules.createdByUserId,
      createdAt: approvalRules.createdAt,
    })
    .from(approvalRules)
    .innerJoin(connectorConnections, eq(connectorConnections.id, approvalRules.connectionId))
    .leftJoin(
      customTools,
      and(eq(customTools.connectionId, approvalRules.connectionId), eq(customTools.name, approvalRules.tool)),
    )
    .where(and(eq(approvalRules.orgId, orgId), eq(approvalRules.agentId, agentId)))
    .orderBy(asc(approvalRules.createdAt), asc(approvalRules.id));
  return rows.map((r) => ({ ...r, toolLabel: r.toolLabel || r.tool, createdAt: r.createdAt.toISOString() }));
}

/** The audit row of a removed rule, `details` `{ connectionId, tool, action }`: the git proxy reads it too (`pushGrants`). */
export const RULE_REMOVED_AUDIT = "agent.approval_rule_removed";

/** Removes one rule: the next call of that kind asks again. Whoever decides its approvals (`approve_actions`, the agent's owner). */
export async function removeApprovalRule(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  ruleId: string,
) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  if (!can(membership, "approve_actions") && agent.ownerUserId !== actorId) {
    throw new ForbiddenError("Only the agent's owner or an admin can change this");
  }
  await db.transaction(async (tx) => {
    const [gone] = await tx
      .delete(approvalRules)
      .where(and(eq(approvalRules.id, ruleId), eq(approvalRules.orgId, orgId), eq(approvalRules.agentId, agentId)))
      .returning();
    if (!gone) throw new NotFoundError("Rule not found");
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: RULE_REMOVED_AUDIT,
      target: { type: "agent", id: agentId },
      details: { connectionId: gone.connectionId, tool: gone.tool, action: gone.action },
    });
  });
}
