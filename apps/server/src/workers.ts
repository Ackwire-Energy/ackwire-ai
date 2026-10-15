import type { PubSub } from "@agenteschat/adapters";
import { type Database, ensureMessagePartitions, schema } from "@agenteschat/db";
import {
  type ContextDeps,
  enqueue,
  enqueueIdleReflections,
  expireApprovals,
  expireQuestions,
  fireDueRoutines,
  type JobHandlers,
  listenForRunCancels,
  processOutbox,
  queueApprovalDigests,
  recoverStaleRuns,
} from "@agenteschat/engine";
import type { Logger } from "./logger";

export interface WorkerDeps {
  db: Database;
  handlers: JobHandlers;
  pubsub: PubSub;
  /** Memory jobs (idle reflection, nightly consolidation). */
  context?: ContextDeps;
  /** Approval reminder emails. */
  approvalDigest?: { publicUrl: string; afterHours: number };
  log: Logger;
  workerId?: string;
}

/** Pub/sub topic that wakes every instance's outbox worker (cross-replica, over LISTEN/NOTIFY). */
export const WAKE_TOPIC = "system:outbox-wake";

/** How often each background job runs. */
export const WORKER_INTERVALS_MS = {
  outbox: 1_000,
  partitions: 24 * 3600_000,
  approvals: 60_000,
  approvalDigest: 15 * 60_000,
  reflections: 10 * 60_000,
  consolidation: 24 * 3600_000,
  routines: 30_000,
  /** Runs whose worker died (deploy, crash): also once at boot. */
  recovery: 60_000,
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

  every("questions", WORKER_INTERVALS_MS.approvals, async () => {
    const expired = await expireQuestions({ db, pubsub: deps.pubsub });
    if (expired > 0) log.info("agent questions expired", { expired });
  });

  every("recovery", WORKER_INTERVALS_MS.recovery, async () => {
    const r = await recoverStaleRuns({ db, pubsub: deps.pubsub });
    if (r.resumed.length + r.failed.length + r.requeued.length > 0) log.info("stale runs recovered", r);
  });

  every("routines", WORKER_INTERVALS_MS.routines, async () => {
    const fired = await fireDueRoutines({ db, pubsub: deps.pubsub });
    if (fired > 0) log.info("routines fired", { fired });
  });

  const digest = deps.approvalDigest;
  if (digest) {
    every("approvalDigest", WORKER_INTERVALS_MS.approvalDigest, async () => {
      const queued = await queueApprovalDigests(db, digest.publicUrl, digest.afterHours);
      if (queued > 0) log.info("approval reminder emails queued", { queued });
    });
  }

  const context = deps.context;
  if (context) {
    every("reflections", WORKER_INTERVALS_MS.reflections, async () => {
      const queued = await enqueueIdleReflections(context);
      if (queued > 0) log.info("idle threads queued for reflection", { queued });
    });
    // One consolidation job per organization per day (dedupe key = org + date: replicas don't double it).
    every("consolidation", WORKER_INTERVALS_MS.consolidation, async () => {
      const day = new Date().toISOString().slice(0, 10);
      for (const org of await db.select({ id: schema.organizations.id }).from(schema.organizations)) {
        await enqueue(db, {
          orgId: org.id,
          kind: "context.consolidate",
          payload: {},
          dedupeKey: `context.consolidate:${org.id}:${day}`,
        });
      }
    });
  }

  const offWake = deps.pubsub.subscribe(WAKE_TOPIC, () => void ticks.get("outbox")?.());
  // A person canceled a run: the instance executing it aborts it.
  const offCancel = listenForRunCancels(deps.pubsub);

  return {
    /** Process the outbox now instead of waiting for the next interval. */
    wake() {
      void ticks.get("outbox")?.();
    },
    /** Wake this instance and every other one (after a commit that enqueued work). */
    wakeAll() {
      void ticks.get("outbox")?.();
      void deps.pubsub.publish(WAKE_TOPIC, { type: "wake" }).catch(() => {});
    },
    stop() {
      stopped = true;
      offWake();
      offCancel();
      for (const timer of timers) clearInterval(timer);
    },
  };
}
