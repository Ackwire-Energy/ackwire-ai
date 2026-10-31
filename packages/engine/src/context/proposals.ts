import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import {
  type AccessLine,
  accessInputOf,
  appHeldBy,
  grantsHash,
  hasApp,
  replaceableGrants,
  setAgentAccess,
  withAccessLines,
} from "../access";
import { type Agent, getAgent, updateAgent } from "../agents";
import { audienceNotice, canTalkTo, talksToAgents } from "../audience";
import { recordAudit } from "../audit";
import { caches } from "../cache";
import { sha256 } from "../crypto";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { publishUserEvent } from "../events";
import type { Judge } from "../judge";
import { can, requirePermission } from "../organizations";
import { enqueue } from "../outbox";
import { maySql } from "../permissions";
import { userVisibleChannels } from "../search";
import { ALL_TOOLS } from "../tools/scopes";
import {
  type ContextItem,
  checkContent,
  checkPermissionText,
  consolidateItem,
  getContextItems,
  itemVisibleIn,
} from "./items";

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
        proposedByAgentId: agentId,
        baseHash: sha256(current),
        proposedText,
        diff: lineDiff(current, proposedText),
        rationale: `Seen ${item.recurrence}× (confidence ${item.confidence.toFixed(2)}, evidence: ${evidence || "none"}).`,
        itemIds: [item.id],
      })
      .returning();
  });
  if (!proposal) return null;
  await announce(deps, [proposal]);
  return proposal;
}

/** Tells who may decide them that proposals wait (one event per person). */
async function announce(deps: { db: Database; pubsub?: PubSub }, proposals: Proposal[]) {
  const [first] = proposals;
  if (!deps.pubsub || !first) return;
  const users = new Set<string>();
  for (const p of proposals) for (const userId of await deciders(deps.db, p)) users.add(userId);
  for (const userId of users)
    await publishUserEvent(deps.pubsub, first.orgId, userId, {
      type: "proposal.created",
      proposalId: first.id,
      proposalIds: proposals.map((p) => p.id),
    });
}

/** Role and access are decided as on the agent's page: by who manages agents (its owner only takes access away). */
const isAgentSetting = (p: Pick<Proposal, "target">) => p.target === "agent_role" || p.target === "agent_access";

/** The agent's owner decides it too: its instructions, or access that only goes away. */
export const ownerDecides = (p: Pick<Proposal, "target" | "access">) =>
  p.target === "agent_instructions" || (p.target === "agent_access" && !p.access?.some((l) => l.on));

/**
 * Who decides: who reviews memory (instructions, org context) or manages agents (role, access), plus the
 * agent's owner when `ownerDecides`.
 */
async function deciders(db: Database, p: Proposal) {
  const key = isAgentSetting(p) ? "manage_agents" : "review_memory";
  const admins = await db
    .select({ userId: organizationMembers.userId })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, p.orgId), maySql(p.orgId, organizationMembers.userId, key)));
  const ids = new Set(admins.map((a) => a.userId));
  if (p.agentId && ownerDecides(p)) {
    const [agent] = await db.select({ owner: agents.ownerUserId }).from(agents).where(eq(agents.id, p.agentId));
    if (agent?.owner) ids.add(agent.owner);
  }
  return [...ids];
}

/**
 * A proposal carries its items' text (the bullet in `proposedText`, the
 * evidence), so outside admins it is only for who may see every item behind
 * it, the same rule as `listContextItems`. An item that is gone counts as hidden.
 */
async function proposalsVisible<T extends Proposal>(db: Database, actorId: string, orgId: string, rows: T[]) {
  const ids = [...new Set(rows.flatMap((r) => r.itemIds))];
  if (ids.length === 0) return rows;
  const visible = await userVisibleChannels(db, orgId, actorId);
  const items = new Map((await getContextItems(db, orgId, ids)).map((i) => [i.id, i]));
  return rows.filter((r) =>
    r.itemIds.every((id) => {
      const item = items.get(id);
      return item !== undefined && itemVisibleIn(item, visible);
    }),
  );
}

