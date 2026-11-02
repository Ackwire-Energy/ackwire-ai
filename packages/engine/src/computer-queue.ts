import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, rowsOf, schema, sql } from "@agenteschat/db";
import { TtlCache } from "./cache";
import { NotFoundError } from "./errors";
import { publishOrgEvent } from "./events";
import { getMachine } from "./machines";
import { requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import { replyThreadOf } from "./runs";

const { agentRuns, messages } = schema;

/**
 * The line for a shared computer's room (ADR 0032, "Calm waits"). The runner admits a turn only while its memory
 * floor holds and keeps no order, so the engine keeps it: runs a person is waiting on go first, then by when each
 * started waiting. Only the head of the line asks the runner again, and agents' turns start `ROOM_ASK_SPACING_MS`
 * apart, so a burst of mentions reaches the computer one by one instead of all refused at once.
 */
export const ROOM_ASK_SPACING_MS = 10_000;

const inLine = and(
  eq(agentRuns.status, "waiting_input"),
  sql`${agentRuns.transcript}->'waitingForBrain'->>'code' = 'busy'`,
);
const waitingForRoom = (machineId: string) => and(eq(agentRuns.waitingMachineId, machineId), inLine);
const waitIdSql = sql<string | null>`${agentRuns.transcript}->'waitingForBrain'->>'waitId'`;
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
      waitId: waitIdSql,
    })
    .from(agentRuns)
    .where(waitingForRoom(machineId))
    .orderBy(sql`${peopleSql} desc`, sinceSql, agentRuns.id)
    .limit(1);
  return head ?? null;
}

/**
 * A person's message went into this run waiting in line: a person waits on it now, so it goes to the front and looks
 * again at once (the same job as a steered message's). The job tells the line's viewers (`line`), after this commits.
 */
