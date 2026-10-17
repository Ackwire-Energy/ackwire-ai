import { and, type Executor, eq, type SQL, schema, sql } from "@agenteschat/db";

const { threadFollows, messages } = schema;

/**
 * Who follows a thread (D46 and the phone app's "Seguir"). A person's
 * explicit choice (`thread_follows`) wins: following adds them, unfollowing
 * mutes them even where they wrote. Without one, they follow the threads
 * they started (not a routine's or the forum's root) or wrote in.
 *
 * Following means: notified of replies (`thread_reply`), and replies count
 * as unread in the channel list.
 */
export function followsThreadSql(orgId: string, userId: string, root: SQL): SQL {
  return sql`coalesce(
    (select tf.following from ${threadFollows} tf
      where tf.org_id = ${orgId}::uuid and tf.root_message_id = ${root} and tf.user_id = ${userId}),
    exists (select 1 from ${messages} fr where fr.org_id = ${orgId}::uuid and fr.id = ${root}
      and fr.author_user_id = ${userId} and fr.meta->'routine' is null and fr.meta->'forum' is null)
    or exists (select 1 from ${messages} fp where fp.org_id = ${orgId}::uuid and fp.thread_id = ${root}
      and fp.author_user_id = ${userId} and fp.deleted_at is null)
  )`;
}

/** Explicit choices about one thread: who follows it on purpose and who muted it. */
export async function threadFollowChoices(db: Executor, orgId: string, rootId: string) {
  const rows = await db
    .select({ userId: threadFollows.userId, following: threadFollows.following })
    .from(threadFollows)
    .where(and(eq(threadFollows.orgId, orgId), eq(threadFollows.rootMessageId, rootId)));
  return {
    followers: rows.filter((r) => r.following).map((r) => r.userId),
    muted: new Set(rows.filter((r) => !r.following).map((r) => r.userId)),
  };
}
