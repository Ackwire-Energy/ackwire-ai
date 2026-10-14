import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, eq, inArray, schema } from "@agenteschat/db";
import { getAgent } from "../agents";
import { sha256 } from "../crypto";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors";
import { publishUserEvent } from "../events";
import { can, requirePermission } from "../organizations";
import { type ContextItem, checkContent } from "./items";

const { contextProposals, contextItems, agents, organizations, organizationMembers } = schema;

export type Proposal = typeof contextProposals.$inferSelect;

/** When an item is strong enough to propose turning it into instructions or org context. */
export const PROMOTION = { minRecurrence: 2, minConfidence: 0.8, minRelevance: 0.7 };

export function isPromotable(item: ContextItem) {
  if (item.status !== "active" || item.supersededBy || item.proposedAt) return false;
  // Untrusted content and unverified lessons are never promoted (memory poisoning, echo chambers).
  if (item.trust !== "high" || !item.verified) return false;
  if (!["lesson", "preference", "decision", "fact"].includes(item.kind)) return false;
  return (
    item.recurrence >= PROMOTION.minRecurrence ||
    (item.confidence >= PROMOTION.minConfidence && item.relevance >= PROMOTION.minRelevance)
  );
}

/** A line diff (LCS) in unified style: ` ` kept, `-` removed, `+` added. */
export function lineDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      (lcs[i] as number[])[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as number[])[j + 1] ?? 0) + 1
          : Math.max((lcs[i + 1] as number[])[j] ?? 0, (lcs[i] as number[])[j + 1] ?? 0);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (((lcs[i + 1] as number[])[j] ?? 0) >= ((lcs[i] as number[])[j + 1] ?? 0)) out.push(`-${a[i++]}`);
    else out.push(`+${b[j++]}`);
  }
  while (i < a.length) out.push(`-${a[i++]}`);
  while (j < b.length) out.push(`+${b[j++]}`);
  return out.join("\n");
}

/** Text with one more bullet, under a "Learned" heading (deterministic, no model). */
export function withLearnedBullet(text: string, bullet: string) {
  const line = `- ${bullet.replace(/\s+/g, " ").trim()}`;
  if (text.includes(line)) return text;
  const heading = "## Learned";
  const base = text.trimEnd();
  return base.includes(heading) ? `${base}\n${line}` : `${base}${base ? "\n\n" : ""}${heading}\n${line}`;
}

/**
 * Turns a strong item into a proposal: the agent's lesson → its instructions;
 * a shared lesson or org-wide fact → the org context. Never applied here.
 * Notifies who can decide. Returns null when the item isn't promotable.
 */
export async function proposeFromItem(
  deps: { db: Database; pubsub?: PubSub },
  item: ContextItem,
): Promise<Proposal | null> {
  if (!isPromotable(item)) return null;
  const { db } = deps;
  let target: Proposal["target"];
  let current: string;
  let agentId: string | null = null;
  if (item.agentId) {
    const agent = await getAgent(db, item.orgId, item.agentId);
    if (!agent || agent.archivedAt) return null;
    target = "agent_instructions";
    current = agent.instructions;
    agentId = agent.id;
  } else {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, item.orgId));
    if (!org) return null;
    target = "org_context";
    current = org.context;
  }
  const proposedText = withLearnedBullet(current, item.content);
  if (proposedText === current) return null;
  const evidence = item.evidence.map((e) => e.type).join(", ");
  const [proposal] = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(contextItems)
      .set({ proposedAt: new Date() })
      .where(and(eq(contextItems.id, item.id), eq(contextItems.status, "active")))
      .returning({ id: contextItems.id });
    if (claimed.length === 0) return [];
    return tx
      .insert(contextProposals)
      .values({
        orgId: item.orgId,
        target,
        agentId,
        baseHash: sha256(current),
        proposedText,
        diff: lineDiff(current, proposedText),
        rationale: `Seen ${item.recurrence}× (confidence ${item.confidence.toFixed(2)}, evidence: ${evidence || "none"}).`,
        itemIds: [item.id],
      })
      .returning();
  });
  if (!proposal) return null;
  if (deps.pubsub) {
    for (const userId of await deciders(db, proposal)) {
      await publishUserEvent(deps.pubsub, proposal.orgId, userId, {
        type: "proposal.created",
        proposalId: proposal.id,
      });
    }
  }
  return proposal;
}

/** Who decides: the agent's owner and admins (instructions), admins (org context). */
async function deciders(db: Database, p: Proposal) {
  const admins = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, p.orgId), inArray(organizationMembers.role, ["owner", "admin"])));
  const ids = new Set(admins.map((a) => a.userId));
  if (p.agentId) {
    const [agent] = await db.select({ owner: agents.ownerUserId }).from(agents).where(eq(agents.id, p.agentId));
    if (agent?.owner) ids.add(agent.owner);
  }
  return [...ids];
}

async function mayDecide(db: Database, actorId: string, p: Proposal) {
  const membership = await requirePermission(db, actorId, p.orgId, "read");
  if (can(membership.role, "configure")) return true;
  if (p.target === "agent_instructions" && p.agentId) {
    const agent = await getAgent(db, p.orgId, p.agentId);
    return agent?.ownerUserId === actorId;
  }
  return false;
}

