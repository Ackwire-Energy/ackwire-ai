import { and, type Database, type Executor, eq, inArray, type SQL, schema, sql } from "@agenteschat/db";
import { percentile } from "./format";

const { outbox } = schema;

export type OutboxJob = typeof outbox.$inferSelect;

/**
 * Postgres outbox + job queue (docs/adr/0005-postgres-outbox.md).
 *
 * - `enqueue` runs inside the caller's transaction, so the job exists iff the
 *   change that caused it committed.
 * - Workers claim due rows with `FOR UPDATE SKIP LOCKED` and a lease, renewed
 *   while the handler runs; a worker that dies mid-job stops renewing, loses
 *   the lease and another worker retries it. Not the job of an agent run
 *   still running: the stale-run sweep takes that one (`orphanedRunJobSql`).
 * - Renewing, finishing and failing a job are fenced by its claim (`held`):
 *   a late worker never overwrites a later claim, its own included.
 * - Failures retry with backoff until `max_attempts`, then the row is `failed`.
 *
 * Handlers must be idempotent: a job can run more than once (lease expiry).
 */
export interface EnqueueInput {
  /** Null only for jobs outside any organization (e.g. a password-reset email). */
  orgId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  /** Enqueueing the same key twice is a no-op. */
  dedupeKey?: string;
  runAt?: Date;
  maxAttempts?: number;
}

export async function enqueue(db: Executor, input: EnqueueInput): Promise<void> {
  await db
    .insert(outbox)
    .values({
      orgId: input.orgId,
      kind: input.kind,
      payload: input.payload,
      dedupeKey: input.dedupeKey,
      nextAttemptAt: input.runAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? 8,
    })
    .onConflictDoNothing();
}

/**
 * A claimed job is invisible to other workers for this long; `runJob` renews it every third of it while the handler
 * runs. Also how late the jobs of a worker that died come back.
 */
export const DEFAULT_LEASE_MS = 2 * 60_000;

/** A handler still running after this (hung on a socket) stops renewing: its lease expires and another worker retries. */
export const MAX_RENEWED_MS = 6 * 3600_000;

/** Delay before attempt n+1 after n failed attempts (last value repeats). */
export const RETRY_BACKOFF_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000, 3 * 3600_000];

export const retryDelayMs = (attempts: number) =>
  RETRY_BACKOFF_MS[Math.min(Math.max(attempts, 1), RETRY_BACKOFF_MS.length) - 1] ?? 60_000;

export interface ClaimOptions {
  workerId: string;
  batchSize?: number;
  leaseMs?: number;
  now?: Date;
  /**
   * At most this many long jobs in this claim (`LONG_JOB_KINDS`), background ones included: the pump's
   * free long slots. Undefined: no cap (batches, tests).
   */
  maxLong?: number;
  /**
   * At most this many background jobs in this claim (`backgroundJobSql`): the pump's free background
   * slots. Undefined: no cap (batches, tests).
   */
  maxBackground?: number;
  /** Measurements: `queue_wait_ms` for each claimed job (from when it was due to when a worker took it). */
  onTiming?(name: string, ms: number, attrs: Record<string, unknown>): void;
}

/** A claimed job, and its lane: long work and background work count against the pump's slots for them. */
export type ClaimedJob = OutboxJob & { long: boolean; background: boolean };

/**
 * Kinds that can hold a slot for minutes, or that sweeps queue by the hundred with nobody waiting on them
 * (ADR 0053 §10). They share the long slots, so a quick job (a message's routing, its notifications, search
 * indexing, push, email) never waits behind them. Every other kind is quick. Background work is long too.
 */
export const LONG_JOB_KINDS = [
  "agent_run.execute",
  "routine.run",
  "autonomy.later",
  "agent_work.check_in",
  "agent.follow_up",
  "context.consolidate",
  "context.reflect",
  "search.reindex",
  "storage.migrate",
  "skills.update",
  "vault.sync",
  "org.delete",
  "account.delete",
  "channel.delete",
  "org.files.purge",
  "user.files.purge",
];

const longJobSql = inArray(outbox.kind, LONG_JOB_KINDS);

