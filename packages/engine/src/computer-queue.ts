import { and, type Database, type Executor, eq, inArray, type SQL, schema, sql } from "@agenteschat/db";
import { enqueue } from "./outbox";

const { agentRuns, agents } = schema;

/**
 * The line for a shared computer's room (ADR 0032, "Calm waits" and "Calm wakes"). The runner admits a turn only
 * while its memory floor holds and keeps no order, so the engine keeps it, in three ranks: runs a person is waiting
 * on, then agents' work a person asked for lately (`transcript.roomAsked`), then the rest; by when each started
 * waiting within a rank. Only the head of the line asks the runner again, and agents' turns start
 * `ROOM_ASK_SPACING_MS` apart, so a burst of mentions reaches the computer one by one instead of all refused at once.
 */
export const ROOM_ASK_SPACING_MS = 10_000;

const inLine = and(
  eq(agentRuns.status, "waiting_input"),
  sql`${agentRuns.transcript}->'waitingForBrain'->>'code' = 'busy'`,
);
const waitingForRoom = (machineId: string) => and(eq(agentRuns.waitingMachineId, machineId), inLine);
const waitIdSql = sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'waitId'`;
const peopleSql = sql`coalesce((${agentRuns.transcript}->>'roomPeople')::boolean, false)`;
const askedSql = sql`coalesce((${agentRuns.transcript}->>'roomAsked')::boolean, false)`;
/** A run's rank in the line: 0 a person waits on it, 1 work a person asked for lately, 2 the rest. */
const rankSql = sql<number>`(case when ${peopleSql} then 0 when ${askedSql} then 1 else 2 end)`;
export type RoomRank = 0 | 1 | 2;
const sinceSql = sql`coalesce((${agentRuns.transcript}->>'roomWaitSince')::bigint, 0)`;

/** The run first in line for room on this computer, with the wait its job must carry. */
export async function roomHead(
  db: Database,
  machineId: string,
): Promise<{ id: string; orgId: string; waitId: string | null } | null> {
  const [head] = await db
    .select({
      id: agentRuns.id,
      orgId: agentRuns.orgId,
      waitId: waitIdSql,
    })
    .from(agentRuns)
    .where(waitingForRoom(machineId))
    .orderBy(rankSql, sinceSql, agentRuns.id)
    .limit(1);
  return head ?? null;
}

/**
 * A person's message went into this run waiting in line: a person waits on it now, so it goes to the front and looks
 * again at once (the same job as a steered message's).
 */
export async function frontOfLine(db: Executor, run: { id: string; orgId: string }, messageId: string) {
  const [row] = await db
    .update(agentRuns)
    .set({ transcript: sql`jsonb_set(${agentRuns.transcript}, '{roomPeople}', 'true'::jsonb)` })
    .where(and(eq(agentRuns.id, run.id), inLine))
    .returning({ waitId: waitIdSql });
  if (!row) return;
  await enqueue(db, {
    orgId: run.orgId,
    kind: "agent_run.execute",
    payload: { runId: run.id, ...(row.waitId ? { wait: row.waitId } : {}) },
    dedupeKey: `agent_run.execute:${run.id}:steer:${messageId}`,
    maxAttempts: 4,
  });
}

/** Asks the head of the line to look again: now (a turn there ended), or `at` (the spacing is over). One job of each per wait. */
export async function kickRoomQueue(db: Database, machineId: string, at?: Date) {
  const head = await roomHead(db, machineId);
  if (!head?.waitId) return;
  await enqueue(db, {
    orgId: head.orgId,
    kind: "agent_run.execute",
    payload: { runId: head.id, wait: head.waitId },
    dedupeKey: `agent_run.execute:${head.id}:room-kick:${head.waitId}:${at ? "spaced" : "freed"}`,
    maxAttempts: 4,
    ...(at ? { runAt: at } : {}),
  });
}

/**
 * Whether this run may send its computer turn now. Null: go (its ask is recorded, and the next in line is asked
 * once the spacing is over). Otherwise it is behind: `retryAt` is when it may look again. Behind when a run waiting
 * for room ranks ahead of it (by rank, then the longest wait), or, for agents' work, when another run asked
 * this computer less than `ROOM_ASK_SPACING_MS` ago. A person's turn never waits for the spacing; the runner's
 * memory floor still decides whether it fits.
 */
export async function roomGate(
  db: Database,
  run: { id: string; orgId: string },
  machineId: string,
  place: { rank: RoomRank; since: number },
): Promise<{ retryAt: number } | null> {
  const now = Date.now();
  const behind = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`room:${machineId}`}))`);
    const [ahead] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          waitingForRoom(machineId),
          sql`${agentRuns.id} <> ${run.id}`,
          sql`(${rankSql}, ${sinceSql}, ${agentRuns.id}) < (${place.rank}::int, ${place.since}::bigint, ${run.id}::uuid)`,
        ),
      )
      .limit(1);
    if (ahead) return { retryAt: now + ROOM_ASK_SPACING_MS };
    if (place.rank > 0) {
      const [last] = await tx
        .select({ at: sql<string>`max((${agentRuns.transcript}->'roomAsk'->>'at')::bigint)` })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.orgId, run.orgId),
            eq(agentRuns.status, "running"),
            sql`${agentRuns.id} <> ${run.id}`,
            sql`${agentRuns.transcript}->'roomAsk'->>'machineId' = ${machineId}`,
          ),
        );
      const at = Number(last?.at ?? 0);
      if (now - at < ROOM_ASK_SPACING_MS) return { retryAt: at + ROOM_ASK_SPACING_MS };
    }
    await tx
      .update(agentRuns)
      .set({
        transcript: sql`jsonb_set(coalesce(${agentRuns.transcript}, '{}'::jsonb), '{roomAsk}', ${JSON.stringify({ machineId, at: now })}::jsonb)`,
      })
      .where(eq(agentRuns.id, run.id));
    return null;
  });
  if (!behind) await kickRoomQueue(db, machineId, new Date(now + ROOM_ASK_SPACING_MS));
  return behind;
}

/** The best rank among this agent's runs in a computer's line, null when none is in line. */
export async function agentLineRank(db: Executor, orgId: string, agentId: string): Promise<RoomRank | null> {
  const [row] = await db
    .select({ rank: sql<number | null>`min(${rankSql})` })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.agentId, agentId), inLine));
  return row?.rank == null ? null : (Number(row.rank) as RoomRank);
}

/** For a select naming an agent: its computer has runs waiting for room (it is full, and work queues on it). */
export const computerCrowdedSql = (agentId: SQL) => sql<boolean>`exists (select 1 from ${agentRuns} w
  join ${agents} ca on ca.machine_id = w.waiting_machine_id
  where ca.id = ${agentId} and w.status = 'waiting_input' and w.transcript->'waitingForBrain'->>'code' = 'busy')`;

/** Of these agents, the ones whose computer has runs waiting for room. */
export async function crowdedAgents(db: Executor, orgId: string, agentIds: string[]): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds), computerCrowdedSql(sql`${agents}.id`)));
  return new Set(rows.map((r) => r.id));
}
