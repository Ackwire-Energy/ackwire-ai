import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  desc,
  type Executor,
  eq,
  inArray,
  isNull,
  type SQL,
  schema,
  sql,
} from "@agenteschat/db";
import { type ArtifactDeps, createArtifact } from "./artifacts";
import { audienceError, canTalkTo } from "./audience";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { createAgentRuns } from "./dispatch";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishMessageCreated, publishOrgEvent } from "./events";
import { createIssue } from "./issues";
import { insertMessageWithRuns, type Message, messageView } from "./messages";
import { can, requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { budgetPercent } from "./usage";

const { forumTopics, forumParticipants, channels, channelMembers, messages, agentRuns, usageRecords, agents } = schema;

export type ForumStatus = "open" | "done" | "canceled";
type TopicRow = typeof forumTopics.$inferSelect;

export const FORUM_LIMITS = { maxAgents: 8, maxRounds: 10, defaultRounds: 3, defaultBudgetUsd: 0.5, postChars: 20_000 };

export interface ForumDeps {
  db: Database;
  pubsub?: PubSub;
  /** For the synthesis document. */
  artifacts?: ArtifactDeps;
}

export interface ForumSuggestedIssue {
  title: string;
  description: string;
}

/** The app's `ForumTopic`. */
export interface ForumTopicView {
  id: string;
  title: string;
  goal: string;
  status: ForumStatus;
  round: number;
  rounds: number;
  agentIds: string[];
  userIds: string[];
  createdBy: { type: "person" | "agent"; id: string };
  originChannelId: string | null;
  /** The topic's own channel: subscribe to it for live runs. */
  channelId: string;
  createdAt: string;
  lastActivityAt: string;
  /** Share of the discussion's spend cap used; null without a cap. No money: everyone in the org reads the forum. */
  budgetUsedPercent: number | null;
  activeAgentIds: string[];
  synthesis: { artifactId: string; version: number; suggestedIssues: ForumSuggestedIssue[]; deleted?: boolean } | null;
}

export interface ForumPostView {
  id: string;
  topicId: string;
  round: number;
  author: { type: "person" | "agent"; id: string };
  body: string;
  agentRunId: string | null;
  meta?: Record<string, unknown>;
  createdAt: string;
}

export interface ForumTopicDetail extends ForumTopicView {
  posts: ForumPostView[];
}

/** What each message of a topic's channel carries in `meta.forum`. */
interface ForumMeta {
  topicId: string;
  round: number;
  /** The worker's "your turn" message (hidden from posts). */
  kickoff?: boolean;
  synthesis?: boolean;
}

const forumMeta = (m: { meta: Record<string, unknown> }) => m.meta.forum as ForumMeta | undefined;

// ── Reading ──────────────────────────────────────────────────────────────────

async function participantsOf(db: Database, topicIds: string[]) {
  if (topicIds.length === 0) return [];
  return db
    .select()
    .from(forumParticipants)
    .where(inArray(forumParticipants.topicId, topicIds))
    .orderBy(asc(forumParticipants.position), asc(forumParticipants.createdAt));
}

/** Spend of the topic's runs (nano-USD). */
async function topicCost(db: Executor, channelIds: string[]) {
  if (channelIds.length === 0) return new Map<string, number>();
  const rows = await db
    .select({ channelId: agentRuns.channelId, cost: sql<string>`coalesce(sum(${usageRecords.costNanoUsd}), 0)` })
    .from(usageRecords)
    .innerJoin(agentRuns, eq(agentRuns.id, usageRecords.runId))
    .where(inArray(agentRuns.channelId, channelIds))
    .groupBy(agentRuns.channelId);
  return new Map(rows.map((r) => [r.channelId, Number(r.cost)]));
}

async function views(db: Database, rows: TopicRow[]): Promise<ForumTopicView[]> {
  const parts = await participantsOf(
    db,
    rows.map((r) => r.id),
  );
  const costs = await topicCost(
    db,
    rows.map((r) => r.channelId),
  );
  const running = rows.flatMap((r) => (r.currentRunId ? [r.currentRunId] : []));
  const active = running.length
    ? await db
        .select({ id: agentRuns.id, agentId: agentRuns.agentId })
        .from(agentRuns)
        .where(and(inArray(agentRuns.id, running), inArray(agentRuns.status, ["queued", "running"])))
    : [];
  const fileIds = rows.flatMap((r) => (r.synthesisArtifactId ? [r.synthesisArtifactId] : []));
  const deletedFiles = new Set(
    fileIds.length
      ? (
          await db
            .select({ id: schema.artifacts.id })
            .from(schema.artifacts)
            .where(and(inArray(schema.artifacts.id, fileIds), sql`${schema.artifacts.deletedAt} is not null`))
        ).map((a) => a.id)
      : [],
  );
  return rows.map((r) => {
    const mine = parts.filter((p) => p.topicId === r.id);
    return {
      id: r.id,
      title: r.title,
      goal: r.goal,
      status: r.status as ForumStatus,
      round: Math.max(1, Math.min(r.round, r.maxRounds)),
      rounds: r.maxRounds,
      agentIds: mine.flatMap((p) => (p.agentId ? [p.agentId] : [])),
      userIds: mine.flatMap((p) => (p.userId ? [p.userId] : [])),
      createdBy: { type: r.createdByType as "person" | "agent", id: r.createdById },
      originChannelId: r.originChannelId,
      channelId: r.channelId,
      createdAt: r.createdAt.toISOString(),
      lastActivityAt: r.lastActivityAt.toISOString(),
      budgetUsedPercent: r.budgetNanoUsd === null ? null : budgetPercent(costs.get(r.channelId) ?? 0, r.budgetNanoUsd),
      activeAgentIds: active.filter((a) => a.id === r.currentRunId).map((a) => a.agentId),
      synthesis: r.synthesisArtifactId
        ? {
            artifactId: r.synthesisArtifactId,
            version: r.synthesisVersion ?? 1,
            suggestedIssues: r.suggestedIssues,
            /** The synthesis file was deleted (the app shows "Arquivo removido"). */
            deleted: deletedFiles.has(r.synthesisArtifactId),
          }
        : null,
    };
  });
}

/** Messages of the topic's channel as posts: one per agent run (its messages joined), kickoffs hidden. */
export function postsOf(topicId: string, rows: Message[]): ForumPostView[] {
  const posts: ForumPostView[] = [];
  const byRun = new Map<string, ForumPostView>();
  // Agents' replies carry no forum meta: they belong to the turn (kickoff) before them.
  let current = 0;
  let synthesis = false;
  for (const m of rows) {
    const meta = forumMeta(m);
    if (meta?.kickoff) {
      current = meta.round;
      synthesis = meta.synthesis === true;
      continue;
    }
    const round = meta?.round ?? current;
    if (m.authorType === "agent" && m.agentRunId) {
      const existing = byRun.get(m.agentRunId);
      if (existing) {
        existing.body = `${existing.body}\n\n${m.body}`.trim();
        continue;
      }
    }
    const post: ForumPostView = {
      id: m.id,
      topicId,
      round,
      author: {
        type: m.authorType,
        id: (m.authorType === "person" ? m.authorUserId : m.authorAgentId) ?? "",
      },
      body: m.body,
      agentRunId: m.agentRunId,
      ...(synthesis && m.authorType === "agent" ? { meta: { synthesis: true } } : {}),
      createdAt: m.createdAt.toISOString(),
    };
    if (m.authorType === "agent" && m.agentRunId) byRun.set(m.agentRunId, post);
    posts.push(post);
  }
  return posts;
}

async function loadTopic(db: Database, orgId: string, id: string) {
  const [row] = await db
    .select()
    .from(forumTopics)
    .where(and(eq(forumTopics.id, id), eq(forumTopics.orgId, orgId)));
  if (!row) throw new NotFoundError("Topic not found");
  return row;
}

async function channelMessages(db: Database, orgId: string, channelId: string) {
  const rows = await db
    .select()
    .from(messages)
    .where(and(eq(messages.orgId, orgId), eq(messages.channelId, channelId), isNull(messages.deletedAt)))
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(2000);
  return rows as unknown as Message[];
}

/** Topics of the organization (every member reads the forum). */
export async function listForumTopics(
  db: Database,
  actorId: string,
  orgId: string,
  filters: { status?: ForumStatus; mine?: boolean; agentId?: string } = {},
) {
  await requirePermission(db, actorId, orgId, "read");
  const conditions: (SQL | undefined)[] = [
    eq(forumTopics.orgId, orgId),
    filters.status ? eq(forumTopics.status, filters.status) : undefined,
    filters.mine
      ? sql`(${forumTopics.requesterUserId} = ${actorId} or exists (select 1 from ${forumParticipants} p
          where p.topic_id = ${forumTopics.id} and p.user_id = ${actorId}))`
      : undefined,
    filters.agentId
      ? sql`exists (select 1 from ${forumParticipants} p where p.topic_id = ${forumTopics.id} and p.agent_id = ${filters.agentId}::uuid)`
      : undefined,
  ];
  const rows = await db
    .select()
    .from(forumTopics)
    .where(and(...conditions))
    .orderBy(desc(forumTopics.lastActivityAt))
    .limit(200);
  return views(db, rows);
}

export async function getForumTopic(
  db: Database,
  actorId: string,
  orgId: string,
  id: string,
): Promise<ForumTopicDetail> {
  await requirePermission(db, actorId, orgId, "read");
  return forumTopicDetail(db, orgId, id);
}

/** A topic with its posts, no permission check (callers: the API after its check, agents' tools). */
export async function forumTopicDetail(db: Database, orgId: string, id: string): Promise<ForumTopicDetail> {
  const row = await loadTopic(db, orgId, id);
  const [view] = await views(db, [row]);
  return { ...(view as ForumTopicView), posts: postsOf(row.id, await channelMessages(db, orgId, row.channelId)) };
}

// ── Creating ─────────────────────────────────────────────────────────────────

export interface ForumTopicInput {
  title: string;
  goal: string;
  agentIds: string[];
  userIds?: string[];
  rounds?: number;
  budgetUsd?: number | null;
  deadline?: Date | null;
  ownerAgentId?: string | null;
}

export type ForumCreator =
  | { type: "person"; userId: string }
  /** An agent from a conversation (or a routine): `requesterUserId` is the person behind it. */
  | {
      type: "agent";
      agentId: string;
      requesterUserId: string;
      originChannelId?: string | null;
      originMessageId?: string | null;
    };

const topicEvent = (deps: ForumDeps, orgId: string, event: Record<string, unknown> & { type: string }) =>
  publishOrgEvent(deps.pubsub, { type: "org.broadcast", orgId, event });

/**
 * Opens a topic: its channel (kind `forum`, everyone in the org reads it),
 * participants, and round 1 (queued). Agents must answer the person behind it
 * (D31); at most 8 agents and 10 rounds.
 */
export async function createForumTopic(
  deps: ForumDeps,
  creator: ForumCreator,
  orgId: string,
  input: ForumTopicInput,
): Promise<ForumTopicDetail> {
  const { db } = deps;
  const requester = creator.type === "person" ? creator.userId : creator.requesterUserId;
  await requirePermission(db, requester, orgId, "post");
  const title = input.title.trim().slice(0, 200);
  const goal = input.goal.trim().slice(0, 5000);
  if (!title) throw new ValidationError("Give the topic a title", "forum.title_required");
  if (!goal) throw new ValidationError("Say what the forum should decide or answer", "forum.goal_required");
  const agentIds = [...new Set(input.agentIds)];
  if (agentIds.length === 0) throw new ValidationError("Pick at least one agent", "forum.agents_required");
  if (agentIds.length > FORUM_LIMITS.maxAgents)
    throw new ValidationError("At most 8 agents per topic", "forum.too_many_agents", { max: 8 });
  const rounds = Math.min(FORUM_LIMITS.maxRounds, Math.max(1, Math.round(input.rounds ?? FORUM_LIMITS.defaultRounds)));
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds), isNull(agents.archivedAt)));
  if (rows.length !== agentIds.length)
    throw new ValidationError("An agent isn't in this organization", "forum.unknown_agent");
  for (const a of rows) {
    if (!canTalkTo(a, requester)) throw await audienceError(db, a);
  }
  const userIds = [...new Set([requester, ...(input.userIds ?? [])])];
  const members = await db
    .select({ userId: schema.organizationMembers.userId })
    .from(schema.organizationMembers)
    .where(and(eq(schema.organizationMembers.orgId, orgId), inArray(schema.organizationMembers.userId, userIds)));
  if (members.length !== userIds.length)
    throw new ValidationError("Everyone must be in the organization", "forum.unknown_person");
  const budget = input.budgetUsd === null ? null : Math.round((input.budgetUsd ?? FORUM_LIMITS.defaultBudgetUsd) * 1e9);
  if (budget !== null && budget <= 0)
    throw new ValidationError("The spend cap must be positive", "forum.invalid_budget");
  const ownerAgentId = input.ownerAgentId && agentIds.includes(input.ownerAgentId) ? input.ownerAgentId : null;

  const topic = await db.transaction(async (tx) => {
    const [channel] = await tx
      .insert(channels)
      .values({
        orgId,
        name: `forum-${crypto.randomUUID().slice(0, 12)}`,
        topic: title,
        visibility: "public",
        kind: "forum",
        createdByUserId: requester,
      })
      .returning();
    if (!channel) throw new Error("forum channel insert returned nothing");
    await tx
      .insert(channelMembers)
      .values([
        ...userIds.map((userId) => ({ orgId, channelId: channel.id, userId })),
        ...agentIds.map((agentId) => ({ orgId, channelId: channel.id, agentId })),
      ]);
    const [row] = await tx
      .insert(forumTopics)
      .values({
        orgId,
        channelId: channel.id,
        title,
        goal,
        maxRounds: rounds,
        budgetNanoUsd: budget,
        deadline: input.deadline ?? null,
        createdByType: creator.type,
        createdById: creator.type === "person" ? creator.userId : creator.agentId,
        requesterUserId: requester,
        ownerAgentId,
        originChannelId: creator.type === "agent" ? (creator.originChannelId ?? null) : null,
        originMessageId: creator.type === "agent" ? (creator.originMessageId ?? null) : null,
      })
      .returning();
    if (!row) throw new Error("forum topic insert returned nothing");
    await tx
      .insert(forumParticipants)
      .values([
        ...agentIds.map((agentId, position) => ({ orgId, topicId: row.id, agentId, position })),
        ...userIds.map((userId) => ({ orgId, topicId: row.id, userId })),
      ]);
    await enqueue(tx, {
      orgId,
      kind: "forum.advance",
      payload: { topicId: row.id },
      dedupeKey: `forum.advance:${row.id}:start`,
    });
    await recordAudit(tx, {
      orgId,
      actor: creator.type === "person" ? { type: "person", id: requester } : { type: "agent", id: creator.agentId },
      action: "forum.topic_created",
      target: { type: "forum_topic", id: row.id },
      details: { agents: agentIds, rounds, budgetUsd: budget === null ? null : budget / 1e9 },
    });
    return row;
  });
  caches.channels.delete(`${orgId}:${topic.channelId}`);
  await topicEvent(deps, orgId, { type: "forum.topic.updated", topicId: topic.id, status: "open", round: 0 });
  return getForumTopic(db, requester, orgId, topic.id);
}