/** The run an `agent_run.execute` job executes (null for a malformed payload). */
const runOfJob = sql`case when ${outbox.payload}->>'runId' ~ '^[0-9a-fA-F-]{36}$' then (${outbox.payload}->>'runId')::uuid end`;

/**
 * Background work (ADR 0053 §10): a routine firing (`routine.run`), or the execution of a routine's
 * background run (`agent_run.execute` of a run with `agent_runs.background`). A person's message never
 * waits behind it: it holds at most half of a worker's long slots. Both kinds are in `LONG_JOB_KINDS`.
 */
const backgroundJobSql = sql`(${outbox.kind} = 'routine.run' or (${outbox.kind} = 'agent_run.execute' and exists (
  select 1 from ${schema.agentRuns} r where r.id = ${runOfJob} and r.background)))`;

/**
 * The job of a run still `running`. When its worker stops holding it without handing it back (it died, or a step
 * outlived the shutdown's drain), the stale-run sweep takes it (`recoverStaleRuns`: a tool cut in half fails the
 * run instead of running twice), never a plain retry.
 */
const orphanedRunJobSql = sql`(${outbox.kind} = 'agent_run.execute' and exists (
  select 1 from ${schema.agentRuns} r where r.id = ${runOfJob} and r.status = 'running'))`;

const LEASE_LOST = "lease expired on the final attempt";

/**
 * Claims due jobs: pending ones whose time has come, and processing ones whose lease expired (except a dead
 * worker's agent run, `orphanedRunJobSql`). Quick jobs first, then long ones up to `maxLong` in the slots left,
 * then background ones up to `maxBackground` in the long room left.
 */
export async function claimJobs(db: Database, options: ProcessOptions): Promise<ClaimedJob[]> {
  const now = options.now ?? new Date();
  const batch = options.batchSize ?? 20;
  const quick = await claimWhere(db, options, now, sql`not ${longJobSql}`, batch);
  const longRoom = Math.min(batch - quick.length, options.maxLong ?? batch);
  const long =
    longRoom > 0 ? await claimWhere(db, options, now, sql`${longJobSql} and not ${backgroundJobSql}`, longRoom) : [];
  const room = Math.min(longRoom - long.length, options.maxBackground ?? batch);
  const background = room > 0 ? await claimWhere(db, options, now, backgroundJobSql, room) : [];
  const claimed: ClaimedJob[] = [
    ...quick.map((job) => ({ ...job, long: false, background: false })),
    ...long.map((job) => ({ ...job, long: true, background: false })),
    ...background.map((job) => ({ ...job, long: true, background: true })),
  ];

  // A job whose lease expired after its final attempt is not retried again. Its worker died or hung on it, which
  // nothing else sees: it is told as a failed job.
  const runnable: ClaimedJob[] = [];
  for (const job of claimed) {
    if (job.attempts > job.maxAttempts) {
      await db
        .update(outbox)
        .set({ status: "failed", lockedUntil: null, lastError: job.lastError ?? LEASE_LOST })
        .where(eq(outbox.id, job.id));
      options.onError?.(job, new Error(LEASE_LOST), "failed");
    } else {
      runnable.push(job);
      options.onTiming?.("queue_wait_ms", Math.max(0, now.getTime() - job.nextAttemptAt.getTime()), {
        jobId: job.id,
        kind: job.kind,
        attempt: job.attempts,
        long: job.long,
        background: job.background,
      });
    }
  }
  return runnable;
}

/**
 * How many of a lane's oldest due jobs take turns by workspace in one claim. Past that, a backlog is more than the
 * workers can run, which the lane's alarm tells (`laneAlarm`), and the jobs beyond wait in order.
 */
export const FAIR_SCAN = 10_000;

/**
 * One statement (no transaction round trips): lock due rows matching `filter`, skipping locked ones; lease them.
 * Workspaces take turns (ADR 0161): each one's due jobs are ranked oldest first, after the jobs of the lane it
 * already runs on any worker, so a workspace that holds more than another one waiting claims after it, and one
 * workspace's burst queues only that workspace. Ranked without locks (a window can't take `FOR UPDATE`), then
 * locked and checked again.
 */
