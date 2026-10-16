import { and, asc, eq, inArray, isNull, lt, or, schema, sql } from "@agenteschat/db";
import { enqueue } from "../outbox";
import {
  type ContextItem,
  isVerified,
  mergeEvidence,
  type NewContextItem,
  SAME_ITEM_SIMILARITY,
  similarity,
} from "./items";
import { decide, findCandidates, judgeRelations, memoryJudgeEnabled } from "./judgments";
import { proposeFromItem } from "./proposals";
import { REFLECT_DEFAULTS } from "./reflect";
import { type ContextDeps, ensurePeriodSummary, judgeOf } from "./summaries";

const { contextItems, messages, threadReflections, channels } = schema;

/** Relevance decays this much per run for items unused in a week; archived below the floor after a month. */
export const DECAY = { factor: 0.95, unusedDays: 7, archiveBelow: 0.1, archiveAfterDays: 30 };

/**
 * Periodic job `context.consolidate` per organization:
 * 1. dedupe near-identical active items in the same scope (the older keeps
 *    the evidence of both; the newer is archived, pointing at it);
 * 1b. by meaning (ADR 0028, Jev only): items written or changed since the
 *    last runs are compared with their neighbours, as on write, so what the
 *    write missed (an item written before its twin, a judge that was down)
 *    is settled here;
 * 2. decay the relevance of unused items and archive stale ones (pinned items
 *    never decay; archived ones stay reachable through `expand`);
 * 3. refresh last week's period summaries of busy channels;
 * 4. propose promotions for items that became strong enough.
 */
