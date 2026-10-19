import { and, type Database, desc, type Executor, eq, gt, inArray, isNull, schema, sql } from "@agenteschat/db";
import type { Agent } from "./agents";
import { audienceError, canTalkTo } from "./audience";
import { caches } from "./cache";
import { sha256 } from "./crypto";
import { NotFoundError, ValidationError } from "./errors";
import { type PreviewMeta, previewMeta } from "./message-preview";
import { getMembership, requirePermission } from "./organizations";

const { channels, channelMembers, channelReads, messages, agents, users } = schema;

export type DmTarget = { userId: string } | { agentId: string };

const keyOf = (participants: string[]) => [...new Set(participants)].sort().join("|");

/**
 * Opens a direct conversation with a person or an agent (creates it the
 * first time). A DM is a private channel of kind `dm` with exactly its
 * participants; nobody else can join or read it. In a DM with an agent, the
 * agent answers every message from the person (no router).
 */
export async function openDm(db: Database, actorId: string, orgId: string, target: DmTarget) {
  await requirePermission(db, actorId, orgId, "post");
  let other: string;
  let blockedAgent: Agent | null = null;
  if ("userId" in target) {
    if (target.userId === actorId) throw new ValidationError("Pick someone else");
    if (!(await getMembership(db, target.userId, orgId)))
      throw new NotFoundError("That person is not in this organization");
    other = `u:${target.userId}`;
  } else {
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, target.agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt)));
    if (!agent) throw new NotFoundError("Agent not found");
    if (!canTalkTo(agent, actorId)) blockedAgent = agent;
    other = `a:${target.agentId}`;
  }
  const dmKey = keyOf([`u:${actorId}`, other]);
  const existing = async () =>
    (
      await db
        .select()
        .from(channels)
        .where(and(eq(channels.orgId, orgId), eq(channels.dmKey, dmKey)))
    )[0];
  const found = await existing();
  if (found) {
    if (found.archivedAt) await db.update(channels).set({ archivedAt: null }).where(eq(channels.id, found.id));
    return found;
  }
  // A new DM with an agent this person can't talk to (D31) isn't started; an old one stays readable.
  if (blockedAgent) throw await audienceError(db, blockedAgent);
  const created = await db.transaction(async (tx) => {
    const [channel] = await tx
      .insert(channels)
      .values({
        orgId,
        name: `dm-${sha256(`${orgId}|${dmKey}`).slice(0, 20)}`,
        visibility: "private",
        kind: "dm",
        dmKey,
        createdByUserId: actorId,
      })
      .onConflictDoNothing()
      .returning();
    if (!channel) return null;
    await tx.insert(channelMembers).values({ orgId, channelId: channel.id, userId: actorId });
    await tx
      .insert(channelMembers)
      .values(
        "userId" in target
          ? { orgId, channelId: channel.id, userId: target.userId }
          : { orgId, channelId: channel.id, agentId: target.agentId },
      );
    return channel;
  });
  if ("agentId" in target) caches.scopes.deletePrefix(`${orgId}:${target.agentId}:visible`);
  const channel = created ?? (await existing()); // a concurrent open won the race
  if (!channel) throw new Error("could not open the conversation");
  return channel;
}

/** The DM key of a conversation between two agents (`ask_agent`, ADR 0034): no person in it. */
export const agentDmKey = (a: string, b: string) => keyOf([`a:${a}`, `a:${b}`]);

/** A DM between agents only: no person reads it, so nobody there can answer a question. */
export const isAgentOnlyDm = (channel: { kind: string; dmKey: string | null }) =>
  channel.kind === "dm" && channel.dmKey !== null && !channel.dmKey.includes("u:");

/**
 * Opens the private conversation between two agents (creates it the first
 * time): a `dm` channel with both agents as its only members. Where one
 * agent consults another; no person is a member.
 */
export async function openAgentDm(db: Executor, orgId: string, a: string, b: string) {
  const dmKey = agentDmKey(a, b);
  const existing = async () =>
    (
      await db
        .select()
        .from(channels)
        .where(and(eq(channels.orgId, orgId), eq(channels.dmKey, dmKey)))
    )[0];
  const found = await existing();
  if (found) {
    if (found.archivedAt) await db.update(channels).set({ archivedAt: null }).where(eq(channels.id, found.id));
    return found;
  }
  const [channel] = await db
    .insert(channels)
    .values({
      orgId,
      name: `dm-${sha256(`${orgId}|${dmKey}`).slice(0, 20)}`,
      visibility: "private",
      kind: "dm",
      dmKey,
    })
    .onConflictDoNothing()
    .returning();
  if (channel) {
    await db.insert(channelMembers).values([
      { orgId, channelId: channel.id, agentId: a },
      { orgId, channelId: channel.id, agentId: b },
    ]);
    return channel;
  }
  const raced = await existing(); // a concurrent open won the race
  if (!raced) throw new Error("could not open the conversation");
  return raced;
}