function claimWhere(db: Database, options: ClaimOptions, now: Date, filter: SQL, limit: number) {
  const leaseUntil = new Date(now.getTime() + (options.leaseMs ?? DEFAULT_LEASE_MS));
  const at = sql`${now.toISOString()}::timestamptz`;
  const due = sql`((${outbox.status} = 'pending' and ${outbox.nextAttemptAt} <= ${at})
      or (${outbox.status} = 'processing' and ${outbox.lockedUntil} < ${at} and not ${orphanedRunJobSql}))
    and ${filter}`;
  return db
    .update(outbox)
    .set({
      status: "processing",
      attempts: sql`${outbox.attempts} + 1`,
      lockedUntil: leaseUntil,
      lockedBy: options.workerId,
    })
    .where(
      sql`${outbox.id} in (
        with candidates as materialized (
          select ${outbox.id} as id, ${outbox.orgId} as org_id, ${outbox.nextAttemptAt} as due_at from ${outbox}
          where ${due} order by ${outbox.nextAttemptAt} limit ${FAIR_SCAN}
        ), busy as materialized (
          select ${outbox.orgId} as org_id, count(*)::int as n from ${outbox}
          where ${outbox.status} = 'processing' and ${outbox.lockedUntil} >= ${at} and ${filter}
          group by ${outbox.orgId}
        ), turns as materialized (
          select c.id, c.due_at,
            coalesce(b.n, 0) + row_number() over (partition by c.org_id order by c.due_at, c.id) as turn
          from candidates c left join busy b on b.org_id is not distinct from c.org_id
        )
        select ${outbox.id} from ${outbox} join turns t on t.id = ${outbox.id}
        where ${due}
        order by t.turn, t.due_at
        limit ${limit}
        for update of ${outbox} skip locked)`,
    )
    .returning();
}

/**
 * This claim of the job, still held. A worker's id is one per process, so the attempt it was claimed for tells this
 * claim from a later one by the same worker.
 */
const held = (job: OutboxJob) =>
  and(
    eq(outbox.id, job.id),
    eq(outbox.status, "processing"),
    eq(outbox.lockedBy, job.lockedBy ?? ""),
    eq(outbox.attempts, job.attempts),
  );

/** Extends a running job's lease, unless it was taken over. Returns whether it still holds the job. */
export async function renewLease(
  db: Database,
  job: OutboxJob,
  leaseMs = DEFAULT_LEASE_MS,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(outbox)
    .set({ lockedUntil: new Date(now.getTime() + leaseMs) })
    .where(held(job))
    .returning({ id: outbox.id });
  return rows.length > 0;
}

/** Marks a job done, unless it was taken over after its lease expired. */
export async function completeJob(db: Database, job: OutboxJob, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(outbox)
    .set({ status: "done", completedAt: now, lockedUntil: null, lastError: null })
    .where(held(job))
    .returning({ id: outbox.id });
  return rows.length > 0;
}

/** Back in the queue, due `now`, with the attempt it was claimed for given back: its worker stopped, not the job. */
const handedBack = (now: Date) => ({
  status: "pending" as const,
  attempts: sql`greatest(${outbox.attempts} - 1, 0)`,
  lockedUntil: null,
  lockedBy: null,
  nextAttemptAt: now,
});

/** A handler that stopped because its worker is shutting down throws an error with `handback: true`. */
export const isHandback = (error: unknown) => (error as { handback?: unknown } | null)?.handback === true;

/**
 * Records a failure: schedules a retry with backoff, or marks the job `failed`. A handback (`isHandback`) is no
 * failure: the job is due again at once, the attempt not spent.
 */