export async function frontOfLine(db: Executor, run: { id: string; orgId: string }, messageId: string) {
  const [row] = await db
    .update(agentRuns)
    .set({ transcript: sql`jsonb_set(${agentRuns.transcript}, '{roomPeople}', 'true'::jsonb)` })
    .where(and(eq(agentRuns.id, run.id), inLine))
    .returning({ waitId: waitIdSql, machineId: agentRuns.waitingMachineId });
  if (!row) return;
  await enqueue(db, {
    orgId: run.orgId,
    kind: "agent_run.execute",
    payload: {
      runId: run.id,
      ...(row.waitId ? { wait: row.waitId } : {}),
      ...(row.machineId ? { line: row.machineId } : {}),
    },
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

/** The computer whose line shows this run: the one it is working on, or the one it waits in line for. */
export function lineMachineOf(run: { transcript: unknown; waitingMachineId: string | null }): string | null {
  const t = run.transcript as { roomAsk?: { machineId?: string }; waitingForBrain?: { code?: string } } | null;
  if (t?.waitingForBrain?.code === "busy" && run.waitingMachineId) return run.waitingMachineId;
  return t?.roomAsk?.machineId ?? null;
}

/** Tells every open app of the workspace that this computer's line changed, so whoever shows it reads it again. */
export async function publishQueueChanged(pubsub: PubSub | undefined, orgId: string, machineId: string) {
  await publishOrgEvent(pubsub, { type: "org.broadcast", orgId, event: { type: "computer.queue", machineId } });
}

/**
 * What a turn on the computer is for, in structured words and never its content: answering a person, asked by
 * another agent, a routine's run, or long work (ADR 0121). The ids are null when the author is gone.
 */
export type QueuePurpose =
  | { kind: "person"; userId: string | null }
  | { kind: "agent"; agentId: string | null }
  | { kind: "routine" }
  | { kind: "work" };

export interface QueueWhere {
  channelId: string;
  threadId: string | null;
}

export interface QueueWorking {
  runId: string;
  agentId: string;
  purpose: QueuePurpose;
  where: QueueWhere;
  /** When this turn asked the computer (ISO). */
  startedAt: string;
  /** Its start plus the agent's typical computer turn, never sooner than 30 s from now; null with no basis. */
  estimatedEndAt: string | null;
}

export interface QueueWaiting {
  runId: string;
  agentId: string;
  purpose: QueuePurpose;
  where: QueueWhere;
  /** A person waits on it: it goes first. */
  people: boolean;
  /** 1 = next. */
  position: number;
  estimatedStartAt: string | null;
  /** Who it waits for: for the head, the running turn expected to end first; behind it, the agents ahead in line. */
  after: string[];
}

export interface ComputerQueue {
  machineId: string;
  name: string;
  working: QueueWorking[];
  waiting: QueueWaiting[];
}

/** A running turn's estimated end is never sooner than this from now: an estimate never reads as "any second". */
export const QUEUE_END_FLOOR_MS = 30_000;
/** How many of an agent's latest finished computer turns its typical duration is read from. */
const TYPICAL_TURNS = 20;

/** Median computer-turn durations (ms): per agent, and the org's as the fallback. */
export interface TypicalTurns {
  byAgent: Record<string, number>;
  org: number | null;
}

/**
 * When each running turn should end and each waiting one start, by simulating the computer's slots: each running
 * turn frees one at its expected end, the line takes them in order (the soonest free slot first), and an agent's turn
 * starts at least `ROOM_ASK_SPACING_MS` after the previous ask. A slot with no basis (an agent with no history in an
 * org with none) frees at an unknown time, and so does every turn after it. Pure, for a fixed clock.
 */
export function estimateQueue(
  now: number,
  working: readonly { agentId: string; startedAt: number }[],
  waiting: readonly { agentId: string; people: boolean }[],
  typical: TypicalTurns,
): { ends: (number | null)[]; starts: (number | null)[]; after: string[][] } {
  const typicalOf = (agentId: string) => typical.byAgent[agentId] ?? typical.org;
  const ends = working.map((w) => {
    const d = typicalOf(w.agentId);
    return d === null ? null : Math.max(w.startedAt + d, now + QUEUE_END_FLOOR_MS);
  });
  // Unknown ends go last, the longest running of them first.
  const slots = working.map((w, i) => ({
    agentId: w.agentId,
    end: ends[i] ?? Number.POSITIVE_INFINITY,
    since: w.startedAt,
  }));
  let lastAsk = working.reduce((max, w) => Math.max(max, w.startedAt), Number.NEGATIVE_INFINITY);
  const starts: (number | null)[] = [];
  const after: string[][] = [];
  waiting.forEach((w, i) => {
    after.push(i === 0 ? [] : [...new Set(waiting.slice(0, i).map((a) => a.agentId))]);
    if (slots.length === 0) {
      starts.push(null);
      return;
    }
    slots.sort((a, b) => a.end - b.end || a.since - b.since);
    const slot = slots[0] as (typeof slots)[number];
    if (i === 0) after[0] = [slot.agentId];
    if (!Number.isFinite(slot.end)) {
      starts.push(null);
      slots[0] = { agentId: w.agentId, end: Number.POSITIVE_INFINITY, since: Number.POSITIVE_INFINITY };
      return;
    }
    let start = Math.max(slot.end, now);
    if (!w.people) start = Math.max(start, lastAsk + ROOM_ASK_SPACING_MS);
    lastAsk = start;
    starts.push(start);
    const d = typicalOf(w.agentId);
    slots[0] = { agentId: w.agentId, end: d === null ? Number.POSITIVE_INFINITY : start + d, since: start };
  });
  return { ends, starts, after };
}

// ponytail: per-process cache, a minute stale at most; the read touches at most 300 finished runs' transcripts.
const typicalCache = new TtlCache<TypicalTurns>(60_000, 1000);

/**
 * The median of each agent's latest `TYPICAL_TURNS` finished computer turns, from its ask (`roomAsk.at`) to the
 * run's end, and the org's median over those, from the last 14 days.
 */
export async function typicalTurns(db: Database, orgId: string): Promise<TypicalTurns> {
  return typicalCache.getOrLoad(orgId, async () => {
    const rows = rowsOf<{ agent_id: string | null; ms: string | number | null }>(
      await db.execute(sql`
        with recent as (
          select agent_id, finished_at, transcript from agent_runs
          where org_id = ${orgId}::uuid and status = 'done' and brain is not null and brain <> 'model'
            and finished_at > now() - interval '14 days'
          order by finished_at desc
          limit 300
        ), turns as (
          select agent_id,
            extract(epoch from finished_at) * 1000 - (transcript->'roomAsk'->>'at')::bigint as ms,
            row_number() over (partition by agent_id order by finished_at desc) as n
          from recent
          where transcript ? 'roomAsk'
        )
        select agent_id, percentile_cont(0.5) within group (order by ms) as ms
        from turns where n <= ${TYPICAL_TURNS} and ms > 0
        group by rollup(agent_id)`),
    );
    const out: TypicalTurns = { byAgent: {}, org: null };
    for (const r of rows) {
      if (r.ms === null) continue;
      if (r.agent_id === null) out.org = Number(r.ms);
      else out.byAgent[r.agent_id] = Number(r.ms);
    }
    return out;
  });
}

const purposeOf = (r: {
  workId: string | null;
  background: boolean;
  authorType: string | null;
  authorUserId: string | null;
  authorAgentId: string | null;
  viaRoutine: unknown;
}): QueuePurpose =>
  r.workId
    ? { kind: "work" }
    : r.background || (r.authorType === "person" && r.viaRoutine)
      ? { kind: "routine" }
      : r.authorType === "agent"
        ? { kind: "agent", agentId: r.authorAgentId }
        : { kind: "person", userId: r.authorUserId };

/**
 * A computer's line as every member of the workspace sees it: the turns working on it now and the runs waiting for
 * room, in the order the engine admits them (`roomHead`), with estimates. Only the org's own computers.
 */
export async function computerQueue(
  db: Database,
  actorId: string,
  orgId: string,
  machineId: string,
  now = Date.now(),
): Promise<ComputerQueue> {
  await requirePermission(db, actorId, orgId, "read");
  const machine = await getMachine(db, orgId, machineId);
  if (!machine) throw new NotFoundError("Computer not found", "machine.not_found");
  const cols = {
    runId: agentRuns.id,
    agentId: agentRuns.agentId,
    channelId: agentRuns.channelId,
    threadRootId: agentRuns.threadRootId,
    triggerMessageId: agentRuns.triggerMessageId,
    workId: agentRuns.workId,
    background: agentRuns.background,
    authorType: messages.authorType,
    authorUserId: messages.authorUserId,
    authorAgentId: messages.authorAgentId,
    viaRoutine: sql<unknown>`${messages.meta}->'routine'`,
  };
  const trigger = and(eq(messages.orgId, agentRuns.orgId), eq(messages.id, agentRuns.triggerMessageId));
  const askAt = sql<string>`(${agentRuns.transcript}->'roomAsk'->>'at')::bigint`;
  const [workingRows, waitingRows, typical] = await Promise.all([
    db
      .select({ ...cols, askAt })
      .from(agentRuns)
      .leftJoin(messages, trigger)
      .where(
        and(
          eq(agentRuns.orgId, orgId),
          eq(agentRuns.status, "running"),
          sql`${agentRuns.transcript}->'roomAsk'->>'machineId' = ${machineId}`,
        ),
      )
      .orderBy(askAt),
    db
      .select({ ...cols, people: sql<boolean>`${peopleSql}` })
      .from(agentRuns)
      .leftJoin(messages, trigger)
      .where(and(eq(agentRuns.orgId, orgId), waitingForRoom(machineId)))
      .orderBy(sql`${peopleSql} desc`, sinceSql, agentRuns.id),
    typicalTurns(db, orgId),
  ]);
  const working = workingRows.map((r) => ({ ...r, startedAt: Number(r.askAt) }));
  const est = estimateQueue(now, working, waitingRows, typical);
  const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());
  const where = (r: { channelId: string; threadRootId: string; triggerMessageId: string }) => ({
    channelId: r.channelId,
    threadId: replyThreadOf(r),
  });
  return {
    machineId,
    name: machine.name,
    working: working.map((r, i) => ({
      runId: r.runId,
      agentId: r.agentId,
      purpose: purposeOf(r),
      where: where(r),
      startedAt: new Date(r.startedAt).toISOString(),
      estimatedEndAt: iso(est.ends[i]),
    })),
    waiting: waitingRows.map((r, i) => ({
      runId: r.runId,
      agentId: r.agentId,
      purpose: purposeOf(r),
      where: where(r),
      people: Boolean(r.people),
      position: i + 1,
      estimatedStartAt: iso(est.starts[i]),
      after: est.after[i] ?? [],
    })),
  };
}