// ── People in a topic ────────────────────────────────────────────────────────

async function requireTopicManager(db: Database, actorId: string, orgId: string, topic: TopicRow) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  if (can(membership.role, "manage_agents") || topic.requesterUserId === actorId) return;
  const [p] = await db
    .select({ id: forumParticipants.id })
    .from(forumParticipants)
    .where(and(eq(forumParticipants.topicId, topic.id), eq(forumParticipants.userId, actorId)));
  if (!p) throw new ForbiddenError("Only who opened it, a participant or an admin can do this", "forum.manager_only");
}

/**
 * A person writes in the topic. It always takes priority: the round in
 * progress ends after the current turn, and the next round reads it (or it
 * starts right away when nobody is working). Any member can post.
 */
export async function postInForumAsPerson(
  deps: ForumDeps,
  userId: string,
  orgId: string,
  topicId: string,
  body: string,
): Promise<ForumPostView> {
  const { db } = deps;
  await requirePermission(db, userId, orgId, "post");
  const topic = await loadTopic(db, orgId, topicId);
  if (topic.status !== "open") throw new ValidationError("This topic has ended", "forum.topic_ended");
  const text = body.trim().slice(0, FORUM_LIMITS.postChars);
  if (!text) throw new ValidationError("Escreva algo.");
  // Reading the forum is open to the org; posting adds the person to the topic.
  await db.insert(channelMembers).values({ orgId, channelId: topic.channelId, userId }).onConflictDoNothing();
  await db.insert(forumParticipants).values({ orgId, topicId, userId }).onConflictDoNothing();
  const { message } = await insertMessageWithRuns(
    db,
    {
      orgId,
      channelId: topic.channelId,
      author: { type: "person", userId },
      body: text,
      meta: { forum: { topicId, round: Math.max(1, topic.round) } satisfies ForumMeta },
    },
    { startRuns: false },
  );
  await db
    .update(forumTopics)
    .set({ pendingPerson: true, lastActivityAt: new Date(), updatedAt: new Date() })
    .where(eq(forumTopics.id, topicId));
  await enqueue(db, {
    orgId,
    kind: "forum.advance",
    payload: { topicId },
    dedupeKey: `forum.advance:${topicId}:person:${message.id}`,
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
  const [post] = postsOf(topicId, [message]);
  await topicEvent(deps, orgId, { type: "forum.post.created", topicId, post });
  return post as ForumPostView;
}

/** "Concluir": no new turns; the synthesis comes after the current one. */
export async function concludeForumTopic(deps: ForumDeps, userId: string, orgId: string, topicId: string) {
  const topic = await loadTopic(deps.db, orgId, topicId);
  await requireTopicManager(deps.db, userId, orgId, topic);
  if (topic.status !== "open") throw new ValidationError("This topic has ended", "forum.topic_ended");
  await deps.db
    .update(forumTopics)
    .set({ stopRequested: true, updatedAt: new Date() })
    .where(eq(forumTopics.id, topicId));
  await enqueue(deps.db, {
    orgId,
    kind: "forum.advance",
    payload: { topicId },
    dedupeKey: `forum.advance:${topicId}:conclude`,
  });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "forum.topic_concluded",
    target: { type: "forum_topic", id: topicId },
  });
  return getForumTopic(deps.db, userId, orgId, topicId);
}

