import { type Executor, rowsOf, type SQL, schema, sql } from "@agenteschat/db";
import { caches } from "./cache";

const { issues, channels, channelMembers, agents } = schema;

/**
 * A task's conversation (ADR 0145) is read by whoever sees the task, never by its own membership: people are never
 * members of a `task` channel. True when `channelId` is a task's conversation and `userId` sees that task: one of
 * the whole workspace, or one of a channel they are in (or a public channel). The workspace membership is the
 * caller's check. Mirrors `canSee` for people in `issues.ts`.
 */
export const taskReaderSql = (channelId: SQL, userId: SQL) => sql`exists (
  select 1 from ${issues} ti
  where ti.conversation_channel_id = ${channelId}
    and (ti.channel_id is null
      or exists (select 1 from ${channelMembers} tm where tm.channel_id = ti.channel_id and tm.user_id = ${userId})
      or exists (select 1 from ${channels} tc where tc.id = ti.channel_id and tc.visibility = 'public'
        and tc.kind = 'channel')))`;

/**
 * Agents join a task's conversation as members (so a mention there reaches them like anywhere else) when they see
 * the task: one of the whole workspace, or one of a channel they are in (or a public one), by current handle (a
 * person's mention). By id: the task's assignee, whoever assigned it saw the task. Returns the agents added now.
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
          or (a.handle = any(${`{${handles.join(",")}}`}::text[]) and (i.channel_id is null
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
