import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, eq, inArray, isNull, or, schema } from "@agenteschat/db";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import { can, getMembership, requirePermission } from "./organizations";

const { channels, channelMembers, agents } = schema;

export type Channel = typeof channels.$inferSelect;

export const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/;

export async function createChannel(
  db: Database,
  actorId: string,
  orgId: string,
  input: { name: string; topic?: string; visibility?: "public" | "private" },
): Promise<Channel> {
  await requirePermission(db, actorId, orgId, "create_channels");
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

/** Channels the user can see: every public channel plus private ones they belong to. */
export async function listChannels(db: Database, userId: string, orgId: string) {
  await requirePermission(db, userId, orgId, "read");
  const mine = db
    .select({ channelId: channelMembers.channelId })
    .from(channelMembers)
    .where(and(eq(channelMembers.orgId, orgId), eq(channelMembers.userId, userId)));
  const rows = await db
    .select()
    .from(channels)
    .where(
      and(
        eq(channels.orgId, orgId),
        isNull(channels.archivedAt),
        eq(channels.kind, "channel"),
        or(eq(channels.visibility, "public"), inArray(channels.id, mine)),
      ),
    )
    .orderBy(asc(channels.name));
  const memberOf = new Set((await mine).map((r) => r.channelId));
  return rows.map((c) => ({ ...c, isMember: memberOf.has(c.id) }));
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
 * the user belongs to the organization, the channel belongs to that
 * organization, and the user is a member of the channel.
 */
export async function requireChannelAccess(db: Database, userId: string, orgId: string, channelId: string) {
  const membership = await getMembership(db, userId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId)));
  if (!channel || channel.archivedAt) throw new NotFoundError("Channel not found");
  if (!(await isChannelMember(db, orgId, channelId, userId))) {
    throw new ForbiddenError("Join this channel first");
  }
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

/** A channel member adds a person or an agent of the same organization. */
export async function addChannelMember(
  db: Database,
  actorId: string,
  orgId: string,
  channelId: string,
  member: { userId: string } | { agentId: string },
) {
  const { channel } = await requireChannelAccess(db, actorId, orgId, channelId);
  if (channel.kind === "dm") throw new ValidationError("A direct conversation keeps its participants");
  if ("userId" in member) {
    if (!(await getMembership(db, member.userId, orgId))) {
      throw new ValidationError("That person is not a member of this organization");
    }
    await db.insert(channelMembers).values({ orgId, channelId, userId: member.userId }).onConflictDoNothing();
  } else {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, member.agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt)));
    if (!agent) throw new ValidationError("That agent does not exist in this organization");
    await db.insert(channelMembers).values({ orgId, channelId, agentId: member.agentId }).onConflictDoNothing();
  }
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
 * the channel's creator, and admins. Publishes `membership.revoked` so open
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
  const membership = await getMembership(db, actorId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId)));
  if (!channel) throw new NotFoundError("Channel not found");
  const self = "userId" in member && member.userId === actorId;
  if (!self && channel.createdByUserId !== actorId && !can(membership.role, "manage_members")) {
    throw new ForbiddenError("Only the channel's creator or an admin can remove members");
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
  if ("userId" in member) {
    await publishOrgEvent(options.pubsub, { type: "membership.revoked", orgId, userId: member.userId, channelId });
  }
}

/** Archives a channel (creator or admin). Live subscriptions to it end at once. `general` can't be archived. */
export async function archiveChannel(
  db: Database,
  actorId: string,
  orgId: string,
  channelId: string,
  options: { pubsub?: PubSub } = {},
) {
  const membership = await getMembership(db, actorId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
  const [channel] = await db
    .select()
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.orgId, orgId)));
  if (!channel) throw new NotFoundError("Channel not found");
  if (channel.createdByUserId !== actorId && !can(membership.role, "manage_members")) {
    throw new ForbiddenError("Only the channel's creator or an admin can archive it");
  }
  if (channel.name === "general") throw new ValidationError("#general can't be archived");
  await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, channelId));
  await publishOrgEvent(options.pubsub, { type: "channel.archived", orgId, channelId });
}