/** Ends the discussion with no synthesis. */
export async function cancelForumTopic(deps: ForumDeps, userId: string, orgId: string, topicId: string) {
  const topic = await loadTopic(deps.db, orgId, topicId);
  await requireTopicManager(deps.db, userId, orgId, topic);
  if (topic.status !== "open") throw new ValidationError("This topic has ended", "forum.topic_ended");
  await deps.db
    .update(forumTopics)
    .set({ status: "canceled", phase: "finished", concludedAt: new Date(), updatedAt: new Date() })
    .where(eq(forumTopics.id, topicId));
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "forum.topic_canceled",
    target: { type: "forum_topic", id: topicId },
  });
  await topicEvent(deps, orgId, { type: "forum.topic.updated", topicId, status: "canceled", round: topic.round });
  return getForumTopic(deps.db, userId, orgId, topicId);
}

/** Adds or removes participants (manager of the topic). Agents must answer the topic's person (D31). */
export async function setForumParticipants(
  deps: ForumDeps,
  userId: string,
  orgId: string,
  topicId: string,
  input: { addAgentIds?: string[]; removeAgentIds?: string[]; addUserIds?: string[]; removeUserIds?: string[] },
) {
  const { db } = deps;
  const topic = await loadTopic(db, orgId, topicId);
  await requireTopicManager(db, userId, orgId, topic);
  const requester = topic.requesterUserId ?? userId;
  const add = [...new Set(input.addAgentIds ?? [])];
  if (add.length > 0) {
    const rows = await db
      .select()
      .from(agents)
      .where(and(eq(agents.orgId, orgId), inArray(agents.id, add), isNull(agents.archivedAt)));
    if (rows.length !== add.length)
      throw new ValidationError("An agent isn't in this organization", "forum.unknown_agent");
    for (const a of rows) if (!canTalkTo(a, requester)) throw await audienceError(db, a);
    const current = (await participantsOf(db, [topicId])).filter((p) => p.agentId);
    if (current.length + add.length > FORUM_LIMITS.maxAgents)
      throw new ValidationError("At most 8 agents", "forum.too_many_agents", { max: 8 });
    for (const [i, agentId] of add.entries()) {
      await db
        .insert(forumParticipants)
        .values({ orgId, topicId, agentId, position: current.length + i })
        .onConflictDoNothing();
      await db.insert(channelMembers).values({ orgId, channelId: topic.channelId, agentId }).onConflictDoNothing();
    }
  }
  for (const agentId of input.removeAgentIds ?? []) {
    await db
      .delete(forumParticipants)
      .where(and(eq(forumParticipants.topicId, topicId), eq(forumParticipants.agentId, agentId)));
  }
  const addUsers = [...new Set(input.addUserIds ?? [])];
  if (addUsers.length > 0) {
    const members = await db
      .select({ userId: schema.organizationMembers.userId })
      .from(schema.organizationMembers)
      .where(and(eq(schema.organizationMembers.orgId, orgId), inArray(schema.organizationMembers.userId, addUsers)));
    if (members.length !== addUsers.length)
      throw new ValidationError("Everyone must be in the organization", "forum.unknown_person");
    for (const u of addUsers) {
      await db.insert(forumParticipants).values({ orgId, topicId, userId: u }).onConflictDoNothing();
      await db.insert(channelMembers).values({ orgId, channelId: topic.channelId, userId: u }).onConflictDoNothing();
    }
  }
  for (const u of input.removeUserIds ?? []) {
    await db
      .delete(forumParticipants)
      .where(and(eq(forumParticipants.topicId, topicId), eq(forumParticipants.userId, u)));
  }
  caches.channelMembers.delete(`${orgId}:${topic.channelId}`);
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "forum.participants_changed",
    target: { type: "forum_topic", id: topicId },
    details: input,
  });
  await topicEvent(deps, orgId, { type: "forum.topic.updated", topicId, status: topic.status, round: topic.round });
  return getForumTopic(db, userId, orgId, topicId);
}

