import {
  and,
  arrayContained,
  type Database,
  desc,
  type Executor,
  eq,
  gt,
  inArray,
  isNull,
  like,
  ne,
  or,
  schema,
  sql,
} from "@agenteschat/db";
import { setsCredential } from "@agenteschat/ui/names";
import { getAgent } from "../agents";
import { agentIdsSeen, isPlaybook, readsPlaybook, seesAgentDetails } from "../audience";
import { caches } from "../cache";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { type Judge, triesToChangePermissions } from "../judge";
import { can, type Membership, requirePermission } from "../organizations";
import { enqueueIndex, userVisibleChannels } from "../search";
import { type Plan, planConsolidation } from "./judgments";

const { agentActions, agents, contextItems } = schema;

export type ContextItem = typeof contextItems.$inferSelect;
export type ContextKind = ContextItem["kind"];
export type Evidence = ContextItem["evidence"][number];

// ── Guardrails ───────────────────────────────────────────────────────────────

/** Keys by their format. */
const KEY_FORMATS = [
  /\bsk-[a-z0-9_-]{16,}/i, // Anthropic/OpenAI-style keys
  /\bgh[pousr]_[a-z0-9]{20,}/i, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access keys
  /\bxox[abprs]-[a-z0-9-]{10,}/i, // Slack tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(bearer)\s+[a-z0-9._-]{20,}/i,
  /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/, // JWTs
];
const SECRET_PATTERNS = [...KEY_FORMATS, /\b(password|senha|passwd|secret|api[_ -]?key|token)\s*[:=]\s*\S{6,}/i];

/** Memories and context never carry credentials (docs/adr/0017). */
export const looksLikeSecret = (text: string) => SECRET_PATTERNS.some((p) => p.test(text));

/** How much of a file is read as text for credentials; past it, only a private key's header is looked for. */
const FILE_SCAN_BYTES = 8 * 1024 * 1024;
const PRIVATE_KEY = /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * A file that holds credentials, whatever its name or type: a private key's header anywhere in its bytes (PEM, PGP),
 * or a key or a password set in what reads as UTF-8 text (`setsCredential`: never a placeholder or code).
 */
export function holdsSecret(bytes: Uint8Array): boolean {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = buf.indexOf("-----BEGIN "); at >= 0; at = buf.indexOf("-----BEGIN ", at + 1)) {
    if (PRIVATE_KEY.test(buf.toString("latin1", at, at + 64))) return true;
  }
  if (bytes.byteLength > FILE_SCAN_BYTES) return false;
  try {
    const text = utf8.decode(bytes);
    return KEY_FORMATS.some((p) => p.test(text)) || setsCredential(text);
  } catch {
    return false;
  }
}

/** Refuses content that must never become context: credentials (by their format). */
export function checkContent(text: string) {
  if (looksLikeSecret(text))
    throw new ValidationError("This looks like a credential, so it can't be stored as context.");
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
      "Context can't change permissions or approvals. Ask an admin to change scopes instead.",
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

export const EVIDENCE_WEIGHT: Record<Evidence["type"], number> = { outcome: 4, human: 3, agent: 2, app: 2, self: 1 };

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

/**
 * The word a how-to's subject key carries (`howToSubject`). Edits keep the subject key, so a how-to stays one whoever
 * edits it, and no other note becomes one by who wrote it.
 */
export const HOW_TO_WORD = "howto";
export const howToSubject = (title: string) => `${HOW_TO_WORD} ${title}`;
export const isHowTo = (i: Pick<ContextItem, "kind" | "subjectKey">) =>
  i.kind === "note" && i.subjectKey.split(" ").includes(HOW_TO_WORD);
/**
 * What a chat receipt for a saved memory says: its plain title, or a person's own words. An agent's untitled finding
 * has none (its text may be technical): it gets no receipt and stays in the Memory tab.
 */
export const receiptLine = (i: Pick<ContextItem, "title" | "content" | "createdByKind">) =>
  i.title.trim() || (i.createdByKind === "person" ? i.content : "");
export const howToSql = () =>
  sql`(${contextItems.kind} = 'note' and ${HOW_TO_WORD} = any(string_to_array(${contextItems.subjectKey}, ' ')))`;

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
  /** `person`: a person's preference (`scopeId` their user id), read only in runs they are behind (ADR 0120). */
  scopeType: "thread" | "channel" | "org" | "agent" | "entity" | "person";
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
      // A note is the agent's own reminder, not a claim about the world. Low trust never verifies (ADR 0120).
      verified:
        input.trust === "low" ? false : input.kind === "note" || evidence.length === 0 ? true : isVerified(evidence),
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
  /**
   * `outweighed`: it contradicts an item with stronger evidence, so that one stays current
   * (`item`) and the new one is kept only as history (`previous`) (ADR 0028).
   */
  /** `disputed`: it contradicts an item it may not replace (`mayReplace`); both stay, marked disputed. */
  action: "created" | "merged" | "superseded" | "outweighed" | "disputed";
  item: ContextItem;
  previous?: ContextItem;
};