export interface DmSummary {
  channelId: string;
  with: { type: "person" | "agent"; id: string; name: string; handle: string | null };
  lastMessage: {
    id: string;
    body: string;
    /** What the app needs to show a server-written body in the reader's language; null for a plain message. */
    meta: PreviewMeta | null;
    createdAt: Date;
    authorType: string;
  } | null;
  unread: number;
}

/** My direct conversations, newest activity first, with unread counts. */
export async function listDms(db: Database, actorId: string, orgId: string): Promise<DmSummary[]> {
  await requirePermission(db, actorId, orgId, "read");
  const mine = await db
    .select({ id: channels.id, createdAt: channels.createdAt })
    .from(channels)
    .innerJoin(channelMembers, and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, actorId)))
    .where(and(eq(channels.orgId, orgId), eq(channels.kind, "dm"), isNull(channels.archivedAt)));
  if (mine.length === 0) return [];
  const ids = mine.map((c) => c.id);
  const [others, reads, last] = await Promise.all([
    db
      .select({
        channelId: channelMembers.channelId,
        userId: channelMembers.userId,
        agentId: channelMembers.agentId,
        userName: users.name,
        agentName: agents.name,
        agentHandle: agents.handle,
      })
      .from(channelMembers)
      .leftJoin(users, eq(users.id, channelMembers.userId))
      .leftJoin(agents, eq(agents.id, channelMembers.agentId))
      .where(
        and(
          inArray(channelMembers.channelId, ids),
          sql`(${channelMembers.userId} is null or ${channelMembers.userId} <> ${actorId})`,
        ),
      ),
    db
      .select()
      .from(channelReads)
      .where(and(inArray(channelReads.channelId, ids), eq(channelReads.userId, actorId))),
    db
      .selectDistinctOn([messages.channelId], {
        channelId: messages.channelId,
        id: messages.id,
        body: messages.body,
        meta: messages.meta,
        createdAt: messages.createdAt,
        authorType: messages.authorType,
      })
      .from(messages)
      .where(and(eq(messages.orgId, orgId), inArray(messages.channelId, ids), isNull(messages.deletedAt)))
      .orderBy(messages.channelId, desc(messages.createdAt)),
  ]);
  const readAt = new Map(reads.map((r) => [r.channelId, r.lastReadAt]));
  const unreadRows = await Promise.all(
    ids.map(async (id) => {
      const [row] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(messages)
        .where(
          and(
            eq(messages.orgId, orgId),
            eq(messages.channelId, id),
            isNull(messages.deletedAt),
            sql`(${messages.authorUserId} is null or ${messages.authorUserId} <> ${actorId})`,
            gt(messages.createdAt, readAt.get(id) ?? new Date(0)),
          ),
        );
      return [id, row?.n ?? 0] as const;
    }),
  );
  const unread = new Map(unreadRows);
  const lastBy = new Map(last.map((m) => [m.channelId, m]));
  return mine
    .flatMap((c) => {
      const o = others.find((x) => x.channelId === c.id);
      if (!o) return [];
      const m = lastBy.get(c.id);
      return [
        {
          channelId: c.id,
          with: o.agentId
            ? { type: "agent" as const, id: o.agentId, name: o.agentName ?? "", handle: o.agentHandle }
            : { type: "person" as const, id: o.userId ?? "", name: o.userName ?? "", handle: null },
          lastMessage: m
            ? {
                id: m.id,
                body: m.body.slice(0, 200),
                meta: previewMeta(m.meta as Record<string, unknown> | null),
                createdAt: m.createdAt,
                authorType: m.authorType,
              }
            : null,
          unread: unread.get(c.id) ?? 0,
          sortAt: m?.createdAt ?? c.createdAt,
        },
      ];
    })
    .sort((a, b) => b.sortAt.getTime() - a.sortAt.getTime())
    .map(({ sortAt: _, ...dm }) => dm);
}

/** Marks a channel (or DM) read up to now for me. */
export async function markChannelRead(
  db: Database,
  actorId: string,
  orgId: string,
  channelId: string,
  at = new Date(),
) {
  const [member] = await db
    .select({ id: channelMembers.id })
    .from(channelMembers)
    .where(
      and(eq(channelMembers.orgId, orgId), eq(channelMembers.channelId, channelId), eq(channelMembers.userId, actorId)),
    );
  if (!member) throw new NotFoundError("Channel not found");
  await db
    .insert(channelReads)
    .values({ orgId, channelId, userId: actorId, lastReadAt: at })
    .onConflictDoUpdate({ target: [channelReads.channelId, channelReads.userId], set: { lastReadAt: at } });
}

/** The agents of a DM other than the author (who answers without a mention). */
export async function dmAgents(db: Database, orgId: string, channelId: string) {
  return db
    .select({ id: agents.id })
    .from(channelMembers)
    .innerJoin(agents, eq(agents.id, channelMembers.agentId))
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .where(
      and(
        eq(channelMembers.orgId, orgId),
        eq(channelMembers.channelId, channelId),
        eq(channels.kind, "dm"),
        isNull(agents.archivedAt),
      ),
    );
}
