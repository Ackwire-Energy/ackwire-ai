import { and, type Database, type Executor, eq, schema, sql } from "@agenteschat/db";

const { outbox } = schema;

export type OutboxJob = typeof outbox.$inferSelect;

/**
 * Postgres outbox + job queue (docs/adr/0005-postgres-outbox.md).
 *
 * - `enqueue` runs inside the caller's transaction, so the job exists iff the
 *   change that caused it committed.
 * - Workers claim due rows with `FOR UPDATE SKIP LOCKED` and a lease, renewed
 *   while the handler runs; a worker that dies mid-job stops renewing, loses
 *   the lease and another worker retries it.
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

/** A claimed job is invisible to other workers for this long; `runJob` renews it every third of it while the handler runs. */
export const DEFAULT_LEASE_MS = 10 * 60_000;

/** Delay before attempt n+1 after n failed attempts (last value repeats). */
export const RETRY_BACKOFF_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 60 * 60_000, 3 * 3600_000];

export const retryDelayMs = (attempts: number) =>
  RETRY_BACKOFF_MS[Math.min(Math.max(attempts, 1), RETRY_BACKOFF_MS.length) - 1] ?? 60_000;

export interface ClaimOptions {
  workerId: string;
  batchSize?: number;
  leaseMs?: number;
  now?: Date;
}

/** Claims due jobs: pending ones whose time has come, and processing ones whose lease expired. */
export async function claimJobs(db: Database, options: ClaimOptions): Promise<OutboxJob[]> {
  const now = options.now ?? new Date();
  const leaseUntil = new Date(now.getTime() + (options.leaseMs ?? DEFAULT_LEASE_MS));
  // One statement (no transaction round trips): lock due rows, skipping locked ones, and lease them.
  const claimed = await db
    .update(outbox)
    .set({
      status: "processing",
      attempts: sql`${outbox.attempts} + 1`,
      lockedUntil: leaseUntil,
      lockedBy: options.workerId,
    })
    .where(
      sql`${outbox.id} in (select ${outbox.id} from ${outbox}
        where (${outbox.status} = 'pending' and ${outbox.nextAttemptAt} <= ${now.toISOString()}::timestamptz)
           or (${outbox.status} = 'processing' and ${outbox.lockedUntil} < ${now.toISOString()}::timestamptz)
        order by ${outbox.nextAttemptAt}
        limit ${options.batchSize ?? 20}
        for update skip locked)`,
    )
    .returning();

  // A job whose lease expired after its final attempt is not retried again.
  const runnable: OutboxJob[] = [];
  for (const job of claimed) {
    if (job.attempts > job.maxAttempts) {
      await db
        .update(outbox)
        .set({ status: "failed", lockedUntil: null, lastError: job.lastError ?? "lease expired on the final attempt" })
        .where(eq(outbox.id, job.id));
    } else runnable.push(job);
  }
  return runnable;
}

/** Extends a running job's lease, unless another worker took it over. Returns whether it still owns the job. */
export async function renewLease(
  db: Database,
  job: OutboxJob,
  leaseMs = DEFAULT_LEASE_MS,
  now = new Date(),
): Promise<boolean> {
  const rows = await db
    .update(outbox)
    .set({ lockedUntil: new Date(now.getTime() + leaseMs) })
    .where(and(eq(outbox.id, job.id), eq(outbox.status, "processing"), eq(outbox.lockedBy, job.lockedBy ?? "")))
    .returning({ id: outbox.id });
  return rows.length > 0;
}

/** Marks a job done, unless another worker took it over after our lease expired. */
export async function completeJob(db: Database, job: OutboxJob, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(outbox)
    .set({ status: "done", completedAt: now, lockedUntil: null, lastError: null })
    .where(and(eq(outbox.id, job.id), eq(outbox.status, "processing"), eq(outbox.lockedBy, job.lockedBy ?? "")))
    .returning({ id: outbox.id });
  return rows.length > 0;
}

/** Records a failure: schedules a retry with backoff, or marks the job `failed`. */
export async function failJob(
  db: Database,
  job: OutboxJob,
  error: unknown,
  options: { retryable: boolean; now?: Date },
): Promise<"retry" | "failed"> {
  const now = options.now ?? new Date();
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
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
    .where(and(eq(outbox.id, job.id), eq(outbox.lockedBy, job.lockedBy ?? "")));
  return final ? "failed" : "retry";
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
  const renew = setInterval(() => void renewLease(db, job, leaseMs).catch(() => undefined), leaseMs / 3);
  try {
    if (!handler) throw new PermanentJobError(`no handler for job kind ${job.kind}`);
    await handler(job, { finalAttempt: job.attempts >= job.maxAttempts });
    await completeJob(db, job);
  } catch (error) {
    const outcome = await failJob(db, job, error, { retryable: isRetryable(error) });
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
}

/**
 * The worker's job pool: up to `maxInFlight` jobs at once, and a slot that
 * frees is refilled right away (`onSlotFree`). Unlike `processOutbox`, a
 * long job (a 5-minute agent run) never holds back the jobs claimed after it.
 */
export function createOutboxPump(
  db: Database,
  handlers: JobHandlers,
  options: Omit<ProcessOptions, "batchSize"> & { maxInFlight?: number; onSlotFree?: () => void },
): OutboxPump {
  const max = options.maxInFlight ?? 20;
  const running = new Set<Promise<void>>();
  return {
    async pump() {
      const free = max - running.size;
      if (free <= 0) return 0;
      const jobs = await claimJobs(db, { ...options, batchSize: free });
      for (const job of jobs) {
        const p: Promise<void> = runJob(db, handlers, job, options).finally(() => {
          running.delete(p);
          options.onSlotFree?.();
        });
        running.add(p);
      }
      return jobs.length;
    },
    inFlight: () => running.size,
    async idle() {
      while (running.size > 0) await Promise.all(running);
    },
  };
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
