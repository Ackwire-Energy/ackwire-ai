import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, isNull, rowsOf, schema, sql } from "@agenteschat/db";
import { caches } from "./cache";
import { endOfCategory, requireCategoryInOrg } from "./channel-categories";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishOrgEvent, publishUserEvent } from "./events";
import { followsThreadSql } from "./follows";
import { type PreviewMeta, previewMeta } from "./message-preview";
import { notificationSnippet } from "./notifications";
import { can, getMembership, type Membership, requireActiveMembership, requirePermission } from "./organizations";
import { memberKeysSql, memberRankSql, resolvePermissions } from "./permissions";
import { closedRefusal, STANDING_COLUMNS } from "./standing";

const { channels, channelMembers, agents, organizationMembers, organizations, users } = schema;

export type Channel = typeof channels.$inferSelect;

export const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;

export async function createChannel(
  db: Database,
  actorId: string,
  orgId: string,
  input: { name: string; topic?: string; visibility?: "public" | "private"; categoryId?: string | null },
): Promise<Channel> {
  await requirePermission(db, actorId, orgId, "create_channels");
  // Whoever may create a channel may put it in an existing category (arranging categories is for admins).
  const categoryId = input.categoryId ?? null;
  if (categoryId) await requireCategoryInOrg(db, orgId, categoryId);
  const name = input.name.trim().toLowerCase();
  if (name.startsWith("dm-")) throw new ValidationError("Channel names can't start with dm-");
  if (!CHANNEL_NAME_PATTERN.test(name)) {
    throw new ValidationError("channel name: lower-case letters, digits, - or _ (max 80)");
  }
  try {
    return await db.transaction(async (tx) => {
      const [channel] = await tx
        .insert(channels)
        .values({
          orgId,
          name,
          topic: input.topic ?? "",
          visibility: input.visibility ?? "public",
          createdByUserId: actorId,
          categoryId,
          position: await endOfCategory(tx, orgId, categoryId),
        })
        .returning();
      if (!channel) throw new Error("channel insert returned nothing");
      await tx.insert(channelMembers).values({ orgId, channelId: channel.id, userId: actorId });
      return channel;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`#${name} already exists`);
    throw error;
  }
}

/** The most unread messages counted per channel (clients show "99+"). */
export const MAX_CHANNEL_UNREAD = 100;
/** Length of a channel's last-message preview (plain text). */
export const CHANNEL_PREVIEW_LENGTH = 140;

export interface ChannelLastMessage {
  id: string;
  authorType: "person" | "agent";
  authorId: string | null;
  /** Null when the author was deleted. */
  authorName: string | null;
  /** Plain text, at most `CHANNEL_PREVIEW_LENGTH` chars. */
  preview: string;
  /** What the app needs to show a server-written body in the reader's language; null for a plain message. */
  meta: PreviewMeta | null;
  createdAt: Date;
}

export interface ChannelListItem {
  id: string;
  orgId: string;
  name: string;
  topic: string;
  visibility: "public" | "private";
  createdByUserId: string | null;
  createdAt: Date;
  /** Its sidebar category; null: on top, with none. */
  categoryId: string | null;
  /** Order inside its category. */
  position: number;
  isMember: boolean;
  /**
   * Messages since I last read it (from when I joined, if never), not mine;
   * a thread reply counts only in a thread I follow. At most
   * `MAX_CHANNEL_UNREAD`; 0 when I'm not a member.
   */
  unreadCount: number;
  /**
   * The latest top-level message, skipping a routine's call (hidden in the chat, only the agent's answer
   * shows); null when I'm not a member (I can't read it) or it's empty.
   */
  lastMessage: ChannelLastMessage | null;
}

interface ChannelListRow {
  id: string;
  org_id: string;
  name: string;
  topic: string;
  visibility: "public" | "private";
  created_by_user_id: string | null;
  created_at: Date | string;
  category_id: string | null;
  position: number | string;
  is_member: boolean;
  unread_count: number | string | null;
  last_id: string | null;
  last_body: string | null;
  last_meta: Record<string, unknown> | null;
  last_at: Date | string | null;
  last_author_type: "person" | "agent" | null;
  last_user_id: string | null;
  last_agent_id: string | null;
  last_author_name: string | null;
}

const asDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));

