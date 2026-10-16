import {
  and,
  arrayContained,
  type Database,
  desc,
  type Executor,
  eq,
  inArray,
  isNull,
  or,
  schema,
  sql,
} from "@agenteschat/db";
import { getAgent } from "../agents";
import { caches } from "../cache";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { type Judge, triesToChangePermissions } from "../judge";
import { can, requirePermission } from "../organizations";
import { enqueueIndex, userVisibleChannels } from "../search";
import { type Plan, planConsolidation } from "./judgments";

const { contextItems } = schema;

export type ContextItem = typeof contextItems.$inferSelect;
export type ContextKind = ContextItem["kind"];
export type Evidence = ContextItem["evidence"][number];

// ── Guardrails ───────────────────────────────────────────────────────────────

const SECRET_PATTERNS = [
  /\bsk-[a-z0-9_-]{16,}/i, // Anthropic/OpenAI-style keys
  /\bgh[pousr]_[a-z0-9]{20,}/i, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access keys
  /\bxox[abprs]-[a-z0-9-]{10,}/i, // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(bearer)\s+[a-z0-9._-]{20,}/i,
  /\b(password|senha|passwd|secret|api[_ -]?key|token)\s*[:=]\s*\S{6,}/i,
  /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/, // JWTs
];

/** Memories and context never carry credentials (docs/adr/0017). */
export const looksLikeSecret = (text: string) => SECRET_PATTERNS.some((p) => p.test(text));

/** Refuses content that must never become context: credentials (by their format). */
export function checkContent(text: string) {
  if (looksLikeSecret(text)) throw new ValidationError("This looks like a credential; it can't be stored as context");
}

/**
 * Refuses text that tries to change what agents may do (skip approvals, grant
 * scopes, "you are authorized to…"), in any language: the judge decides.
 * Permissions only ever come from scopes and approvals in the database, so
 * this only keeps such text out of memory; if the judge is unavailable, the
 * text is stored (it can't grant anything anyway).
 */
export async function checkPermissionText(judge: Judge | undefined, orgId: string, text: string) {
  if (!judge || !text.trim()) return;
  const changes = await triesToChangePermissions(judge, { orgId, text }).catch(() => false);
  if (changes) {
    throw new ValidationError(
      "Context can't change permissions or approvals; ask an admin to change scopes instead",
      "context.changes_permissions",
    );
  }
}

/** Like `checkPermissionText`, as a yes/no (jobs skip such text instead of failing). */
export async function changesPermissions(judge: Judge | undefined, orgId: string, text: string) {
  if (!judge || !text.trim()) return false;
  return triesToChangePermissions(judge, { orgId, text }).catch(() => false);
}

// ── Evidence ─────────────────────────────────────────────────────────────────

export const EVIDENCE_WEIGHT: Record<Evidence["type"], number> = { outcome: 4, human: 3, agent: 2, self: 1 };

/**
 * Verified = backed by an observed outcome or a person. Claims by agents
 * (another agent's or the subject's own) never verify a lesson, however many
 * agents agree.
 */
export const isVerified = (evidence: Evidence[]) => evidence.some((e) => e.type === "outcome" || e.type === "human");

export const evidenceWeight = (evidence: Evidence[]) => Math.max(0, ...evidence.map((e) => EVIDENCE_WEIGHT[e.type]));

/** Merges evidence lists, dropping duplicates (same type and ref). */
export function mergeEvidence(a: Evidence[], b: Evidence[]) {
  const seen = new Set(a.map((e) => `${e.type}:${e.ref}`));
  return [...a, ...b.filter((e) => !seen.has(`${e.type}:${e.ref}`))];
}

// ── Subjects and similarity ──────────────────────────────────────────────────

/** Subject key: lower case, accents and punctuation removed, words sorted. */
export function normalizeSubject(subject: string) {
  return [
    ...new Set(
      subject
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [],
    ),
  ]
    .sort()
    .join(" ")
    .slice(0, 200);
}

const words = (t: string) => new Set(normalizeSubject(t).split(" ").filter(Boolean));

/** Jaccard similarity of the word sets: ≥ 0.8 counts as the same item. */
export function similarity(a: string, b: string) {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 && wb.size === 0) return 1;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / (wa.size + wb.size - inter);
}