async function mayDecide(db: Database, actorId: string, p: Proposal) {
  const membership = await requirePermission(db, actorId, p.orgId, "read");
  if (isAgentSetting(p)) {
    if (can(membership, "manage_agents")) return true;
    return ownerDecides(p) && !!p.agentId && (await getAgent(db, p.orgId, p.agentId))?.ownerUserId === actorId;
  }
  if (can(membership, "review_memory")) return true;
  if (p.target === "agent_instructions" && p.agentId) {
    const agent = await getAgent(db, p.orgId, p.agentId);
    return agent?.ownerUserId === actorId && (await proposalsVisible(db, actorId, p.orgId, [p])).length > 0;
  }
  return false;
}

export async function listProposals(
  db: Database,
  actorId: string,
  orgId: string,
  options: { status?: Proposal["status"]; agentId?: string; ids?: string[] } = {},
) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const all = await db
    .select()
    .from(contextProposals)
    .where(
      and(
        eq(contextProposals.orgId, orgId),
        options.status ? eq(contextProposals.status, options.status) : undefined,
        options.agentId ? eq(contextProposals.agentId, options.agentId) : undefined,
        options.ids ? inArray(contextProposals.id, options.ids) : undefined,
      ),
    )
    // Pending first: decided ones are what the cap leaves out.
    .orderBy(desc(sql`${contextProposals.status} = 'pending'`), desc(contextProposals.createdAt))
    .limit(200);
  const rows = can(membership, "review_memory") ? all : await proposalsVisible(db, actorId, orgId, all);
  const out: (Proposal & { canDecide: boolean })[] = [];
  for (const r of rows) out.push({ ...r, canDecide: r.status === "pending" && (await mayDecide(db, actorId, r)) });
  return out;
}

/**
 * Accepts or rejects a proposal. Accepting applies it only if what it was
 * made against is still there, the agent included (else the proposal is
 * stale). This is the only way learned context changes instructions or the
 * org context. A role or access is applied as the person deciding, through
 * the agent page's own editors, so it never does more than they could there.
 */
export async function decideProposal(
  db: Database,
  actorId: string,
  orgId: string,
  proposalId: string,
  decision: "accept" | "reject",
  options: { finalText?: string; judge?: Judge } = {},
): Promise<Proposal> {
  const [p] = await db
    .select()
    .from(contextProposals)
    .where(and(eq(contextProposals.id, proposalId), eq(contextProposals.orgId, orgId)));
  if (!p) throw new NotFoundError("Proposal not found");
  if (!(await mayDecide(db, actorId, p)))
    throw new ForbiddenError("Only the agent's owner or an admin can decide this");
  if (p.status !== "pending") throw new ConflictError("This proposal was already decided");
  if (options.finalText !== undefined && isAgentSetting(p))
    throw new ValidationError("Only instructions and the workspace context can be edited before accepting");
  // A person may adjust the text before accepting; it still can't carry secrets or permission rules.
  const finalText = options.finalText ?? p.proposedText;
  if (options.finalText !== undefined) {
    checkContent(options.finalText);
    await checkPermissionText(options.judge, orgId, options.finalText);
  }
  const decided = await db.transaction(async (tx) => {
    const as = tx as unknown as Database;
    let status: Proposal["status"] = decision === "accept" ? "accepted" : "rejected";
    if (decision === "accept" && p.target === "org_context") {
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId)).for("update");
      if (!org || sha256(org.context) !== p.baseHash) status = "stale";
      else await tx.update(organizations).set({ context: finalText }).where(eq(organizations.id, orgId));
    } else if (decision === "accept") {
      const [agent] = p.agentId
        ? await tx
            .select()
            .from(agents)
            .where(and(eq(agents.id, p.agentId), isNull(agents.archivedAt), isNull(agents.deletedAt)))
            .for("update")
        : [];
      if (!agent || !(await applied(as, actorId, p, agent, finalText))) status = "stale";
    }
    const [row] = await tx
      .update(contextProposals)
      .set({
        status,
        decidedByUserId: actorId,
        decidedAt: new Date(),
        ...(status === "accepted" ? { proposedText: finalText } : {}),
      })
      .where(and(eq(contextProposals.id, proposalId), eq(contextProposals.status, "pending")))
      .returning();
    // Someone decided it while this waited for the agent: their decision stands.
    if (!row) throw new ConflictError("This proposal was already decided");
    if (status !== "stale")
      await recordAudit(tx, {
        orgId,
        actor: { type: "person", id: actorId },
        action: status === "accepted" ? "proposal.accepted" : "proposal.refused",
        target: p.agentId ? { type: "agent", id: p.agentId } : { type: "organization", id: orgId },
        details: { proposalId: p.id, target: p.target, proposedByAgentId: p.proposedByAgentId },
      });
    // The lesson now lives in the instructions (or the org context): its memory item leaves memory,
    // or the prompt would carry it twice.
    if (status === "accepted" && p.itemIds.length > 0) {
      const promoted = await tx
        .update(contextItems)
        .set({ status: "archived", updatedAt: new Date() })
        .where(
          and(eq(contextItems.orgId, orgId), inArray(contextItems.id, p.itemIds), eq(contextItems.status, "active")),
        )
        .returning({ id: contextItems.id });
      for (const item of promoted)
        await enqueue(tx, { orgId, kind: "search.index", payload: { kind: "context_item", sourceId: item.id } });
    }
    return row;
  });
  if (decided.agentId) caches.agents.delete(`${orgId}:${decided.agentId}`);
  caches.orgs.delete(`${orgId}:`);
  // The editors cleared these inside this transaction: a run reading in between may have cached the old ones.
  if (decided.status === "accepted" && decided.agentId && isAgentSetting(decided)) {
    caches.agents.delete(`${orgId}:team`);
    caches.scopes.deletePrefix(`${orgId}:${decided.agentId}`);
  }
  if (decided.status === "rejected") await recordRefusal(db, actorId, decided);
  if (decided.status === "stale")
    throw new ConflictError("What this was proposed against changed since, so it can't be applied.");
  return decided;
}