/**
 * Channels the user can see: every public channel plus private ones they
 * belong to, in sidebar order (then by name), with their unread count and last message, in one
 * query (a lateral read per channel on `(channel_id, created_at)`).
 */
export async function listChannels(db: Database, userId: string, orgId: string): Promise<ChannelListItem[]> {
  await requirePermission(db, userId, orgId, "read");
  const rows = rowsOf<ChannelListRow>(
    await db.execute(sql`select c.id, c.org_id, c.name, c.topic, c.visibility, c.created_by_user_id, c.created_at,
        c.category_id, c.position,
        (cm.id is not null) as is_member, coalesce(un.n, 0) as unread_count,
        lm.id as last_id, lm.body as last_body, lm.meta as last_meta, lm.created_at as last_at, lm.author_type as last_author_type,
        lm.author_user_id as last_user_id, lm.author_agent_id as last_agent_id,
        coalesce(lu.name, la.name) as last_author_name
      from ${channels} c
      left join ${channelMembers} cm on cm.org_id = c.org_id and cm.channel_id = c.id and cm.user_id = ${userId}
      left join ${schema.channelReads} cr on cr.channel_id = c.id and cr.user_id = ${userId}
      left join lateral (
        select m.id, m.body, m.meta, m.created_at, m.author_type, m.author_user_id, m.author_agent_id
        from ${schema.messages} m
        where cm.id is not null and m.org_id = ${orgId}::uuid and m.channel_id = c.id
          and m.thread_id is null and m.deleted_at is null
          and not (m.author_type = 'person' and m.meta->'routine' is not null)
        order by m.created_at desc, m.id desc
        limit 1
      ) lm on true
      left join ${schema.users} lu on lu.id = lm.author_user_id
      left join ${agents} la on la.id = lm.author_agent_id
      left join lateral (
        select count(*)::int as n from (
          select 1 from ${schema.messages} u
          where cm.id is not null and u.org_id = ${orgId}::uuid and u.channel_id = c.id and u.deleted_at is null
            and u.created_at > coalesce(cr.last_read_at, cm.created_at)
            and (u.author_user_id is null or u.author_user_id <> ${userId})
            and (u.thread_id is null or ${followsThreadSql(orgId, userId, sql`u.thread_id`)})
          limit ${MAX_CHANNEL_UNREAD}
        ) unread
      ) un on true
      where c.org_id = ${orgId}::uuid and c.archived_at is null and c.kind = 'channel'
        and (c.visibility = 'public' or cm.id is not null)
      order by c.position asc, c.name asc`),
  );
  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    topic: r.topic,
    visibility: r.visibility,
    createdByUserId: r.created_by_user_id,
    createdAt: asDate(r.created_at),
    categoryId: r.category_id,
    position: Number(r.position),
    isMember: r.is_member === true,
    unreadCount: Number(r.unread_count ?? 0),
    lastMessage:
      r.last_id && r.last_at && r.last_author_type
        ? {
            id: r.last_id,
            authorType: r.last_author_type,
            authorId: r.last_author_type === "person" ? r.last_user_id : r.last_agent_id,
            authorName: r.last_author_name,
            preview: notificationSnippet(r.last_body, CHANNEL_PREVIEW_LENGTH),
            meta: previewMeta(typeof r.last_meta === "string" ? JSON.parse(r.last_meta) : r.last_meta),
            createdAt: asDate(r.last_at),
          }
        : null,
  }));
}

