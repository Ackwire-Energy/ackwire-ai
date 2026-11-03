import { type SQL, sql } from "@agenteschat/db";

/**
 * SQL: the run `r` answers in the channel itself (it was asked there), not in
 * a thread, a range thread or a mission's thread. A new message in the channel
 * for that agent joins such a run (ADR 0029) instead of starting a second one
 * beside it. Same rule as `replyThreadOf`.
 */
export const inChannelRun = (r: SQL) => sql`(${r}.thread_root_id = ${r}.trigger_message_id)`;

/**
 * SQL: the run `r` may take a new message where it is. Background work (ADR 0121) stepped out of the conversation it
 * was asked in: only a work with its own thread (the anchor's) still takes replies there; one asked inside a thread
 * leaves that thread to the agent's other runs.
 */
export const workKeepsThread = (r: SQL) =>
  sql`(${r}.work_id is null or exists (select 1 from agent_works w where w.id = ${r}.work_id and w.own_thread))`;

/**
 * SQL: the run `r` waits on its plan's limit or its budget (a conversation's catch-up): like a run waiting for its
 * computer, it takes every new message of its conversation instead of a second run beside it.
 */
export const waitsOnUsage = (r: SQL) =>
  sql`(${r}.status = 'waiting_input' and ${r}.transcript->'waitingForBrain'->>'code' in ('plan_limit', 'budget'))`;