export async function failJob(
  db: Database,
  job: OutboxJob,
  error: unknown,
  options: { retryable: boolean; now?: Date },
): Promise<"retry" | "failed"> {
  const now = options.now ?? new Date();
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
  if (isHandback(error)) {
    await db
      .update(outbox)
      .set({ ...handedBack(now), lastError: message })
      .where(held(job));
    return "retry";
  }
  const final = !options.retryable || job.attempts >= job.maxAttempts;
  await db
    .update(outbox)
    .set(
      final
        ? { status: "failed", lastError: message, lockedUntil: null }
        : {
            status: "pending",
            lastError: message,
            lockedUntil: null,
            nextAttemptAt: new Date(now.getTime() + retryDelayMs(job.attempts)),
          },
    )
    .where(held(job));
  return final ? "failed" : "retry";
}

/**
 * A stopping worker's jobs still running: back in the queue at once for the next instance instead of waiting out
 * their lease. Not a run still `running` (`orphanedRunJobSql`): its step may still be under way, a tool that
 * ignores the shutdown included, so the sweep decides once its beat stops. Returns how many.
 */
export async function releaseJobs(db: Database, workerId: string, now = new Date()): Promise<number> {
  const rows = await db
    .update(outbox)
    .set(handedBack(now))
    .where(and(eq(outbox.status, "processing"), eq(outbox.lockedBy, workerId), sql`not ${orphanedRunJobSql}`))
    .returning({ id: outbox.id });
  return rows.length;
}

/** Throw from a handler to fail the job without retrying. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

export interface JobContext {
  /** True on the job's last allowed attempt: handlers should give up cleanly instead of rethrowing. */
  finalAttempt: boolean;
  /** Whether this claim still holds the job: a stale-run recovery may have taken it since. */
  owned?(): Promise<boolean>;
  /** The handler gave up on `error` without throwing (it ended its work as failed): told like a failed job. */
  failed?(error: unknown): void;
}

export type JobHandler = (job: OutboxJob, ctx: JobContext) => Promise<void>;
export type JobHandlers = Record<string, JobHandler>;

const isRetryable = (error: unknown) => {
  if (error instanceof PermanentJobError) return false;
  const flag = (error as { retryable?: unknown } | null)?.retryable;
  return typeof flag === "boolean" ? flag : true;
};

export interface ProcessOptions extends ClaimOptions {
  onError?: (job: OutboxJob, error: unknown, outcome: "retry" | "failed") => void;
}

async function runJob(db: Database, handlers: JobHandlers, job: OutboxJob, options: ProcessOptions) {
  const handler = handlers[job.kind];
  // A long handler (an agent run can outlast the lease) keeps its lease so no other worker re-claims it mid-run.
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const until = Date.now() + MAX_RENEWED_MS;
  const renew = setInterval(() => {
    if (Date.now() > until) return clearInterval(renew);
    // Taken over (our lease lapsed, or a stale-run recovery ended it): renewing again can't help.
    void renewLease(db, job, leaseMs).then(
      (owned) => owned || clearInterval(renew),
      () => undefined,
    );
  }, leaseMs / 3);
  const owned = async () => {
    const [row] = await db.select({ id: outbox.id }).from(outbox).where(held(job));
    return Boolean(row);
  };
  try {
    if (!handler) throw new PermanentJobError(`no handler for job kind ${job.kind}`);
    const failed = (error: unknown) => options.onError?.(job, error, "failed");
    await handler(job, { finalAttempt: job.attempts >= job.maxAttempts, owned, failed });
    await completeJob(db, job, options.now);
  } catch (error) {
    // The database may be what failed: the failure can't be recorded then, and the lease brings the job back.
    const outcome = await failJob(db, job, error, { retryable: isRetryable(error), now: options.now }).catch(
      () => "retry" as const,
    );
    options.onError?.(job, error, outcome);
  } finally {
    clearInterval(renew);
  }
}

/** Claims one batch and runs it (jobs in parallel). Returns how many jobs were attempted. */
export async function processOutbox(db: Database, handlers: JobHandlers, options: ProcessOptions): Promise<number> {
  const jobs = await claimJobs(db, options);
  await Promise.all(jobs.map((job) => runJob(db, handlers, job, options)));
  return jobs.length;
}