export async function isChannelMember(db: Database, orgId: string, channelId: string, userId: string) {
  const [row] = await db
    .select({ id: channelMembers.id })
    .from(channelMembers)
    .where(
      and(eq(channelMembers.orgId, orgId), eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)),
    );
  return row !== undefined;
}

/**
 * The single authorization check for reading a channel (HTTP and WebSocket):
 * the user belongs to the organization (a blocked account belongs nowhere,
 * as in `getMembership`), the channel belongs to that organization, and the
 * user is a member of the channel.
 */
export async function requireChannelAccess(db: Database, userId: string, orgId: string, channelId: string) {
  // One round trip: membership of the org, the channel, and membership of the channel.
  const [row] = await db
    .select({
      role: organizationMembers.role,
      keys: memberKeysSql({ orgId: organizationMembers.orgId, userId: organizationMembers.userId }),
      rank: memberRankSql({ orgId: organizationMembers.orgId, userId: organizationMembers.userId }),
      orgName: organizations.name,
      standing: STANDING_COLUMNS,
      channel: channels,
      memberId: channelMembers.id,
    })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .leftJoin(channels, and(eq(channels.id, channelId), eq(channels.orgId, orgId)))
    .leftJoin(
      channelMembers,
      and(eq(channelMembers.channelId, channelId), eq(channelMembers.orgId, orgId), eq(channelMembers.userId, userId)),
    )
    .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.orgId, orgId), isNull(users.blockedAt)));
  if (!row) throw new ForbiddenError("You are not a member of this organization");
  const closed = closedRefusal(row.standing);
  if (closed) throw closed;
  const channel = row.channel;
  if (!channel || channel.archivedAt) throw new NotFoundError("Channel not found");
  // Forum topics are readable by the whole organization (ADR 0022); writing goes through the forum.
  if (!row.memberId && channel.kind !== "forum") throw new ForbiddenError("Join this channel first");
  const membership: Membership = {
    orgId,
    orgName: row.orgName,
    role: row.role,
    permissions: resolvePermissions(row.role === "owner", row.keys),
    rank: row.rank,
    standing: row.standing,
  };
  return { channel, membership };
}

/** Joins a public channel. Private channels need an invitation from a member. */
export async function joinChannel(db: Database, userId: string, orgId: string, channelId: string) {
  await requirePermission(db, userId, orgId, "read");
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId)));
  if (!channel) throw new NotFoundError("Channel not found");
  if (channel.visibility !== "public" || channel.kind === "dm") throw new ForbiddenError("This channel is private");
  await db.insert(channelMembers).values({ orgId, channelId, userId }).onConflictDoNothing();
}

/**
 * Where `actorId` may put an agent of theirs (or any, with `manage_agents`) or take it out (ADR 0085 §5): a channel
 * they're in and may post in, or one they manage (its creator, `manage_channels`). One rule for an agent's page
 * (`setAgentChannels`) and a channel's members; the apps mirror it (`addsAgentsTo` in packages/client).
 */
export const placesAgentsIn = (
  membership: Membership,
  actorId: string,
  channel: { createdByUserId: string | null },
  actorIn: boolean,
) => (actorIn && can(membership, "post")) || channel.createdByUserId === actorId || can(membership, "manage_channels");

/**
 * Refuses unless `actorId` may put `agentId` in `channel` or take it out: the agent theirs or `manage_agents`, and
 * `placesAgentsIn`.
 */
async function requirePlacesAgent(
  db: Database,
  membership: Membership,
  actorId: string,
  channel: Channel,
  agentId: string,
) {
  const [agent] = await db
    .select({ ownerUserId: agents.ownerUserId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, channel.orgId), isNull(agents.archivedAt)));
  if (!agent) throw new ValidationError("That agent does not exist in this organization");
  if (agent.ownerUserId !== actorId && !can(membership, "manage_agents")) {
    throw new ForbiddenError("Only an admin or the agent's owner can change where it works");
  }
  if (!placesAgentsIn(membership, actorId, channel, await isChannelMember(db, channel.orgId, channel.id, actorId))) {
    throw new ForbiddenError("An agent joins or leaves only the channels you're in or manage");
  }
}