export async function listProposals(
  db: Database,
  actorId: string,
  orgId: string,
  options: { status?: Proposal["status"]; agentId?: string } = {},
) {
  await requirePermission(db, actorId, orgId, "read");
  const rows = await db
    .select()
    .from(contextProposals)
    .where(
      and(
        eq(contextProposals.orgId, orgId),
        options.status ? eq(contextProposals.status, options.status) : undefined,
        options.agentId ? eq(contextProposals.agentId, options.agentId) : undefined,
      ),
    )
    .orderBy(desc(contextProposals.createdAt))
    .limit(200);
  const out: (Proposal & { canDecide: boolean })[] = [];
  for (const r of rows) out.push({ ...r, canDecide: r.status === "pending" && (await mayDecide(db, actorId, r)) });
  return out;
}

/**
 * Accepts or rejects a proposal. Accepting applies the proposed text only if
 * the current text is still the one the diff was made against (else the
 * proposal is stale). This is the only way learned context changes
 * instructions or the org context.
 */
export async function decideProposal(
  db: Database,
  actorId: string,
  orgId: string,
  proposalId: string,
  decision: "accept" | "reject",
  options: { finalText?: string } = {},
): Promise<Proposal> {
  const [p] = await db
    .select()
    .from(contextProposals)
    .where(and(eq(contextProposals.id, proposalId), eq(contextProposals.orgId, orgId)));
  if (!p) throw new NotFoundError("Proposal not found");
  if (!(await mayDecide(db, actorId, p)))
    throw new ForbiddenError("Only the agent's owner or an admin can decide this");
  if (p.status !== "pending") throw new ConflictError("This proposal was already decided");
  // A person may adjust the text before accepting; it still can't carry secrets or permission rules.
  const finalText = options.finalText ?? p.proposedText;
  if (options.finalText !== undefined) checkContent(options.finalText);
  const decided = await db.transaction(async (tx) => {
    let status: Proposal["status"] = decision === "accept" ? "accepted" : "rejected";
    if (decision === "accept") {
      if (p.target === "agent_instructions" && p.agentId) {
        const [agent] = await tx.select().from(agents).where(eq(agents.id, p.agentId)).for("update");
        if (!agent || sha256(agent.instructions) !== p.baseHash) status = "stale";
        else
          await tx
            .update(agents)
            .set({ instructions: finalText, updatedAt: new Date() })
            .where(eq(agents.id, p.agentId));
      } else {
        const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId)).for("update");
        if (!org || sha256(org.context) !== p.baseHash) status = "stale";
        else await tx.update(organizations).set({ context: finalText }).where(eq(organizations.id, orgId));
      }
    }
    const [row] = await tx
      .update(contextProposals)
      .set({
        status,
        decidedByUserId: actorId,
        decidedAt: new Date(),
        ...(status === "accepted" ? { proposedText: finalText } : {}),
      })
      .where(eq(contextProposals.id, proposalId))
      .returning();
    if (!row) throw new Error("proposal update returned nothing");
    return row;
  });
  if (decided.status === "stale")
    throw new ConflictError("The text changed since this was proposed; it can't be applied");
  return decided;
}

/**
 * A proposal an agent makes because a person asked it to change its
 * instructions or the org context in conversation. The agent never edits
 * them directly; this goes through the same human gate. Returns the proposal
 * and whether the requester can accept it inline.
 */
export async function proposeChange(
  deps: { db: Database; pubsub?: PubSub },
  input: {
    orgId: string;
    agentId: string;
    target: "agent_instructions" | "org_context";
    change: string;
    rationale: string;
    requesterId: string;
  },
): Promise<{ proposal: Proposal; canDecide: boolean }> {
  const { db } = deps;
  checkContent(input.change);
  let current: string;
  if (input.target === "agent_instructions") {
    const agent = await getAgent(db, input.orgId, input.agentId);
    if (!agent) throw new NotFoundError("Agent not found");
    current = agent.instructions;
  } else {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, input.orgId));
    if (!org) throw new NotFoundError("Organization not found");
    current = org.context;
  }
  const proposedText = withLearnedBullet(current, input.change);
  const [proposal] = await db
    .insert(contextProposals)
    .values({
      orgId: input.orgId,
      target: input.target,
      agentId: input.target === "agent_instructions" ? input.agentId : null,
      baseHash: sha256(current),
      proposedText,
      diff: lineDiff(current, proposedText),
      rationale: input.rationale.slice(0, 1000) || "Asked in conversation.",
    })
    .returning();
  if (!proposal) throw new Error("proposal insert returned nothing");
  if (deps.pubsub) {
    for (const userId of await deciders(db, proposal))
      await publishUserEvent(deps.pubsub, proposal.orgId, userId, {
        type: "proposal.created",
        proposalId: proposal.id,
      });
  }
  return { proposal, canDecide: await mayDecide(db, input.requesterId, proposal) };
}