export interface OutboxPump {
  /** Claims as many due jobs as there are free slots and starts them; returns how many it started. */
  pump(): Promise<number>;
  /** Jobs running now. */
  inFlight(): number;
  /** Resolves when every running job has finished. */
  idle(): Promise<void>;
  /**
   * One step of the self-tuning, run every `WORKER_INTERVALS_MS.outboxTune`: what each lane waited since the last
   * step resizes its slots (`resizeLanes`), and a lane that keeps waiting is told (`laneAlarm`). `loopLagMs`: how
   * late the process's timers fired meanwhile.
   */
  tune(input?: { now?: Date; loopLagMs?: number }): Promise<PumpTune>;
}

/** The pump's lanes: quick jobs, long ones (`LONG_JOB_KINDS`), and background work among the long ones (routines). */
export const LANES = ["quick", "long", "background"] as const;
export type Lane = (typeof LANES)[number];

/** A pump's slots: the ones only quick jobs take, and the ones long jobs may hold at most. */
export interface LaneSlots {
  quick: number;
  long: number;
}

/** How far each lane may grow, and all of them together. */
export interface LaneLimits {
  lanes: LaneSlots;
  total: number;
}

/** What a lane saw since the pump's last step. */
export interface LaneWindow {
  /** How long its jobs waited for a slot: the p90 of its claims, or its oldest job still due when that is longer. */
  waitMs: number;
  /** The most of its jobs running at once. */
  peak: number;
}

export interface PumpTune extends LaneSlots {
  waits: Record<Lane, number>;
  resized: boolean;
  /** The lanes to tell about now (`laneAlarm`). */
  slow: Lane[];
}

/** A job claimed this long after it was due found its lane full: the pump looks every second, and when woken. */
export const LANE_FULL_MS = 2_000;
/** A lane is slow past this wait for a slot; told once it stayed slow `LANE_SLOW_FOR_MS`, at most every hour. */
export const LANE_SLOW_MS: Record<Lane, number> = { quick: 5_000, long: 30_000, background: 5 * 60_000 };
export const LANE_SLOW_FOR_MS = 5 * 60_000;
export const LANE_SLOW_EVERY_MS = 3600_000;
/** Timers this late mean a busy processor: more jobs would only wait on it, so the slots don't grow. */
export const LOOP_LAG_MAX_MS = 200;
/** Quick jobs per database connection the quick lane grows to at most: they read and write more than they wait. */
export const QUICK_JOBS_PER_DB_CONNECTION = 4;
/**
 * What a run waiting on its model or its computer holds in memory, with room to spare (`run-cost.test.ts` measures
 * it). Runs hold no database connection while they wait (ADR 0161), so memory is what bounds the long lane.
 */
export const RUN_MEMORY_BYTES = 4 * 1024 * 1024;
/** The share of the process's memory its long jobs may take, beside what it held at boot. */
export const RUNS_MEMORY_SHARE = 0.5;

/** The share of a worker's long slots background jobs may hold at most (ADR 0053 §10), never less than one. */
export const backgroundSlotsOf = (longSlots: number) => Math.max(1, Math.floor(longSlots / 2));

/**
 * How far a pump's lanes may grow from `base`: the quick lane to `QUICK_JOBS_PER_DB_CONNECTION` per connection, the
 * long one to the runs the memory left holds (`RUN_MEMORY_BYTES` each, in `RUNS_MEMORY_SHARE` of `memoryBytes` less
 * what the process holds now), and both together to `cap` when one is set. Never below the base.
 */
export function laneLimits(
  base: LaneSlots,
  host: { memoryBytes: number; rssBytes: number; dbConnections: number },
  cap?: number,
): LaneLimits {
  const runs = Math.floor((host.memoryBytes * RUNS_MEMORY_SHARE - host.rssBytes) / RUN_MEMORY_BYTES);
  const lanes = {
    quick: Math.max(base.quick, QUICK_JOBS_PER_DB_CONNECTION * host.dbConnections),
    long: Math.max(base.long, runs),
  };
  return { lanes, total: Math.max(base.quick + base.long, cap ?? lanes.quick + lanes.long) };
}

/**
 * One step of the pump's self-tuning (ADR 0161): a lane whose jobs waited for a slot doubles, the quick lane
 * first, within its limit and the total's, unless the processor is busy (`LOOP_LAG_MAX_MS`); a lane that waited for
 * nothing and used at most half its slots halves, never below its base. Pure.
 */