/**
 * How a write is judged: `judge` keeps permission-bending text out; with
 * `semantic` (every organization, `memoryJudging`) the judge also says how the
 * item relates to what exists (judgments.ts); without it words decide.
 */
export interface MemoryJudging {
  judge?: Judge;
  semantic?: boolean;
  /**
   * Whether this write may supersede `old`. No: the new item is kept beside it, both `disputed` until a person
   * decides (the background learning job never silently replaces what a person wrote, ADR 0120).
   */
  mayReplace?: (old: ContextItem) => boolean;
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
      const done = await db.transaction((tx) => applyPlan(tx, input, plan, judging.mayReplace));
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
    if (judging.mayReplace && !judging.mayReplace(old)) return keepBeside(tx, old, input);
    const item = await supersede(tx, old, { ...input, subject: input.subject ?? old.subjectKey });
    return { action: "superseded", item, previous: old };
  });
}

/**
 * A write that may not replace `old`: both stay current, linked and disputed, until a person decides. A low-trust
 * write (read from a page, mail or a connected app) never weakens `old`: only the new one is disputed.
 */
async function keepBeside(tx: Executor, old: ContextItem, input: NewContextItem): Promise<ConsolidateResult> {
  const item = await insertContextItem(tx, {
    ...input,
    subject: input.subject ?? old.subjectKey,
    relatedIds: [old.id],
    disputed: true,
  });
  if (input.trust !== "low") await tx.update(contextItems).set({ disputed: true }).where(eq(contextItems.id, old.id));
  await linkBack(tx, [old.id], item.id);
  return { action: "disputed", item, previous: old };
}