export const SAME_ITEM_SIMILARITY = 0.8;

// ── Writing ──────────────────────────────────────────────────────────────────

export interface NewContextItem {
  orgId: string;
  kind: ContextKind;
  scopeType: "thread" | "channel" | "org" | "agent" | "entity";
  scopeId?: string | null;
  agentId?: string | null;
  subject?: string;
  title?: string;
  content: string;
  sourceIds?: string[];
  channelIds?: string[];
  trust?: "high" | "low";
  evidence?: Evidence[];
  confidence?: number;
  pinned?: boolean;
  coversUntil?: Date | null;
  createdByKind?: "job" | "agent" | "person";
  createdById?: string | null;
  /** Items on the same topic kept apart (related, or in conflict) (ADR 0028). */
  relatedIds?: string[];
  /** Contradicted by another item, until a person resolves it. */
  disputed?: boolean;
}

/** Inserts an item (content checked) and enqueues its indexing, in the caller's transaction. */
export async function insertContextItem(tx: Executor, input: NewContextItem): Promise<ContextItem> {
  checkContent(`${input.title ?? ""}\n${input.content}`);
  const evidence = input.evidence ?? [];
  const [row] = await tx
    .insert(contextItems)
    .values({
      orgId: input.orgId,
      kind: input.kind,
      scopeType: input.scopeType,
      scopeId: input.scopeId ?? null,
      agentId: input.agentId ?? null,
      subjectKey: normalizeSubject(input.subject ?? input.title ?? input.content.slice(0, 120)),
      title: (input.title ?? "").slice(0, 300),
      content: input.content.slice(0, 8000),
      sourceIds: input.sourceIds ?? [],
      channelIds: [...new Set(input.channelIds ?? [])],
      trust: input.trust ?? "high",
      // Anything backed only by agent claims stays unverified (no evidence at all: job output, verified by construction).
      // A note is the agent's own reminder, not a claim about the world.
      verified: input.kind === "note" || evidence.length === 0 ? true : isVerified(evidence),
      evidence,
      confidence: Math.min(1, Math.max(0, input.confidence ?? 0.7)),
      pinned: input.pinned ?? false,
      coversUntil: input.coversUntil ?? null,
      createdByKind: input.createdByKind ?? "job",
      createdById: input.createdById ?? null,
      relatedIds: input.relatedIds ?? [],
      disputed: input.disputed ?? false,
    })
    .returning();
  if (!row) throw new Error("context item insert returned nothing");
  await enqueueIndex(tx, { orgId: input.orgId, kind: "context_item", sourceId: row.id });
  caches.contextPresence.delete(`${input.orgId}:`);
  return row;
}

/** Replaces `old` by a new version (history kept: `superseded_by`, archived). */
export async function supersede(tx: Executor, old: ContextItem, next: NewContextItem): Promise<ContextItem> {
  const row = await insertContextItem(tx, next);
  await tx
    .update(contextItems)
    .set({ version: old.version + 1 })
    .where(eq(contextItems.id, row.id));
  await tx
    .update(contextItems)
    .set({ supersededBy: row.id, status: "archived", updatedAt: new Date() })
    .where(eq(contextItems.id, old.id));
  await enqueueIndex(tx, { orgId: old.orgId, kind: "context_item", sourceId: old.id });
  return { ...row, version: old.version + 1 };
}

export type ConsolidateResult = {
  /** `conflicted`: kept apart from an item it contradicts; both linked, one or both disputed (ADR 0028). */
  action: "created" | "merged" | "superseded" | "conflicted";
  item: ContextItem;
  previous?: ContextItem;
};

/**
 * How a write is judged: `judge` keeps permission-bending text out; with
 * `semantic` (the org is in `MEMORY_JUDGE_ORGS`) the judge also says how the
 * item relates to what exists (judgments.ts), else words decide (today's rule).
 */
export interface MemoryJudging {
  judge?: Judge;
  semantic?: boolean;
}