export function resizeLanes(
  slots: LaneSlots,
  base: LaneSlots,
  limits: LaneLimits,
  window: Record<keyof LaneSlots, LaneWindow>,
  loopLagMs = 0,
): LaneSlots {
  const next = { ...slots };
  for (const lane of ["quick", "long"] as const) {
    const room = Math.max(0, limits.total - next.quick - next.long);
    if (window[lane].waitMs > LANE_FULL_MS) {
      if (loopLagMs <= LOOP_LAG_MAX_MS)
        next[lane] = Math.min(limits.lanes[lane], next[lane] + Math.min(room, Math.max(1, next[lane])));
    } else if (window[lane].peak <= next[lane] / 2) next[lane] = Math.max(base[lane], Math.ceil(next[lane] / 2));
  }
  return next;
}

/**
 * Whether to tell, now, about a lane slow at each step (`laneAlarm()(slow, now)`): once it stayed slow for
 * `LANE_SLOW_FOR_MS`, then at most every `LANE_SLOW_EVERY_MS`, whether or not it recovered in between.
 */
export function laneAlarm() {
  let since: number | null = null;
  let toldAt = Number.NEGATIVE_INFINITY;
  return (slow: boolean, now: number) => {
    if (!slow) {
      since = null;
      return false;
    }
    since ??= now;
    if (now - since < LANE_SLOW_FOR_MS || now - toldAt < LANE_SLOW_EVERY_MS) return false;
    toldAt = now;
    return true;
  };
}

/** How long the oldest job still due in each lane has waited (0: none waits). */
async function oldestDueMs(db: Database, now: Date): Promise<Record<Lane, number>> {
  const at = sql`${now.toISOString()}::timestamptz`;
  const age = (lane: SQL) =>
    sql<number | null>`1000 * extract(epoch from ${at} - min(${outbox.nextAttemptAt}) filter (where ${lane}))::float8`;
  const [row] = await db
    .select({
      quick: age(sql`not ${longJobSql}`),
      long: age(sql`${longJobSql} and not ${backgroundJobSql}`),
      background: age(backgroundJobSql),
    })
    .from(outbox)
    .where(sql`${outbox.status} = 'pending' and ${outbox.nextAttemptAt} <= ${at}`);
  return { quick: Number(row?.quick ?? 0), long: Number(row?.long ?? 0), background: Number(row?.background ?? 0) };
}

/**
 * The worker's job pool: up to `maxInFlight` jobs at once, and a slot that
 * frees is refilled right away (`onSlotFree`). Unlike `processOutbox`, a
 * long job (a 5-minute agent run) never holds back the jobs claimed after it.
 * `quickSlots` of them are for quick jobs only: long jobs (`LONG_JOB_KINDS`)
 * hold the rest at most, so a message's routing never waits behind agent
 * runs. Background jobs (routines) hold at most half of the long slots
 * (`backgroundSlotsOf`), so a person's run always finds one. `tune` grows a
 * lane that waits, within `limits` (`laneLimits`), and shrinks it back once it
 * doesn't. Several pumps, in one process or many, share one database:
 * claims never overlap and workspaces take turns across all of them.
 */
