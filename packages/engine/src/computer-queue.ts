import { and, type Database, eq, schema, sql } from "@agenteschat/db";
import { enqueue } from "./outbox";

const { agentRuns } = schema;

/**
 * The line for a shared computer's room (ADR 0032, "Calm waits"). The runner admits a turn only while its memory
 * floor holds and keeps no order, so the engine keeps it: runs a person is waiting on go first, then by when each
 * started waiting. Only the head of the line asks the runner again, and agents' turns start `ROOM_ASK_SPACING_MS`
 * apart, so a burst of mentions reaches the computer one by one instead of all refused at once.
 */
export const ROOM_ASK_SPACING_MS = 10_000;

const waitingForRoom = (machineId: string) =>
  and(
    eq(agentRuns.waitingMachineId, machineId),
    eq(agentRuns.status, "waiting_input"),
    sql`${agentRuns.transcript}->'waitingForBrain'->>'code' = 'busy'`,
  );
const peopleSql = sql`coalesce((${agentRuns.transcript}->>'roomPeople')::boolean, false)`;
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
      waitId: sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'waitId'`,
    })
    .from(agentRuns)
    .where(waitingForRoom(machineId))
    .orderBy(sql`${peopleSql} desc`, sinceSql, agentRuns.id)
    .limit(1);
  return head ?? null;
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
 * for room ranks ahead of it (people first, then the longest wait), or, for agents' work, when another run asked
 * this computer less than `ROOM_ASK_SPACING_MS` ago. A person's turn never waits for the spacing; the runner's
 * memory floor still decides whether it fits.
 */
export async function roomGate(
  db: Database,
  run: { id: string; orgId: string },
  machineId: string,
  rank: { people: boolean; since: number },
): Promise<{ retryAt: number } | null> {
  const now = Date.now();
  const behind = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`room:${machineId}`}))`);
    const mine = sql`(${rank.since}::bigint, ${run.id}::uuid)`;
    const [ahead] = await tx
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          waitingForRoom(machineId),
          sql`${agentRuns.id} <> ${run.id}`,
          rank.people
            ? sql`${peopleSql} and (${sinceSql}, ${agentRuns.id}) < ${mine}`
            : sql`(${peopleSql} or (${sinceSql}, ${agentRuns.id}) < ${mine})`,
        ),
      )
      .limit(1);
    if (ahead) return { retryAt: now + ROOM_ASK_SPACING_MS };
    if (!rank.people) {
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