/**
 * Adds a fact, decision, preference or lesson, consolidating with what
 * exists on the same subject in the same scope (same agent for lessons):
 * - near-identical content → merged (evidence united, recurrence +1, confidence max);
 * - different content on the same subject → the new one supersedes the old
 *   (a contradiction keeps history; nothing is deleted silently);
 * - otherwise → created.
 */
export async function consolidateItem(
  db: Database,
  input: NewContextItem,
  judging: MemoryJudging = {},
): Promise<ConsolidateResult> {
  const { judge } = judging;
  await checkPermissionText(judge, input.orgId, `${input.title ?? ""}\n${input.content}`);
  // By meaning first (outside the transaction: the judge is a network call); words when it can't.
  if (judge && judging.semantic) {
    const plan = await planConsolidation(db, judge, input);
    if (plan) {
      const done = await db.transaction((tx) => applyPlan(tx, input, plan));
      if (done) return done;
    }
  }
  const subjectKey = normalizeSubject(input.subject ?? input.title ?? input.content.slice(0, 120));
  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(contextItems)
      .where(
        and(
          eq(contextItems.orgId, input.orgId),
          eq(contextItems.kind, input.kind),
          eq(contextItems.status, "active"),
          isNull(contextItems.supersededBy),
          input.agentId ? eq(contextItems.agentId, input.agentId) : isNull(contextItems.agentId),
          eq(contextItems.scopeType, input.scopeType),
          or(eq(contextItems.subjectKey, subjectKey), sql`${contextItems.content} = ${input.content}`),
        ),
      )
      .orderBy(desc(contextItems.createdAt))
      .limit(1)
      .for("update");
    const old = existing[0];
    if (!old) return { action: "created", item: await insertContextItem(tx, input) };

    if (similarity(old.content, input.content) >= SAME_ITEM_SIMILARITY) {
      return { action: "merged", item: await mergeInto(tx, old, input) };
    }
    const item = await supersede(tx, old, { ...input, subject: input.subject ?? old.subjectKey });
    return { action: "superseded", item, previous: old };
  });
}

/** The same item again: evidence united, recurrence +1, confidence max; low trust is sticky. */
async function mergeInto(tx: Executor, old: ContextItem, input: NewContextItem) {
  checkContent(input.content);
  const evidence = mergeEvidence(old.evidence, input.evidence ?? []);
  const [merged] = await tx
    .update(contextItems)
    .set({
      evidence,
      verified: old.kind === "note" || evidence.length === 0 ? old.verified : isVerified(evidence),
      recurrence: old.recurrence + 1,
      confidence: Math.max(old.confidence, input.confidence ?? 0),
      // Low trust is sticky: one untrusted source taints the item.
      trust: old.trust === "low" || input.trust === "low" ? "low" : "high",
      sourceIds: [...new Set([...old.sourceIds, ...(input.sourceIds ?? [])])],
      channelIds: [...new Set([...old.channelIds, ...(input.channelIds ?? [])])],
      updatedAt: new Date(),
    })
    .where(eq(contextItems.id, old.id))
    .returning();
  if (!merged) throw new Error("merge returned nothing");
  await enqueueIndex(tx, { orgId: old.orgId, kind: "context_item", sourceId: old.id });
  return merged;
}

/** Links `ids` back to `itemId` (both directions), optionally marking them disputed. */
async function linkBack(tx: Executor, ids: string[], itemId: string, disputed = false) {
  if (ids.length === 0) return;
  await tx
    .update(contextItems)
    .set({
      relatedIds: sql`array_append(array_remove(${contextItems.relatedIds}, ${itemId}::uuid), ${itemId}::uuid)`,
      ...(disputed ? { disputed: true } : {}),
      updatedAt: new Date(),
    })
    .where(inArray(contextItems.id, ids));
}

/**
 * Carries out the judge's plan. The target is read again under a row lock:
 * if it changed meanwhile (archived, superseded), returns null and the caller
 * falls back to words.
 */