/** The same item again: evidence united, recurrence +1, confidence max; low trust is sticky. */
async function mergeInto(tx: Executor, old: ContextItem, input: NewContextItem) {
  checkContent(input.content);
  const evidence = mergeEvidence(old.evidence, input.evidence ?? []);
  const low = old.trust === "low" || input.trust === "low";
  const [merged] = await tx
    .update(contextItems)
    .set({
      evidence,
      verified: low ? false : old.kind === "note" || evidence.length === 0 ? old.verified : isVerified(evidence),
      recurrence: old.recurrence + 1,
      confidence: Math.max(old.confidence, input.confidence ?? 0),
      // Low trust is sticky: one untrusted source taints the item.
      trust: low ? "low" : "high",
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

/** Links `ids` back to `itemId` (both directions). */
async function linkBack(tx: Executor, ids: string[], itemId: string) {
  if (ids.length === 0) return;
  await tx
    .update(contextItems)
    .set({
      relatedIds: sql`array_append(array_remove(${contextItems.relatedIds}, ${itemId}::uuid), ${itemId}::uuid)`,
      updatedAt: new Date(),
    })
    .where(inArray(contextItems.id, ids));
}

/**
 * Carries out the judge's plan. The target is read again under a row lock:
 * if it changed meanwhile (archived, superseded), returns null and the caller
 * falls back to words.
 */
async function applyPlan(
  tx: Executor,
  input: NewContextItem,
  plan: Plan,
  mayReplace?: MemoryJudging["mayReplace"],
): Promise<ConsolidateResult | null> {
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
  if (mayReplace && !mayReplace(target) && (plan.action === "supersede" || plan.winner === "new"))
    return keepBeside(tx, target, input);
  if (plan.action === "supersede") {
    const item = await supersede(tx, target, { ...input, subject: input.subject ?? target.subjectKey });
    return { action: "superseded", item, previous: target };
  }
  if (plan.winner === "new") {
    const item = await supersede(tx, target, { ...input, subject: input.subject ?? target.subjectKey });
    return { action: "superseded", item, previous: target };
  }
  // The existing item has stronger evidence: the new claim is kept as history behind it.
  const loser = await insertContextItem(tx, { ...input, subject: input.subject ?? target.subjectKey });
  await tx
    .update(contextItems)
    .set({ status: "archived", supersededBy: target.id, relatedIds: [target.id], updatedAt: new Date() })
    .where(eq(contextItems.id, loser.id));
  await linkBack(tx, [target.id], loser.id);
  return { action: "outweighed", item: target, previous: { ...loser, status: "archived", supersededBy: target.id } };
}

// ── Reading and editing (APIs: "What Ada knows") ────────────────────────────

/** A person's preferences: theirs, and who reviews memory. Undefined: every item. */
const preferencesSeenBy = (membership: Membership, actorId: string) =>
  can(membership, "review_memory")
    ? undefined
    : or(ne(contextItems.scopeType, "person"), eq(contextItems.scopeId, actorId));

const seesPreference = (membership: Membership, actorId: string, item: Pick<ContextItem, "scopeType" | "scopeId">) =>
  item.scopeType !== "person" || item.scopeId === actorId || can(membership, "review_memory");

/** Items a person may see: those whose every channel they can read (org-wide ones too). */
export async function listContextItems(
  db: Database,
  actorId: string,
  orgId: string,
  filter: {
    agentId?: string;
    kinds?: ContextKind[];
    includeArchived?: boolean;
    limit?: number;
    /** Who wrote them (`agent`, `job`, `person`): "What it learned" lists the agent's and the jobs' (ADR 0120). */
    createdBy?: ("agent" | "job" | "person")[];
  } = {},
) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const [visible, seen] = await Promise.all([
    userVisibleChannels(db, orgId, actorId),
    agentIdsSeen(db, actorId, orgId),
  ]);
  const rows = await db
    .select()
    .from(contextItems)
    .where(
      and(
        eq(contextItems.orgId, orgId),
        // An agent's memory is part of how it works: only for who sees its details.
        or(isNull(contextItems.agentId), inArray(contextItems.agentId, [...seen.details])),
        preferencesSeenBy(membership, actorId),
        filter.createdBy?.length ? inArray(contextItems.createdByKind, filter.createdBy) : undefined,
        filter.agentId ? eq(contextItems.agentId, filter.agentId) : undefined,
        filter.kinds?.length ? inArray(contextItems.kind, filter.kinds) : undefined,
        filter.includeArchived ? undefined : eq(contextItems.status, "active"),
        arrayContained(contextItems.channelIds, visible),
      ),
    )
    .orderBy(desc(contextItems.pinned), desc(contextItems.relevance), desc(contextItems.updatedAt))
    .limit(Math.min(filter.limit ?? 100, 500));
  return rows.filter((i) => !isPlaybook(i) || seen.playbook.has(i.agentId ?? ""));
}

/** Whether someone who reads `visible` may see an item: every channel it came from (org-wide ones too). */
export const itemVisibleIn = (item: Pick<ContextItem, "channelIds">, visible: readonly string[]) =>
  item.channelIds.every((c) => visible.includes(c));

/**
 * Every version of an agent's items a person may see (archived and superseded
 * included), with the channels they read, for "What Ada knows": the same rule
 * as `listContextItems`, so an item learned in a DM or private channel stays there.
 */
export async function listAgentMemoryRows(db: Database, actorId: string, orgId: string, agentId: string) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const [visible, agent] = await Promise.all([userVisibleChannels(db, orgId, actorId), getAgent(db, orgId, agentId)]);
  const rows = await db
    .select()
    .from(contextItems)
    .where(
      and(
        eq(contextItems.orgId, orgId),
        eq(contextItems.agentId, agentId),
        preferencesSeenBy(membership, actorId),
        arrayContained(contextItems.channelIds, visible),
      ),
    );
  const playbook = !!agent && readsPlaybook(agent, actorId, membership);
  return { items: rows.filter((i) => playbook || !isPlaybook(i)), visible };
}

/**
 * What all the agents know, for a map of the workspace's memory: the current items of agents still here, under the
 * same rule as `listAgentMemoryRows`, most recently changed first.
 */
export async function listOrgMemoryRows(db: Database, actorId: string, orgId: string, limit = 300) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const visible = await userVisibleChannels(db, orgId, actorId);
  const rows = await db
    .select({ item: contextItems, agent: agents })
    .from(contextItems)
    .innerJoin(agents, and(eq(agents.id, contextItems.agentId), isNull(agents.archivedAt)))
    .where(
      and(
        eq(contextItems.orgId, orgId),
        eq(contextItems.status, "active"),
        isNull(contextItems.supersededBy),
        preferencesSeenBy(membership, actorId),
        arrayContained(contextItems.channelIds, visible),
      ),
    )
    .orderBy(desc(contextItems.updatedAt))
    .limit(limit);
  // An agent's memory is part of how it works: only for who sees its details.
  const items = rows
    .filter(
      (r) =>
        seesAgentDetails(r.agent, actorId, membership) &&
        (!isPlaybook(r.item) || readsPlaybook(r.agent, actorId, membership)),
    )
    .map((r) => r.item);
  return { items, visible };
}

