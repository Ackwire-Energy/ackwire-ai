import { type SQL, sql } from "@agenteschat/db";

/**
 * SQL: the run `r` answers in the channel itself (it was asked there), not in
 * a thread, a range thread or a mission's thread. A new message in the channel
 * for that agent joins such a run (ADR 0029) instead of starting a second one
 * beside it. Same rule as `replyThreadOf`.
 */
export const inChannelRun = (r: SQL) => sql`(${r}.thread_root_id = ${r}.trigger_message_id)`;