/** Applies an accepted change to its agent (locked by the caller); false when what it was made against changed. */
async function applied(db: Database, actorId: string, p: Proposal, agent: Agent, finalText: string) {
  if (p.target === "agent_instructions") {
    if (sha256(agent.instructions) !== p.baseHash) return false;
    await db.update(agents).set({ instructions: finalText, updatedAt: new Date() }).where(eq(agents.id, agent.id));
    return true;
  }
  if (p.target === "agent_role") {
    if (sha256(agent.role) !== p.baseHash) return false;
    await updateAgent(db, actorId, p.orgId, agent.id, { role: p.proposedText });
    return true;
  }
  const grants = await replaceableGrants(db, p.orgId, agent.id);
  if (grantsHash(grants) !== p.baseHash) return false;
  try {
    await setAgentAccess(db, actorId, p.orgId, agent.id, accessInputOf(withAccessLines(grants, p.access ?? [])));
  } catch (error) {
    // An app disconnected since (the editor checks before it writes anything): the row went stale like any other.
    if (error instanceof ValidationError) return false;
    throw error;
  }
  return true;
}

/** What a refused proposal asked for, in a line: its added text, or for another agent's role or access, that. */
async function refusedChange(db: Database, p: Proposal) {
  const lines = (sign: string) =>
    p.diff
      .split("\n")
      .filter((l) => l.startsWith(sign))
      .map((l) => l.slice(1).trim())
      .filter(Boolean)
      .join(" ");
  const target =
    p.agentId && p.proposedByAgentId && p.agentId !== p.proposedByAgentId
      ? await getAgent(db, p.orgId, p.agentId)
      : null;
  const of = target ? `@${target.handle}'s ` : "";
  if (p.target === "agent_role") return `${of}role: ${p.proposedText}`;
  if (p.target === "agent_access")
    return `${of}access: ${(p.access ?? []).map((l) => `${l.label} ${l.on ? "on" : "off"}`).join(", ")}`;
  const change = lines("+") || (lines("-") ? `removing "${lines("-")}"` : "");
  return change && target ? `${change} (in ${of}instructions)` : change;
}

/**
 * A refused proposal becomes a lesson of the agent that proposed it ("don't
 * propose this again"), so it learns from the refusal instead of proposing
 * the same change later. Best effort: the decision stands even if the lesson
 * can't be stored.
 */
async function recordRefusal(db: Database, actorId: string, p: Proposal) {
  const added = (await refusedChange(db, p)).slice(0, 400);
  if (!added) return;
  const agentId = p.proposedByAgentId ?? p.agentId;
  await consolidateItem(db, {
    orgId: p.orgId,
    kind: "lesson",
    scopeType: agentId ? "agent" : "org",
    agentId,
    subject: `refused: ${added.slice(0, 100)}`,
    content: `A person refused this change; don't propose it again: ${added}`,
    trust: "high",
    evidence: [{ type: "human", ref: p.id, at: new Date().toISOString() }],
    confidence: 0.9,
    createdByKind: "person",
    createdById: actorId,
  }).catch(() => {});
}

