import { and, asc, type Database, type Executor, eq, lt, lte, or, schema, sql } from "@agenteschat/db";

const { outbox } = schema;

export type OutboxJob = typeof outbox.$inferSelect;

/**
 * Postgres outbox + job queue (docs/adr/0005-postgres-outbox.md).
 *
 * - `enqueue` runs inside the caller's transaction, so the job exists iff the
 *   change that caused it committed.
 * - Workers claim due rows with `FOR UPDATE SKIP LOCKED` and a lease; a
 *   worker that dies mid-job loses the lease and another worker retries it.
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

/** A claimed job is invisible to other workers for this long. Longer than any model call we allow. */
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
  const claimed = await db.transaction(async (tx) => {
    const due = await tx
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        or(
          and(eq(outbox.status, "pending"), lte(outbox.nextAttemptAt, now)),
          and(eq(outbox.status, "processing"), lt(outbox.lockedUntil, now)),
        ),
      )
      .orderBy(asc(outbox.nextAttemptAt))
      .limit(options.batchSize ?? 20)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(outbox)
      .set({
        status: "processing",
        attempts: sql`${outbox.attempts} + 1`,
        lockedUntil: leaseUntil,
        lockedBy: options.workerId,
      })
      .where(
        sql`${outbox.id} in (${sql.join(
          due.map((d) => sql`${d.id}`),
          sql`, `,
        )})`,
      )
      .returning();
  });

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

/** Claims one batch and runs it (jobs in parallel). Returns how many jobs were attempted. */
export async function processOutbox(db: Database, handlers: JobHandlers, options: ProcessOptions): Promise<number> {
  const jobs = await claimJobs(db, options);
  await Promise.all(
    jobs.map(async (job) => {
      const handler = handlers[job.kind];
      try {
        if (!handler) throw new PermanentJobError(`no handler for job kind ${job.kind}`);
        await handler(job, { finalAttempt: job.attempts >= job.maxAttempts });
        await completeJob(db, job);
      } catch (error) {
        const outcome = await failJob(db, job, error, { retryable: isRetryable(error) });
        options.onError?.(job, error, outcome);
      }
    }),
  );
  return jobs.length;
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