export async function consolidateOrg(deps: ContextDeps, orgId: string, now = new Date()) {
  const { db } = deps;
  let merged = 0;
  const active = await db
    .select()
    .from(contextItems)
    .where(and(eq(contextItems.orgId, orgId), eq(contextItems.status, "active"), isNull(contextItems.supersededBy)))
    .orderBy(asc(contextItems.createdAt));
  const groups = new Map<string, typeof active>();
  for (const item of active) {
    if (item.kind === "thread_summary" || item.kind === "period_summary" || item.kind === "entity_profile") continue;
    const key = `${item.kind}|${item.agentId ?? ""}|${item.scopeType}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const archived = new Set<string>();
  for (const items of groups.values()) {
    for (let i = 0; i < items.length; i++) {
      const keep = items[i];
      if (!keep || archived.has(keep.id)) continue;
      for (let j = i + 1; j < items.length; j++) {
        const dup = items[j];
        if (!dup || archived.has(dup.id) || similarity(keep.content, dup.content) < SAME_ITEM_SIMILARITY) continue;
        const evidence = mergeEvidence(keep.evidence, dup.evidence);
        await db.transaction(async (tx) => {
          await tx
            .update(contextItems)
            .set({
              evidence,
              verified: evidence.length === 0 ? keep.verified : isVerified(evidence),
              recurrence: keep.recurrence + dup.recurrence,
              confidence: Math.max(keep.confidence, dup.confidence),
              relevance: Math.max(keep.relevance, dup.relevance),
              trust: keep.trust === "low" || dup.trust === "low" ? "low" : "high",
              sourceIds: [...new Set([...keep.sourceIds, ...dup.sourceIds])],
              updatedAt: now,
            })
            .where(eq(contextItems.id, keep.id));
          await tx
            .update(contextItems)
            .set({ status: "archived", supersededBy: keep.id, updatedAt: now })
            .where(eq(contextItems.id, dup.id));
          for (const id of [keep.id, dup.id])
            await enqueue(tx, { orgId, kind: "search.index", payload: { kind: "context_item", sourceId: id } });
        });
        keep.recurrence += dup.recurrence;
        keep.evidence = evidence;
        archived.add(dup.id);
        merged++;
      }
    }
  }

  const judged = await consolidateByMeaning(deps, orgId, now).catch(() => ({ moved: 0, linked: 0 }));
  merged += judged.moved;

  const unusedSince = new Date(now.getTime() - DECAY.unusedDays * 86_400_000);
  await db
    .update(contextItems)
    .set({ relevance: sql`${contextItems.relevance} * ${DECAY.factor}` })
    .where(
      and(
        eq(contextItems.orgId, orgId),
        eq(contextItems.status, "active"),
        eq(contextItems.pinned, false),
        or(
          lt(contextItems.lastUsedAt, unusedSince),
          and(isNull(contextItems.lastUsedAt), lt(contextItems.createdAt, unusedSince)),
        ),
      ),
    );
  const stale = await db
    .update(contextItems)
    .set({ status: "archived", updatedAt: now })
    .where(
      and(
        eq(contextItems.orgId, orgId),
        eq(contextItems.status, "active"),
        eq(contextItems.pinned, false),
        lt(contextItems.relevance, DECAY.archiveBelow),
        lt(contextItems.createdAt, new Date(now.getTime() - DECAY.archiveAfterDays * 86_400_000)),
      ),
    )
    .returning({ id: contextItems.id });
  for (const s of stale)
    await enqueue(db, { orgId, kind: "search.index", payload: { kind: "context_item", sourceId: s.id } });

  // Last week's summary per channel that was busy (≥ 30 messages).
  const weekStart = new Date(now.getTime() - 7 * 86_400_000);
  const busy = await db
    .select({ channelId: messages.channelId, n: sql<number>`count(*)::int` })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(
      and(
        eq(messages.orgId, orgId),
        sql`${messages.createdAt} >= ${weekStart.toISOString()}::timestamptz`,
        isNull(channels.archivedAt),
      ),
    )
    .groupBy(messages.channelId);
  for (const c of busy.filter((b) => b.n >= 30)) {
    await ensurePeriodSummary(deps, orgId, c.channelId, { from: weekStart, to: now }).catch(() => null);
  }

  let proposals = 0;
  const candidates = await db
    .select()
    .from(contextItems)
    .where(
      and(
        eq(contextItems.orgId, orgId),
        eq(contextItems.status, "active"),
        isNull(contextItems.proposedAt),
        eq(contextItems.trust, "high"),
        eq(contextItems.verified, true),
        inArray(contextItems.kind, ["lesson", "preference", "decision", "fact"]),
      ),
    );
  for (const item of candidates) if (await proposeFromItem(deps, item)) proposals++;
  return { merged, archived: stale.length, proposals, linked: judged.linked };
}

/** Items re-judged per org and run, and how far back "recent" goes (a missed day is caught up). */
export const DAILY_JUDGING = { maxItems: 100, sinceDays: 2 };

const SUMMARY_KINDS = new Set(["thread_summary", "period_summary", "entity_profile"]);

/** An existing item as if it were being written now (the newer side of each comparison). */
const asNew = (item: ContextItem): NewContextItem => ({
  orgId: item.orgId,
  kind: item.kind,
  scopeType: item.scopeType as NewContextItem["scopeType"],
  scopeId: item.scopeId,
  agentId: item.agentId,
  subject: item.subjectKey,
  title: item.title ?? undefined,
  content: item.content,
  channelIds: item.channelIds,
  evidence: item.evidence,
  trust: item.trust as NewContextItem["trust"],
  confidence: item.confidence,
});

/**
 * The daily pass by meaning: each recent item against its older neighbours
 * (pairs already linked are skipped), with the write's policy (`decide`).
 * One move per item; the loser is archived pointing at the winner, so
 * history stays and a person can bring it back. Needs Jev (calibrated
 * requests): without it nothing happens here.
 */
export async function consolidateByMeaning(deps: ContextDeps, orgId: string, now = new Date()) {
  const out = { moved: 0, linked: 0 };
  if (!memoryJudgeEnabled(deps.memoryJudgeOrgs, orgId)) return out;
  const { db } = deps;
  const judge = judgeOf(deps);
  const since = new Date(now.getTime() - DAILY_JUDGING.sinceDays * 86_400_000);
  const recent = await db
    .select()
    .from(contextItems)
    .where(
      and(
        eq(contextItems.orgId, orgId),
        eq(contextItems.status, "active"),
        isNull(contextItems.supersededBy),
        sql`${contextItems.updatedAt} >= ${since.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(contextItems.updatedAt))
    .limit(DAILY_JUDGING.maxItems);
  const gone = new Set<string>();
  for (const item of recent) {
    if (SUMMARY_KINDS.has(item.kind) || gone.has(item.id)) continue;
    const input = asNew(item);
    const candidates = (await findCandidates(db, input)).filter(
      (c) =>
        c.id !== item.id &&
        !gone.has(c.id) &&
        !item.relatedIds.includes(c.id) &&
        // Each pair once, from its newer side (ties by id).
        (c.createdAt.getTime() < item.createdAt.getTime() ||
          (c.createdAt.getTime() === item.createdAt.getTime() && c.id < item.id)),
    );
    if (candidates.length === 0) continue;
    let plan: ReturnType<typeof decide>;
    try {
      plan = decide(input, await judgeRelations(judge, input, candidates));
    } catch {
      return out; // no Jev (or it's down): try again on the next run
    }
    const touched = await db.transaction(async (tx) => {
      if (plan.action === "create") {
        if (plan.related.length === 0) return [];
        await tx
          .update(contextItems)
          .set({ relatedIds: [...new Set([...item.relatedIds, ...plan.related])] })
          .where(eq(contextItems.id, item.id));
        await tx
          .update(contextItems)
          .set({
            relatedIds: sql`array_append(array_remove(${contextItems.relatedIds}, ${item.id}::uuid), ${item.id}::uuid)`,
          })
          .where(inArray(contextItems.id, plan.related));
        out.linked += plan.related.length;
        return [];
      }
      const target = plan.target;
      // merge: the older keeps both; supersede, or a resolve the newer wins: the newer stays.
      const [winner, loser] =
        plan.action === "merge" || (plan.action === "resolve" && plan.winner === "old")
          ? [target, item]
          : [item, target];
      if (plan.action === "merge") {
        const evidence = mergeEvidence(winner.evidence, loser.evidence);
        await tx
          .update(contextItems)
          .set({
            evidence,
            verified: evidence.length === 0 ? winner.verified : isVerified(evidence),
            recurrence: winner.recurrence + loser.recurrence,
            confidence: Math.max(winner.confidence, loser.confidence),
            relevance: Math.max(winner.relevance, loser.relevance),
            trust: winner.trust === "low" || loser.trust === "low" ? "low" : "high",
            sourceIds: [...new Set([...winner.sourceIds, ...loser.sourceIds])],
            updatedAt: now,
          })
          .where(eq(contextItems.id, winner.id));
      } else {
        await tx
          .update(contextItems)
          .set({ relatedIds: [...new Set([...winner.relatedIds, loser.id])], updatedAt: now })
          .where(eq(contextItems.id, winner.id));
      }
      await tx
        .update(contextItems)
        .set({
          status: "archived",
          supersededBy: winner.id,
          relatedIds: [...new Set([...loser.relatedIds, winner.id])],
          updatedAt: now,
        })
        .where(and(eq(contextItems.id, loser.id), eq(contextItems.status, "active")));
      for (const id of [winner.id, loser.id])
        await enqueue(tx, { orgId, kind: "search.index", payload: { kind: "context_item", sourceId: id } });
      return [loser.id];
    });
    for (const id of touched) gone.add(id);
    out.moved += touched.length;
  }
  return out;
}

/**
 * Periodic sweep (all orgs): enqueue reflection for threads that went idle
 * since their last reflection, within the per-thread cap.
 */
export async function enqueueIdleReflections(deps: ContextDeps, now = new Date()) {
  const cfg = { ...REFLECT_DEFAULTS, ...deps.reflect };
  const idleBefore = new Date(now.getTime() - cfg.idleMinutes * 60_000);
  const lookback = new Date(now.getTime() - 7 * 86_400_000);
  const threads = await deps.db
    .select({
      orgId: messages.orgId,
      threadId: messages.threadId,
      last: sql<string>`max(${messages.createdAt})`,
      n: sql<number>`count(*)::int`,
    })
    .from(messages)
    .where(
      and(sql`${messages.threadId} is not null`, sql`${messages.createdAt} >= ${lookback.toISOString()}::timestamptz`),
    )
    .groupBy(messages.orgId, messages.threadId)
    .having(sql`max(${messages.createdAt}) < ${idleBefore.toISOString()}::timestamptz and count(*) >= 2`)
    .limit(500);
  let queued = 0;
  for (const t of threads) {
    if (!t.threadId) continue;
    const [state] = await deps.db
      .select()
      .from(threadReflections)
      .where(eq(threadReflections.threadRootId, t.threadId));
    if (state && (state.runs >= cfg.maxPerThread || (state.coveredUntil && state.coveredUntil >= new Date(t.last))))
      continue;
    await enqueue(deps.db, {
      orgId: t.orgId,
      kind: "context.reflect",
      payload: { threadRootId: t.threadId },
      dedupeKey: `context.reflect:${t.threadId}:${new Date(t.last).getTime()}`,
    });
    queued++;
  }
  return queued;
}
