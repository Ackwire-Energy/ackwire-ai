import type { PubSub } from "@agenteschat/adapters";
import { type Database, ensureMessagePartitions } from "@agenteschat/db";
import { expireApprovals, type JobHandlers, processOutbox } from "@agenteschat/engine";
import type { Logger } from "./logger";

export interface WorkerDeps {
  db: Database;
  handlers: JobHandlers;
  pubsub: PubSub;
  log: Logger;
  workerId?: string;
}

/** How often each background job runs. */
export const WORKER_INTERVALS_MS = {
  outbox: 1_000,
  partitions: 24 * 3600_000,
  approvals: 60_000,
};

/**
 * Background jobs inside the server process (docs/adr/0005-postgres-outbox.md):
 * no separate worker deployment, no Redis. Every job is safe on several
 * replicas at once (outbox rows are claimed with SKIP LOCKED + lease;
 * partition creation takes an advisory lock).
 */
export function startWorkers(deps: WorkerDeps) {
  const { db, log } = deps;
  const workerId = deps.workerId ?? `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const timers: Timer[] = [];
  const ticks = new Map<string, () => Promise<void>>();
  let stopped = false;

  /** Runs `job` every `ms`, never overlapping with itself, logging failures. */
  const every = (name: string, ms: number, job: () => Promise<void>) => {
    let running = false;
    let again = false;
    const tick = async () => {
      if (stopped) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        await job();
      } catch (error) {
        log.error("background job failed", { job: name, error: String(error) });
      } finally {
        running = false;
        if (again) {
          again = false;
          void tick();
        }
      }
    };
    ticks.set(name, tick);
    timers.push(setInterval(tick, ms));
    void tick();
  };

  every("outbox", WORKER_INTERVALS_MS.outbox, async () => {
    while (
      !stopped &&
      (await processOutbox(db, deps.handlers, {
        workerId,
        onError: (job, error, outcome) =>
          log.warn("outbox job failed", {
            kind: job.kind,
            jobId: job.id,
            attempt: job.attempts,
            outcome,
            error: String(error),
          }),
      })) > 0
    ) {}
  });

  every("partitions", WORKER_INTERVALS_MS.partitions, async () => {
    const created = await ensureMessagePartitions(db);
    if (created > 0) log.info("created message partitions", { created });
  });

  every("approvals", WORKER_INTERVALS_MS.approvals, async () => {
    const expired = await expireApprovals({ db, pubsub: deps.pubsub });
    if (expired > 0) log.info("approvals expired", { expired });
  });

  return {
    /** Process the outbox now instead of waiting for the next interval. */
    wake() {
      void ticks.get("outbox")?.();
    },
    stop() {
      stopped = true;
      for (const timer of timers) clearInterval(timer);
    },
  };
}