// ── The worker: turns, rounds, synthesis ─────────────────────────────────────

const FINISHED = new Set(["done", "failed", "canceled"]);

/**
 * Job `forum.advance`: moves a topic on when nobody is working. Next agent in
 * the round; a new round (early when a person posted); or, after the last
 * round, the budget cap, the deadline or "Concluir", the synthesis by the
 * owner agent. Strictly one run per agent per round, in order; the router
 * is never involved.
 */
export async function advanceForumTopic(deps: ForumDeps, topicId: string, now = new Date()) {
  const { db } = deps;
  type Outcome =
    | { kind: "none" }
    | { kind: "turn" | "synthesis"; topic: TopicRow; agentId: string; round: number }
    | { kind: "finalize"; topic: TopicRow; runId: string };
  // Decide AND start the turn under the topic's row lock, in one transaction: two advances at
  // once (a run that ended and a person's post) must never start two turns.
  const outcome = await db.transaction(async (tx): Promise<Outcome> => {
    const [topic] = await tx.select().from(forumTopics).where(eq(forumTopics.id, topicId)).for("update");
    if (topic?.status !== "open") return { kind: "none" };
    if (topic.currentRunId) {
      const [run] = await tx
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, topic.currentRunId));
      if (run && !FINISHED.has(run.status)) return { kind: "none" }; // someone is working
      if (topic.phase === "synthesizing") {
        // Claim the finalization so it happens once.
        await tx
          .update(forumTopics)
          .set({ phase: "finished", currentRunId: null, updatedAt: new Date() })
          .where(eq(forumTopics.id, topic.id));
        return { kind: "finalize", topic, runId: topic.currentRunId };
      }
    }
    if (topic.phase !== "discussing") return { kind: "none" };
    const requester = topic.requesterUserId;
    if (!requester) {
      await tx.update(forumTopics).set({ status: "canceled", phase: "finished" }).where(eq(forumTopics.id, topic.id));
      return { kind: "none" };
    }
    const parts = (await tx
      .select()
      .from(forumParticipants)
      .where(eq(forumParticipants.topicId, topicId))
      .orderBy(
        asc(forumParticipants.position),
        asc(forumParticipants.createdAt),
      )) as (typeof forumParticipants.$inferSelect)[];
    const agentIds = parts.flatMap((p) => (p.agentId ? [p.agentId] : []));
    const owner = topic.ownerAgentId && agentIds.includes(topic.ownerAgentId) ? topic.ownerAgentId : agentIds[0];

    let next: { kind: "turn" | "synthesis"; agentId: string; round: number; turn: number } | null = null;
    const toSynthesis = () =>
      owner ? { kind: "synthesis" as const, agentId: owner, round: topic.round, turn: topic.turn } : null;
    const spent =
      topic.budgetNanoUsd !== null ? ((await topicCost(tx, [topic.channelId])).get(topic.channelId) ?? 0) : 0;
    if (
      agentIds.length === 0 ||
      topic.stopRequested ||
      (topic.deadline && topic.deadline.getTime() <= now.getTime()) ||
      (topic.budgetNanoUsd !== null && spent >= topic.budgetNanoUsd)
    ) {
      next = toSynthesis();
    } else {
      let round = topic.round;
      let turn = topic.currentRunId ? topic.turn + 1 : topic.turn;
      if (round === 0) {
        round = 1;
        turn = 0;
      } else if (topic.pendingPerson || turn >= agentIds.length) {
        // A person spoke (their post leads the next round), or everyone had their turn.
        round += 1;
        turn = 0;
      }
      next = round > topic.maxRounds ? toSynthesis() : { kind: "turn", agentId: agentIds[turn] as string, round, turn };
    }
    if (!next) {
      await tx.update(forumTopics).set({ status: "done", phase: "finished" }).where(eq(forumTopics.id, topic.id));
      return { kind: "none" };
    }
    const [agent] = await tx
      .select({ handle: agents.handle })
      .from(agents)
      .where(and(eq(agents.id, next.agentId), eq(agents.orgId, topic.orgId)));
    const handle = agent?.handle ?? "agente";
    const isSynthesis = next.kind === "synthesis";
    const body = isSynthesis
      ? `@${handle}, escreva agora a síntese do fórum "${topic.title}" para quem pediu: a decisão ou recomendação, os prós e contras de cada participante, as perguntas em aberto e os próximos passos. No fim, uma seção "## Issues sugeridas" com uma linha por issue: "- Título — descrição". Seja fiel ao que foi dito.`
      : `@${handle}, sua vez na rodada ${next.round} de ${topic.maxRounds} do fórum "${topic.title}". Objetivo: ${topic.goal}\nLeia o que já foi dito, traga sua visão e dados das suas ferramentas, discorde quando tiver motivo e fale com os outros pelo @. Uma resposta por rodada.`;
    // A turn message the worker writes on the person's behalf (hidden from posts), then the run.
    const { message } = await insertMessageWithRuns(
      tx,
      {
        orgId: topic.orgId,
        channelId: topic.channelId,
        author: { type: "person", userId: requester },
        body,
        meta: {
          forum: { topicId: topic.id, round: next.round, kickoff: true, ...(isSynthesis ? { synthesis: true } : {}) },
        },
      },
      { startRuns: false },
    );
    const created = await createAgentRuns(tx, { ...message, hop: 0 }, [next.agentId], "forum");
    await tx
      .update(forumTopics)
      .set({
        round: next.round,
        turn: next.turn,
        phase: isSynthesis ? "synthesizing" : "discussing",
        pendingPerson: false,
        currentRunId: created[0]?.id ?? null,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(forumTopics.id, topic.id));
    return { kind: next.kind, topic, agentId: next.agentId, round: next.round };
  });

  if (outcome.kind === "none") return outcome.kind;
  if (outcome.kind === "finalize") {
    await finalizeSynthesis(deps, outcome.topic, outcome.runId);
    return outcome.kind;
  }
  await topicEvent(deps, outcome.topic.orgId, {
    type: "forum.topic.updated",
    topicId: outcome.topic.id,
    status: "open",
    round: outcome.round,
    phase: outcome.kind === "synthesis" ? "synthesizing" : "discussing",
    activeAgentIds: [outcome.agentId],
  });
  return outcome.kind;
}