async function applyPlan(tx: Executor, input: NewContextItem, plan: Plan): Promise<ConsolidateResult | null> {
  if (plan.action === "create") {
    const item = await insertContextItem(tx, { ...input, relatedIds: plan.related });
    await linkBack(tx, plan.related, item.id);
    return { action: "created", item };
  }
  const [target] = await tx
    .select()
    .from(contextItems)
    .where(
      and(eq(contextItems.id, plan.target.id), eq(contextItems.status, "active"), isNull(contextItems.supersededBy)),
    )
    .for("update");
  if (!target) return null;
  if (plan.action === "merge") return { action: "merged", item: await mergeInto(tx, target, input) };
  if (plan.action === "supersede") {
    const item = await supersede(tx, target, { ...input, subject: input.subject ?? target.subjectKey });
    return { action: "superseded", item, previous: target };
  }
  const item = await insertContextItem(tx, {
    ...input,
    relatedIds: [target.id],
    disputed: plan.disputed !== "old",
  });
  await linkBack(tx, [target.id], item.id, plan.disputed !== "new");
  return { action: "conflicted", item, previous: target };
}

// ── Reading and editing (APIs: "What Ada knows") ────────────────────────────

/** Items a person may see: those whose every channel they can read (org-wide ones too). */
export async function listContextItems(
  db: Database,
  actorId: string,
  orgId: string,
  filter: { agentId?: string; kinds?: ContextKind[]; includeArchived?: boolean; limit?: number } = {},
) {
  await requirePermission(db, actorId, orgId, "read");
  const visible = await userVisibleChannels(db, orgId, actorId);
  return db
    .select()
    .from(contextItems)
    .where(
      and(
        eq(contextItems.orgId, orgId),
        filter.agentId ? eq(contextItems.agentId, filter.agentId) : undefined,
        filter.kinds?.length ? inArray(contextItems.kind, filter.kinds) : undefined,
        filter.includeArchived ? undefined : eq(contextItems.status, "active"),
        arrayContained(contextItems.channelIds, visible),
      ),
    )
    .orderBy(desc(contextItems.pinned), desc(contextItems.relevance), desc(contextItems.updatedAt))
    .limit(Math.min(filter.limit ?? 100, 500));
}

/** Agent memories: the agent's owner or admins. Org-wide items: admins (`configure`). */
async function requireEdit(db: Database, actorId: string, item: ContextItem) {
  const membership = await requirePermission(db, actorId, item.orgId, "read");
  if (can(membership.role, "configure")) return;
  if (item.agentId) {
    const agent = await getAgent(db, item.orgId, item.agentId);
    if (agent?.ownerUserId === actorId) return;
  }
  throw new ForbiddenError("Only the agent's owner or an admin can change this");
}

async function loadItem(db: Database, orgId: string, itemId: string) {
  const [row] = await db
    .select()
    .from(contextItems)
    .where(and(eq(contextItems.id, itemId), eq(contextItems.orgId, orgId)));
  if (!row) throw new NotFoundError("Item not found");
  return row;
}

/**
 * A person edits an item: content edits create a new version (history kept),
 * pin and archive change it in place. An edit by a person is human evidence.
 */