/**
 * Adds a person or an agent of the same organization to a channel. A person:
 * the channel's creator or `manage_channels`. An agent: `requirePlacesAgent`,
 * as on its page (an agent works only where its owner or an admin allowed it).
 * `autoReply` (agents): the router may pick it here without a mention.
 * Members see `channel.member_added`; an added person also gets it on their
 * own topic so the channel shows up in their sidebar. The router reads
 * members from the database, so it sees the change on the next message.
 */
export async function addChannelMember(
  db: Database,
  actorId: string,
  orgId: string,
  channelId: string,
  member: { userId: string } | { agentId: string; autoReply?: boolean },
  options: { pubsub?: PubSub } = {},
) {
  // Admins manage members of any channel, also private ones they're not in.
  const membership = await requireActiveMembership(db, actorId, orgId);
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId), isNull(channels.archivedAt)));
  if (!channel) throw new NotFoundError("Channel not found");
  if (channel.kind === "dm") throw new ValidationError("A direct conversation keeps its participants");
  if ("userId" in member) {
    if (channel.createdByUserId !== actorId && !can(membership, "manage_channels")) {
      throw new ForbiddenError("Only the channel's creator or an admin can add members");
    }
    if (!(await getMembership(db, member.userId, orgId))) {
      throw new ValidationError("That person is not a member of this organization");
    }
    await db.insert(channelMembers).values({ orgId, channelId, userId: member.userId }).onConflictDoNothing();
    caches.channelMembers.delete(`${orgId}:${channelId}`);
    const event = {
      type: "channel.member_added" as const,
      channelId,
      member: { type: "person" as const, id: member.userId },
    };
    await publishChannelEvent(options.pubsub, event);
    await publishUserEvent(options.pubsub, orgId, member.userId, event);
    return;
  }
  await requirePlacesAgent(db, membership, actorId, channel, member.agentId);
  const autoReply = member.autoReply ?? true;
  await db
    .insert(channelMembers)
    .values({ orgId, channelId, agentId: member.agentId, autoReply })
    .onConflictDoUpdate({ target: [channelMembers.channelId, channelMembers.agentId], set: { autoReply } });
  caches.channelMembers.delete(`${orgId}:${channelId}`);
  caches.scopes.deletePrefix(`${orgId}:${member.agentId}:visible`);
  await publishChannelEvent(options.pubsub, {
    type: "channel.member_added",
    channelId,
    member: { type: "agent", id: member.agentId, autoReply },
  });
}

/**
 * Turns an agent's auto-reply in one channel on or off (creator, admin or
 * the agent's owner). Off: it answers there only when @mentioned.
 */
export async function setChannelAgentAutoReply(
  db: Database,
  actorId: string,
  orgId: string,
  channelId: string,
  agentId: string,
  autoReply: boolean,
  options: { pubsub?: PubSub } = {},
) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const [row] = await db
    .select({ createdBy: channels.createdByUserId, ownerUserId: agents.ownerUserId })
    .from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .innerJoin(agents, eq(agents.id, channelMembers.agentId))
    .where(
      and(
        eq(channelMembers.orgId, orgId),
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.agentId, agentId),
      ),
    );
  if (!row) throw new NotFoundError("That agent is not in this channel");
  if (row.createdBy !== actorId && row.ownerUserId !== actorId && !can(membership, "manage_channels")) {
    throw new ForbiddenError("Only the channel's creator, an admin or the agent's owner can change this");
  }
  await db
    .update(channelMembers)
    .set({ autoReply })
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.agentId, agentId)));
  caches.channelMembers.delete(`${orgId}:${channelId}`);
  await publishChannelEvent(options.pubsub, {
    type: "channel.member_updated",
    channelId,
    member: { type: "agent", id: agentId, autoReply },
  });
}