/**
 * Agent memories: the agent's owner or admins. Org-wide items: admins (`configure`).
 * An owner who isn't an admin changes only items they can see (the edit answers
 * with the content); to them the others don't exist.
 */
async function requireEdit(db: Database, actorId: string, item: ContextItem) {
  const membership = await requirePermission(db, actorId, item.orgId, "read");
  if (can(membership, "review_memory")) return;
  if (item.agentId) {
    const agent = await getAgent(db, item.orgId, item.agentId);
    if (agent?.ownerUserId === actorId) {
      if (item.channelIds?.length && !itemVisibleIn(item, await userVisibleChannels(db, item.orgId, actorId)))
        throw new NotFoundError("Item not found");
      return;
    }
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
        // A summary of the old text would sit above the new one: kept only when the person edited it too.
        title: input.title ?? "",
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
  // Saving an app-sent item's text unchanged is a person confirming it (ADR 0119 item 5).
  const confirms =
    input.content !== undefined &&
    current === item &&
    item.trust !== "low" &&
    item.evidence.some((e) => e.type === "app") &&
    !isVerified(item.evidence);
  if (confirms || input.pinned !== undefined || input.archived !== undefined) {
    const evidence = confirms
      ? mergeEvidence(item.evidence, [{ type: "human", ref: actorId, at: new Date().toISOString() }])
      : undefined;
    const [row] = await db
      .update(contextItems)
      .set({
        ...(evidence ? { evidence, verified: true, confidence: Math.max(item.confidence, 0.9) } : {}),
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

/**
 * A person adds a fact or note by hand (org context items need `configure`; agent notes need ownership). `viaApp`:
 * the text came through a connected AI app (ADR 0119), so it is outside content: only an agent's own memory, kept
 * high trust for that agent but unverified, which keeps it out of every promotion until a person confirms it.
 */
export async function addContextItemByPerson(
  db: Database,
  actorId: string,
  orgId: string,
  input: {
    kind: ContextKind;
    content: string;
    title?: string;
    agentId?: string | null;
    pinned?: boolean;
    viaApp?: boolean;
  },
  judge?: Judge,
) {
  if (input.viaApp && !input.agentId) throw new ValidationError("An app writes only an agent's own memory");
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
      evidence: [{ type: input.viaApp ? "app" : "human", ref: actorId, at: new Date().toISOString() }],
      confidence: input.viaApp ? 0.8 : 0.95,
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
 * Who may edit it (`requireEdit`), or the person an agent changed it for,
 * while that change's undo window is open. Someone else's preference is
 * not found unless they review memory.
 */
export async function revertMemoryChange(
  db: Database,
  actorId: string,
  orgId: string,
  itemId: string,
  now = new Date(),
) {
  const item = await loadItem(db, orgId, itemId);
  const membership = await requirePermission(db, actorId, orgId, "read");
  const visible = await userVisibleChannels(db, orgId, actorId);
  if (!itemVisibleIn(item, visible) || !seesPreference(membership, actorId, item))
    throw new NotFoundError("Item not found");
  const [asked] = await db
    .select({ id: agentActions.id })
    .from(agentActions)
    .where(
      and(
        eq(agentActions.orgId, orgId),
        eq(agentActions.targetType, "memory"),
        eq(agentActions.targetId, item.id),
        like(agentActions.kind, "memory.%"),
        eq(agentActions.requestedByUserId, actorId),
        gt(agentActions.undoableUntil, now),
      ),
    )
    .limit(1);
  if (!asked) await requireEdit(db, actorId, item);
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
