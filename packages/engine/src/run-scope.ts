import { type SQL, schema, sql } from "@agenteschat/db";

/**
 * SQL: the run `r` answers in the channel itself, not in a thread's panel
 * ("Responder", D59), a range thread or a mission's thread. A new message in
 * the channel for that agent joins such a run (D62) instead of starting a
 * second one beside it.
 */
export const inChannelRun = (r: SQL) => sql`(not exists (
    select 1 from ${schema.threads} t where t.org_id = ${r}.org_id and t.root_message_id = ${r}.thread_root_id
      and (t.opened_by_reply_at is not null or t.context_channel_id is not null))
  and not exists (
    select 1 from ${schema.missions} mi where mi.org_id = ${r}.org_id and mi.thread_root_id = ${r}.thread_root_id))`;
