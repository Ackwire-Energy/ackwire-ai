import { and, type Executor, eq, isNotNull, rowsOf, type SQL, schema, sql } from "@agenteschat/db";
import { caches } from "./cache";
import { maySql } from "./permissions";

const { issues, channels, channelMembers, agents } = schema;

/** Who a task or a wiki page is for (ADR 0151): "only me" is a list of one. Administrators always see it. */
export type Audience = { mode: "everyone" } | { mode: "people"; userIds: string[] };

/** The most people a task's audience names. */
export const AUDIENCE_MAX = 200;

/** A row of `channels` an administrator reads without being in it (ADR 0151): every channel, never a DM. */
export const adminChannelSql = (orgId: unknown, userId: unknown) =>
  and(eq(channels.kind, "channel"), maySql(orgId, userId, "administrator"));

/**
 * Whether `userId` sees the `issues` row `alias` (ADR 0151): an administrator always; a limited task, who it names; else
 * the whole workspace, or who reads the conversation it's tied to (`channel_id`: its members, anyone for a public
 * channel). The workspace membership is the caller's check. Mirrors `personSees` in `issues.ts`.
 */
export function taskSeenSql(alias: string, userId: SQL): SQL {
  const t = sql.raw(alias);
  return sql`(${maySql(sql`${t}.org_id`, userId, "administrator")}
    or (${t}.restricted and ${userId} = any(${t}.audience_user_ids))
    or (not ${t}.restricted and (${t}.channel_id is null
      or exists (select 1 from ${channelMembers} tm where tm.channel_id = ${t}.channel_id and tm.user_id = ${userId})
      or exists (select 1 from ${channels} tc where tc.id = ${t}.channel_id and tc.visibility = 'public'
        and tc.kind = 'channel'))))`;
}

/**
 * A task's conversation (ADR 0145) is read by whoever sees the task, never by its own membership: people are never
 * members of a `task` channel. True when `channelId` is a task's conversation and `userId` sees that task.
 */
export const taskReaderSql = (channelId: SQL, userId: SQL) => sql`exists (
  select 1 from ${issues} ti where ti.conversation_channel_id = ${channelId} and ${taskSeenSql("ti", userId)})`;

/**
 * The audience an agent picks for what it makes in a conversation (ADR 0151): the workspace from a public channel, and
 * from a room no person reads (a routine's); the people there from a DM or a private channel; from a task's own
 * conversation, who sees that task.
 */
export async function audienceOfConversation(db: Executor, channelId: string): Promise<Audience> {
  const [c] = await db
    .select({
      kind: channels.kind,
      visibility: channels.visibility,
      taskChannelId: issues.channelId,
      restricted: issues.restricted,
      userIds: issues.audienceUserIds,
    })
    .from(channels)
    .leftJoin(issues, eq(issues.conversationChannelId, channels.id))
    .where(eq(channels.id, channelId));
  if (c?.restricted) return { mode: "people", userIds: c.userIds ?? [] };
  if (c?.kind === "task") return c.taskChannelId ? audienceOfConversation(db, c.taskChannelId) : { mode: "everyone" };
  if (!c || (c.kind === "channel" && c.visibility === "public")) return { mode: "everyone" };
  const people = await db
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), isNotNull(channelMembers.userId)));
  return people.length
    ? { mode: "people", userIds: people.flatMap((p) => (p.userId ? [p.userId] : [])) }
    : { mode: "everyone" };
}

/** Of `userIds`, who sees the task `issueId` now. */
export async function taskReadersAmong(db: Executor, issueId: string, userIds: readonly string[]) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const rows = rowsOf<{ user_id: string }>(
    await db.execute(sql`select u.id as user_id from ${schema.users} u, ${issues} t
      where t.id = ${issueId}::uuid and u.id = any(${`{${ids.join(",")}}`}::text[])
        and ${taskSeenSql("t", sql`u.id`)}`),
  );
  return rows.map((r) => r.user_id);
}

/**
 * Agents join a task's conversation as members (so a mention there reaches them like anywhere else) when they see
 * the task: one of the whole workspace, one limited to people (who mentioned it reads it, and an agent reaches what
 * they reach), or one of a channel they are in (or a public one), by current handle (a person's mention). By id: the
 * task's assignee, whoever assigned it saw the task. Returns the agents added now.
 */
export async function admitTaskAgents(
  db: Executor,
  orgId: string,
  channelId: string,
  who: { handles?: string[]; ids?: string[] },
): Promise<string[]> {
  const handles = (who.handles ?? []).filter((h) => /^[a-z0-9_-]+$/.test(h));
  const ids = (who.ids ?? []).filter((v) => /^[0-9a-f-]{36}$/i.test(v));
  if (handles.length === 0 && ids.length === 0) return [];
  const rows = rowsOf<{ agent_id: string }>(
    await db.execute(sql`insert into ${channelMembers} (org_id, channel_id, agent_id)
      select a.org_id, ${channelId}::uuid, a.id from ${agents} a
      join ${issues} i on i.conversation_channel_id = ${channelId}::uuid and i.org_id = a.org_id
      where a.org_id = ${orgId}::uuid and a.archived_at is null
        and (a.id = any(${`{${ids.join(",")}}`}::uuid[])
          or (a.handle = any(${`{${handles.join(",")}}`}::text[]) and (i.restricted or i.channel_id is null
            or exists (select 1 from ${channelMembers} am where am.channel_id = i.channel_id and am.agent_id = a.id)
            or exists (select 1 from ${channels} ac where ac.id = i.channel_id and ac.visibility = 'public'
              and ac.kind = 'channel'))))
      on conflict do nothing
      returning agent_id`),
  );
  if (rows.length > 0) caches.channelMembers.delete(`${orgId}:${channelId}`);
  // Its search reaches the conversation it's in now (`agentSearchChannels`).
  for (const r of rows) caches.scopes.deletePrefix(`${orgId}:${r.agent_id}:visible`);
  return rows.map((r) => r.agent_id);
}