export async function editContextItem(
  db: Database,
  actorId: string,
  orgId: string,
  itemId: string,
  input: { content?: string; title?: string; pinned?: boolean; archived?: boolean },
  judge?: Judge,
): Promise<ContextItem> {
  const item = await loadItem(db, orgId, itemId);
  await requireEdit(db, actorId, item);
  if (input.content !== undefined && input.content !== item.content) {
    await checkPermissionText(judge, orgId, `${input.title ?? item.title ?? ""}\n${input.content}`);
  }
  let current = item;
  if (input.content !== undefined && input.content !== item.content) {
    current = await db.transaction((tx) =>
      supersede(tx, item, {
        orgId,
        kind: item.kind,
        scopeType: item.scopeType as NewContextItem["scopeType"],
        scopeId: item.scopeId,
        agentId: item.agentId,
        subject: item.subjectKey,
        title: input.title ?? item.title,
        content: input.content ?? item.content,
        sourceIds: item.sourceIds,
        channelIds: item.channelIds,
        trust: "high",
        evidence: mergeEvidence(item.evidence, [{ type: "human", ref: actorId, at: new Date().toISOString() }]),
        confidence: Math.max(item.confidence, 0.9),
        pinned: input.pinned ?? item.pinned,
        createdByKind: "person",
        createdById: actorId,
      }),
    );
  }
  if (input.pinned !== undefined || input.archived !== undefined) {
    const [row] = await db
      .update(contextItems)
      .set({
        ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
        ...(input.archived !== undefined
          ? { status: input.archived ? ("archived" as const) : ("active" as const) }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(contextItems.id, current.id))
      .returning();
    if (row) current = row;
    await enqueueIndex(db, { orgId, kind: "context_item", sourceId: current.id });
  }
  return current;
}

/** A person deletes an item for good (explicit; automatic jobs only archive or supersede). */
export async function deleteContextItem(db: Database, actorId: string, orgId: string, itemId: string) {
  const item = await loadItem(db, orgId, itemId);
  await requireEdit(db, actorId, item);
  await db.transaction(async (tx) => {
    await tx.delete(contextItems).where(eq(contextItems.id, itemId));
    await enqueueIndex(tx, { orgId, kind: "context_item", sourceId: itemId });
  });
}

/** A person adds a fact or note by hand (org context items need `configure`; agent notes need ownership). */
export async function addContextItemByPerson(
  db: Database,
  actorId: string,
  orgId: string,
  input: { kind: ContextKind; content: string; title?: string; agentId?: string | null; pinned?: boolean },
  judge?: Judge,
) {
  const fake = { orgId, agentId: input.agentId ?? null } as ContextItem;
  await requireEdit(db, actorId, fake);
  await checkPermissionText(judge, orgId, `${input.title ?? ""}\n${input.content}`);
  if (input.agentId && !(await getAgent(db, orgId, input.agentId))) throw new NotFoundError("Agent not found");
  return db.transaction((tx) =>
    insertContextItem(tx, {
      orgId,
      kind: input.kind,
      scopeType: input.agentId ? "agent" : "org",
      scopeId: input.agentId ?? orgId,
      agentId: input.agentId ?? null,
      title: input.title,
      content: input.content,
      pinned: input.pinned,
      trust: "high",
      evidence: [{ type: "human", ref: actorId, at: new Date().toISOString() }],
      confidence: 0.95,
      createdByKind: "person",
      createdById: actorId,
    }),
  );
}

/** Items by id regardless of status (for `expand`). */
export async function getContextItems(db: Database, orgId: string, ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(contextItems)
    .where(and(eq(contextItems.orgId, orgId), inArray(contextItems.id, ids)));
}

/**
 * Undoes a memory change made in conversation (the "desfazer" of the
 * "memory updated" card): a forgotten item comes back, an updated one
 * goes back to its previous version, a newly remembered one is archived.
 * Anyone in the org who can read the item's channels may undo.
 */
export async function revertMemoryChange(db: Database, actorId: string, orgId: string, itemId: string) {
  const item = await loadItem(db, orgId, itemId);
  await requirePermission(db, actorId, orgId, "read");
  const visible = await userVisibleChannels(db, orgId, actorId);
  if (!item.channelIds.every((c) => visible.includes(c))) throw new NotFoundError("Item not found");
  const [previous] = await db
    .select()
    .from(contextItems)
    .where(and(eq(contextItems.orgId, orgId), eq(contextItems.supersededBy, item.id)))
    .orderBy(desc(contextItems.createdAt))
    .limit(1);
  return db.transaction(async (tx) => {
    let restored: ContextItem;
    if (item.status === "archived" && !item.supersededBy) {
      const [row] = await tx
        .update(contextItems)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(contextItems.id, item.id))
        .returning();
      restored = row ?? item;
    } else if (previous) {
      const [row] = await tx
        .update(contextItems)
        .set({ status: "active", supersededBy: null, updatedAt: new Date() })
        .where(eq(contextItems.id, previous.id))
        .returning();
      await tx
        .update(contextItems)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(contextItems.id, item.id));
      restored = row ?? previous;
    } else {
      const [row] = await tx
        .update(contextItems)
        .set({ status: "archived", updatedAt: new Date() })
        .where(eq(contextItems.id, item.id))
        .returning();
      restored = row ?? item;
    }
    for (const id of new Set([item.id, restored.id]))
      await enqueueIndex(tx, { orgId, kind: "context_item", sourceId: id });
    return restored;
  });
}