/** Agents on one card, at most. */
export const CARD_MAX_AGENTS = 25;
/** How much of a text a skipped swap returns, for the agent to retry with the exact words. */
const CURRENT_CHARS = 2000;
/** The editors' own limits (`PATCH …/agents/{id}`, the workspace settings): an accepted text must still save there. */
const TEXT_MAX = { instructions: 50_000, context: 20_000 };

/**
 * `text` with a change: a rule added under "Learned", or `replaces` swapped for `change`, only when it appears
 * exactly once (else null). Removing a whole line (`change` empty) takes the line, its bullet included.
 */
export function changedText(text: string, change: string, replaces?: string): string | null {
  if (replaces === undefined) return withLearnedBullet(text, change);
  const at = text.indexOf(replaces);
  if (at < 0 || text.includes(replaces, at + 1)) return null;
  let start = at;
  let end = at + replaces.length;
  if (!change.trim()) {
    const lineStart = text.lastIndexOf("\n", at - 1) + 1;
    const newline = text.indexOf("\n", end);
    const lineEnd = newline < 0 ? text.length : newline;
    if (/^\s*(?:[-*]\s*)?$/.test(text.slice(lineStart, at)) && !text.slice(end, lineEnd).trim()) {
      start = newline < 0 ? Math.max(0, lineStart - 1) : lineStart;
      end = newline < 0 ? lineEnd : newline + 1;
    }
  }
  return text.slice(0, start) + change + text.slice(end);
}

/**
 * What a card's rows do to the texts, each line once across the card: the lines they put in (each new role is one)
 * and the lines they take out. A swap's own words are only a fragment, so the guards read these instead.
 */
function rowsChange(rows: { target: Proposal["target"]; proposedText: string; diff: string }[]) {
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const r of rows) {
    if (r.target === "agent_role") added.add(r.proposedText);
    else
      for (const line of r.diff.split("\n")) {
        if (!line.slice(1).trim()) continue;
        if (line.startsWith("+")) added.add(line.slice(1));
        else if (line.startsWith("-")) removed.add(line.slice(1));
      }
  }
  return { added: [...added], removed: [...removed] };
}

/** The agents a card changes: active ones the person who asked can talk to (the proposer always). */
async function cardAgents(db: Database, orgId: string, ids: string[], proposerId: string, requesterId: string) {
  if (ids.length > CARD_MAX_AGENTS) throw new ValidationError(`At most ${CARD_MAX_AGENTS} agents on one card`);
  const rows = ids.length
    ? await db
        .select()
        .from(agents)
        .where(
          and(eq(agents.orgId, orgId), inArray(agents.id, ids), isNull(agents.archivedAt), isNull(agents.deletedAt)),
        )
    : [];
  if (rows.length !== ids.length) throw new NotFoundError("Agent not found");
  const talks = await talksToAgents(db, orgId, requesterId);
  const out: string[] = [];
  for (const a of rows)
    if (a.id !== proposerId && !canTalkTo(a, requesterId, talks))
      out.push(`@${a.handle}: ${await audienceNotice(db, a)}`);
  if (out.length > 0)
    throw new ForbiddenError(
      `The person who asked can't talk to these agents, so nothing can be proposed for them. ${out.join(" ")}`,
    );
  return new Map(rows.map((a) => [a.id, a]));
}

/**
 * Proposals an agent makes because a person asked it in conversation: a
 * rule added to its own or other agents' instructions or to the org context
 * (or exact text swapped or removed there), and other agents' roles and apps.
 * One row per agent and kind of change, for one card; the agent never edits
 * any of them, a person who may make that change accepts each. Only agents
 * the person who asked can talk to; the text is checked once. What can't be
 * proposed is left off, with why in `skipped` (English, for the agent).
 */