export async function listChannelMembers(db: Database, actorId: string, orgId: string, channelId: string) {
  await requireChannelAccess(db, actorId, orgId, channelId);
  const rows = await db
    .select({ userId: channelMembers.userId, agentId: channelMembers.agentId })
    .from(channelMembers)
    .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.channelId, channelId)));
  return rows.map((r) =>
    r.userId ? { type: "person" as const, id: r.userId } : { type: "agent" as const, id: r.agentId ?? "" },
  );
}

/**
 * Removes a person or an agent from a channel. Allowed for yourself (leave),
 * the channel's creator, and admins; an agent also for whoever may put it
 * there (`requirePlacesAgent`). Publishes `membership.revoked` so open
 * WebSocket subscriptions of that person end immediately.
 */
export async function removeChannelMember(
  db: Database,
  actorId: string,
  orgId: string,
  channelId: string,
  member: { userId: string } | { agentId: string },
  options: { pubsub?: PubSub } = {},
) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId)));
  if (!channel) throw new NotFoundError("Channel not found");
  const self = "userId" in member && member.userId === actorId;
  if (!self && channel.createdByUserId !== actorId && !can(membership, "manage_channels")) {
    if ("userId" in member) throw new ForbiddenError("Only the channel's creator or an admin can remove members");
    await requirePlacesAgent(db, membership, actorId, channel, member.agentId);
  }
  await db
    .delete(channelMembers)
    .where(
      and(
        eq(channelMembers.orgId, orgId),
        eq(channelMembers.channelId, channelId),
        "userId" in member ? eq(channelMembers.userId, member.userId) : eq(channelMembers.agentId, member.agentId),
      ),
    );
  caches.channelMembers.delete(`${orgId}:${channelId}`);
  if ("agentId" in member) caches.scopes.deletePrefix(`${orgId}:${member.agentId}:visible`);
  const removed = {
    type: "channel.member_removed" as const,
    channelId,
    member:
      "userId" in member
        ? { type: "person" as const, id: member.userId }
        : { type: "agent" as const, id: member.agentId },
  };
  // Revoke first, so the removed person's subscription ends before the channel hears about it.
  if ("userId" in member) {
    await publishOrgEvent(options.pubsub, { type: "membership.revoked", orgId, userId: member.userId, channelId });
    await publishUserEvent(options.pubsub, orgId, member.userId, removed);
  }
  await publishChannelEvent(options.pubsub, removed);
}

/** The channel, when `actorId` may archive it or bring it back: its creator or an admin. */
async function archivableChannel(db: Database, actorId: string, orgId: string, channelId: string) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId)));
  if (!channel) throw new NotFoundError("Channel not found");
  if (channel.createdByUserId !== actorId && !can(membership, "manage_channels")) {
    throw new ForbiddenError("Only the channel's creator or an admin can archive it");
  }
  return channel;
}

/** Archives a channel (creator or admin). Live subscriptions to it end at once. `general` can't be archived. */
export async function archiveChannel(
  db: Database,
  actorId: string,
  orgId: string,
  channelId: string,
  options: { pubsub?: PubSub } = {},
) {
  const channel = await archivableChannel(db, actorId, orgId, channelId);
  if (channel.name === "general") throw new ValidationError("#general can't be archived");
  await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, channelId));
  caches.channels.delete(`${orgId}:${channelId}`);
  await publishOrgEvent(options.pubsub, { type: "channel.archived", orgId, channelId });
}

/** Brings an archived channel back as it was (creator or admin): "Refazer" after an agent's channel was undone. */
export async function unarchiveChannel(db: Database, actorId: string, orgId: string, channelId: string) {
  await archivableChannel(db, actorId, orgId, channelId);
  await db.update(channels).set({ archivedAt: null }).where(eq(channels.id, channelId));
  caches.channels.delete(`${orgId}:${channelId}`);
}