/** "- Título — descrição" lines of the "Issues sugeridas" section. */
export function parseSuggestedIssues(markdown: string): ForumSuggestedIssue[] {
  const section = /#+\s*issues sugeridas\s*\n([\s\S]*?)(?:\n#+\s|$)/i.exec(markdown)?.[1] ?? "";
  return section
    .split("\n")
    .map((l) => /^\s*[-*]\s+(.+)$/.exec(l)?.[1]?.trim() ?? "")
    .filter(Boolean)
    .slice(0, 10)
    .map((line) => {
      const [title, ...rest] = line.split(/\s+[—–-]\s+/);
      return { title: (title ?? line).replace(/\*\*/g, "").trim().slice(0, 200), description: rest.join(" — ").trim() };
    });
}

/** The synthesis run finished: its text becomes a Drive document, the topic is done, the origin hears it. */
async function finalizeSynthesis(deps: ForumDeps, topic: TopicRow, runId: string) {
  const { db } = deps;
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  const posted = (await channelMessages(db, topic.orgId, topic.channelId)).filter((m) => m.agentRunId === runId);
  const markdown = posted
    .map((m) => m.body)
    .join("\n\n")
    .trim();
  let artifact: { id: string; version: number } | null = null;
  if (markdown && run && deps.artifacts) {
    const a = await createArtifact(
      deps.artifacts,
      { type: "agent", agentId: run.agentId, channelId: topic.channelId, runId },
      topic.orgId,
      {
        title: `Síntese: ${topic.title}`.slice(0, 200),
        content: { kind: "document", markdown },
      },
    );
    artifact = { id: a.id, version: a.version };
  }
  const suggested = parseSuggestedIssues(markdown);
  await db
    .update(forumTopics)
    .set({
      status: "done",
      phase: "finished",
      currentRunId: null,
      synthesisArtifactId: artifact?.id ?? null,
      synthesisVersion: artifact?.version ?? null,
      suggestedIssues: suggested,
      concludedAt: new Date(),
      lastActivityAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(forumTopics.id, topic.id));
  if (topic.originChannelId && run && artifact) {
    // Back where it was asked: the agent's message with the synthesis card.
    const { message } = await insertMessageWithRuns(
      db,
      {
        orgId: topic.orgId,
        channelId: topic.originChannelId,
        threadId: topic.originMessageId,
        author: { type: "agent", agentId: run.agentId, runId: null, hop: 0 },
        body: `O fórum "${topic.title}" terminou. A síntese está no arquivo abaixo${suggested.length ? `, com ${suggested.length} issue(s) sugerida(s) para aprovar` : ""}.`,
        meta: {
          artifacts: [artifact],
          forumTopicId: topic.id,
          // For the app to say it in the person's language.
          forumConcluded: { topicId: topic.id, title: topic.title, suggestedIssues: suggested.length },
        },
      },
      { startRuns: false },
    ).catch(() => ({ message: null }));
    if (message && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
  }
  await topicEvent(deps, topic.orgId, {
    type: "forum.topic.updated",
    topicId: topic.id,
    status: "done",
    round: topic.round,
  });
}

/**
 * Called when a run in a forum channel ends: its post is announced and the
 * topic moves on (through the outbox, so it survives restarts).
 */
export async function onForumRunFinished(deps: ForumDeps, orgId: string, channelId: string, runId: string) {
  const [topic] = await deps.db
    .select()
    .from(forumTopics)
    .where(and(eq(forumTopics.orgId, orgId), eq(forumTopics.channelId, channelId)));
  if (!topic) return;
  const posted = (await channelMessages(deps.db, orgId, channelId)).filter((m) => m.agentRunId === runId);
  const [post] = postsOf(topic.id, posted);
  if (post) await topicEvent(deps, orgId, { type: "forum.post.created", topicId: topic.id, post });
  await enqueue(deps.db, {
    orgId,
    kind: "forum.advance",
    payload: { topicId: topic.id },
    dedupeKey: `forum.advance:${topic.id}:run:${runId}`,
  });
}

/** An agent's own post outside its turn (`post_in_forum`): once per round, and only in an open topic. */
export async function postInForumAsAgent(
  deps: ForumDeps,
  agentId: string,
  orgId: string,
  topicId: string,
  body: string,
): Promise<ForumPostView> {
  const { db } = deps;
  const topic = await loadTopic(db, orgId, topicId);
  if (topic.status !== "open") throw new ValidationError("This topic has ended", "forum.topic_ended");
  const [participant] = await db
    .select({ id: forumParticipants.id })
    .from(forumParticipants)
    .where(and(eq(forumParticipants.topicId, topicId), eq(forumParticipants.agentId, agentId)));
  if (!participant) throw new ForbiddenError("You aren't in this topic", "forum.not_participant");
  const round = Math.max(1, topic.round);
  const already = postsOf(topicId, await channelMessages(db, orgId, topic.channelId)).some(
    (p) => p.author.type === "agent" && p.author.id === agentId && p.round === round,
  );
  if (already) throw new ValidationError("You already posted this round; wait for the next", "forum.already_posted");
  const text = body.trim().slice(0, FORUM_LIMITS.postChars);
  if (!text) throw new ValidationError("Escreva algo.");
  const { message } = await insertMessageWithRuns(
    db,
    {
      orgId,
      channelId: topic.channelId,
      author: { type: "agent", agentId, runId: null, hop: 0 },
      body: text,
      meta: { forum: { topicId, round } satisfies ForumMeta },
    },
    { startRuns: false },
  );
  await db.update(forumTopics).set({ lastActivityAt: new Date() }).where(eq(forumTopics.id, topicId));
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
  const [post] = postsOf(topicId, [message]);
  await topicEvent(deps, orgId, { type: "forum.post.created", topicId, post });
  return post as ForumPostView;
}

/** The synthesis' suggested issues, created by a person who approves them. */
export async function createForumIssues(
  deps: ForumDeps,
  userId: string,
  orgId: string,
  topicId: string,
  items: ForumSuggestedIssue[],
) {
  const topic = await loadTopic(deps.db, orgId, topicId);
  await requirePermission(deps.db, userId, orgId, "post");
  if (items.length === 0 || items.length > 10)
    throw new ValidationError("Pick 1 to 10 issues", "forum.issue_count", { min: 1, max: 10 });
  const numbers: number[] = [];
  for (const item of items) {
    const issue = await createIssue({ db: deps.db, pubsub: deps.pubsub }, { type: "person", userId }, orgId, {
      title: item.title,
      description: item.description,
      source: { type: "forum", threadId: topic.id },
    });
    numbers.push(issue.number);
  }
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "forum.issues_created",
    target: { type: "forum_topic", id: topicId },
    details: { numbers },
  });
  return { numbers };
}

/** The topic of a forum channel (for the run context), or null. */
export async function forumTopicOfChannel(db: Database, orgId: string, channelId: string) {
  const [row] = await db
    .select()
    .from(forumTopics)
    .where(and(eq(forumTopics.orgId, orgId), eq(forumTopics.channelId, channelId)));
  return row ?? null;
}