export async function proposeChange(
  deps: { db: Database; pubsub?: PubSub; judge?: Judge },
  input: {
    orgId: string;
    /** The agent proposing: the run's. */
    agentId: string;
    target: "agent_instructions" | "org_context";
    /** `agent_instructions`: whose instructions get `change` (the proposer's own when left out). */
    agentIds?: string[];
    /** The rule to add, or what takes the place of `replaces` (empty: removes it). */
    change: string;
    replaces?: string;
    roles?: { agentId: string; role: string }[];
    access?: { agentId: string; lines: AccessLine[] }[];
    rationale: string;
    requesterId: string;
  },
): Promise<{ proposals: (Proposal & { canDecide: boolean })[]; skipped: string[] }> {
  const { db } = deps;
  const { orgId, change, replaces } = input;
  const roles = input.roles ?? [];
  const access = input.access ?? [];
  const base = {
    orgId,
    proposedByAgentId: input.agentId,
    rationale: input.rationale.slice(0, 1000) || "Asked in conversation.",
  };
  const rows: (typeof contextProposals.$inferInsert)[] = [];
  const skipped: string[] = [];
  const textChange = (current: string, what: string, max: number) => {
    const next = changedText(current, change, replaces);
    if (next === null) {
      const where = current.includes(replaces ?? "") ? "appears more than once in" : "isn't in";
      skipped.push(`The text to swap ${where} ${what}. It reads: """${current.slice(0, CURRENT_CHARS)}"""`);
    } else if (next === current) skipped.push(`${what} already says this.`);
    else if (next.length > max) skipped.push(`${what} would pass ${max} characters: shorten them first.`);
    else return { baseHash: sha256(current), proposedText: next, diff: lineDiff(current, next) };
    return null;
  };
  if (input.target === "org_context") {
    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
    if (!org) throw new NotFoundError("Organization not found");
    const text = textChange(org.context, "the org context", TEXT_MAX.context);
    if (text) rows.push({ ...base, target: "org_context", agentId: null, ...text });
  } else {
    const instructed = input.agentIds ?? [input.agentId];
    const ids = [...new Set([...instructed, ...roles.map((r) => r.agentId), ...access.map((a) => a.agentId)])];
    const team = await cardAgents(db, orgId, ids, input.agentId, input.requesterId);
    for (const id of ids) {
      const agent = team.get(id) as Agent;
      const who = `@${agent.handle}`;
      if (instructed.includes(id)) {
        const text = textChange(agent.instructions, `${who}'s instructions`, TEXT_MAX.instructions);
        if (text) rows.push({ ...base, target: "agent_instructions", agentId: id, ...text });
      }
      const role = roles
        .filter((r) => r.agentId === id)
        .at(-1)
        ?.role.trim();
      if (role === agent.role) skipped.push(`${who}'s role is already "${role}".`);
      else if (role)
        rows.push({
          ...base,
          target: "agent_role",
          agentId: id,
          baseHash: sha256(agent.role),
          proposedText: role,
          diff: lineDiff(agent.role, role),
        });
      const lines = [
        ...new Map(access.filter((a) => a.agentId === id).flatMap((a) => a.lines.map((l) => [l.id, l]))).values(),
      ];
      if (lines.length === 0) continue;
      if (id === input.agentId) {
        skipped.push(`Your own apps aren't proposed here: ask for one with request_permission.`);
        continue;
      }
      const grants = await replaceableGrants(db, orgId, id);
      const changing = lines.filter((l) => {
        const same = hasApp(grants, l.id, !l.on) === l.on;
        if (same) skipped.push(`${who} already has ${l.label} ${l.on ? "on" : "off"}.`);
        return !same;
      });
      const after = withAccessLines(grants, changing);
      const kept = changing.filter((l) => {
        const via = l.on ? null : appHeldBy(after, l.id);
        if (via)
          skipped.push(
            `${who} would keep ${l.label} through ${via === ALL_TOOLS ? "every tool being on" : via}: that is changed on its Access tab.`,
          );
        return !via;
      });
      if (kept.length > 0)
        rows.push({
          ...base,
          target: "agent_access",
          agentId: id,
          baseHash: grantsHash(grants),
          proposedText: "",
          diff: "",
          access: kept,
        });
    }
  }
  if (rows.length === 0) return { proposals: [], skipped };
  const { added, removed } = rowsChange(rows);
  checkContent(added.join("\n"));
  await checkPermissionText(deps.judge, orgId, [...added, ...removed.map((l) => `Removes: ${l}`)].join("\n"));
  const proposals = await db.insert(contextProposals).values(rows).returning();
  await announce(deps, proposals);
  const out: (Proposal & { canDecide: boolean })[] = [];
  for (const p of proposals) out.push({ ...p, canDecide: await mayDecide(db, input.requesterId, p) });
  return { proposals: out, skipped };
}