export function createOutboxPump(
  db: Database,
  handlers: JobHandlers,
  options: Omit<ProcessOptions, "batchSize" | "maxLong" | "maxBackground"> & {
    maxInFlight?: number;
    quickSlots?: number;
    /** How far `tune` may grow the lanes (`laneLimits`); default: where they start, so they never grow. */
    limits?: LaneLimits;
    onSlotFree?: () => void;
  },
): OutboxPump {
  const max = options.maxInFlight ?? 20;
  const base: LaneSlots = { quick: options.quickSlots ?? 0, long: max - (options.quickSlots ?? 0) };
  const limits = options.limits ?? { lanes: base, total: max };
  let slots = { ...base };
  const running = new Set<Promise<void>>();
  let longRunning = 0;
  let backgroundRunning = 0;
  const noWaits = (): Record<Lane, number[]> => ({ quick: [], long: [], background: [] });
  let waits = noWaits();
  const peak: LaneSlots = { quick: 0, long: 0 };
  const alarms = { quick: laneAlarm(), long: laneAlarm(), background: laneAlarm() };
  const onTiming: NonNullable<ClaimOptions["onTiming"]> = (name, ms, attrs) => {
    if (name === "queue_wait_ms") waits[attrs.background ? "background" : attrs.long ? "long" : "quick"].push(ms);
    options.onTiming?.(name, ms, attrs);
  };
  return {
    async pump() {
      const free = slots.quick + slots.long - running.size;
      if (free <= 0) return 0;
      const jobs = await claimJobs(db, {
        ...options,
        onTiming,
        batchSize: free,
        maxLong: Math.max(0, slots.long - longRunning),
        maxBackground: Math.max(0, backgroundSlotsOf(slots.long) - backgroundRunning),
      });
      for (const job of jobs) {
        if (job.long) longRunning++;
        if (job.background) backgroundRunning++;
        const p: Promise<void> = runJob(db, handlers, job, options).finally(() => {
          running.delete(p);
          if (job.long) longRunning--;
          if (job.background) backgroundRunning--;
          options.onSlotFree?.();
        });
        running.add(p);
      }
      peak.quick = Math.max(peak.quick, running.size - longRunning);
      peak.long = Math.max(peak.long, longRunning);
      return jobs.length;
    },
    inFlight: () => running.size,
    async idle() {
      while (running.size > 0) await Promise.all(running);
    },
    async tune({ now = new Date(), loopLagMs = 0 } = {}) {
      const due = await oldestDueMs(db, now);
      const waited = (lane: Lane) => Math.max(percentile(waits[lane], 0.9), due[lane]);
      const w = { quick: waited("quick"), long: waited("long"), background: waited("background") };
      // Background work waiting for its share waits for the long lane to grow too.
      const window = {
        quick: { waitMs: w.quick, peak: peak.quick },
        long: { waitMs: Math.max(w.long, w.background), peak: peak.long },
      };
      const next = resizeLanes(slots, base, limits, window, loopLagMs);
      const resized = next.quick !== slots.quick || next.long !== slots.long;
      slots = next;
      waits = noWaits();
      peak.quick = running.size - longRunning;
      peak.long = longRunning;
      const slow = LANES.filter((lane) => alarms[lane](w[lane] > LANE_SLOW_MS[lane], now.getTime()));
      return { ...slots, waits: w, resized, slow };
    },
  };
}

/**
 * Finished jobs (`done`, `failed`) keep their content `days` days (ADR 0005), then lose their payload and error.
 * The row stays, so its `dedupe_key` still refuses a second enqueue. Only pending and running jobs' payloads are
 * ever read. Returns how many rows it cleared.
 */
export async function clearOldOutboxPayloads(db: Executor, days = 30): Promise<number> {
  const before = new Date(Date.now() - days * 86_400_000);
  // ponytail: one daily scan with no index, add a partial index if the outbox passes a few million rows.
  const cleared = await db
    .update(outbox)
    .set({ payload: {}, lastError: null })
    .where(
      and(
        inArray(outbox.status, ["done", "failed"]),
        sql`coalesce(${outbox.completedAt}, ${outbox.createdAt}) < ${before.toISOString()}::timestamptz`,
        sql`(${outbox.payload} <> '{}'::jsonb or ${outbox.lastError} is not null)`,
      ),
    )
    .returning({ id: outbox.id });
  return cleared.length;
}

/** Runs batches until nothing is due. For tests and CLI tools; workers call `processOutbox` on an interval. */
export async function drainOutbox(
  db: Database,
  handlers: JobHandlers,
  options: Omit<ProcessOptions, "workerId"> & { workerId?: string; maxBatches?: number } = {},
): Promise<number> {
  let total = 0;
  for (let i = 0; i < (options.maxBatches ?? 100); i++) {
    const n = await processOutbox(db, handlers, { workerId: "drain", ...options });
    if (n === 0) break;
    total += n;
  }
  return total;
}
