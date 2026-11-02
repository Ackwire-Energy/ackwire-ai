import type { PubSub } from "@agenteschat/adapters";
import { type Database, ensureMessagePartitions, schema } from "@agenteschat/db";
import {
  type ArtifactDeps,
  type BrowserLive,
  type ContextDeps,
  clearOldOutboxPayloads,
  createOutboxPump,
  type DesktopControl,
  enqueue,
  enqueueAutonomyReport,
  enqueueIdleReflections,
  enqueueOverdueDeletions,
  enqueueWaitlistContacts,
  expireApprovals,
  expireBrowserHandoffs,
  expireConsultations,
  expireQuestions,
  expireSecretRequests,
  fireDueRoutines,
  isHandback,
  type JobHandlers,
  listenForRunCancels,
  type MailDeps,
  type OutboxJob,
  pollMailWatches,
  postAutonomyDigests,
  pruneDeletionCodes,
  pruneJoinRequests,
  pruneMessageClientIds,
  pruneOperatorEvents,
  pruneRoutineHookCalls,
  purgeApps,
  purgeDeletedArtifacts,
  queueApprovalDigests,
  reapRoutineRuns,
  reconcileComposioAccounts,
  reconcileComposioConnectors,
  reconcileWorks,
  recoverStaleRuns,
  releaseJobs,
  sweepEndedInboxes,
  wakeSnoozedNotifications,
} from "@agenteschat/engine";
import { isExpectedError } from "./http/errors";
import type { Logger } from "./logger";

/** An id from a job's payload, never the rest of it (it can hold people's text). */
const idOf = (value: unknown) => (typeof value === "string" ? value : undefined);

/**
 * A failed attempt of an outbox job, as an error line (so reported, with its kind and attempt) unless it is a worker
 * stopping, a refusal the engine expects, or a failure its code calls transient that will be tried again: one that
 * runs out of attempts is reported too.
 */
export function logJobFailure(log: Logger, job: OutboxJob, error: unknown, outcome: "retry" | "failed") {
  const transient = (error as { retryable?: unknown } | null)?.retryable === true && outcome === "retry";
  const quiet = isHandback(error) || isExpectedError(error) || transient;
  (quiet ? log.warn : log.error)("outbox job failed", {
    kind: job.kind,
    jobId: job.id,
    attempt: job.attempts,
    outcome,
    orgId: job.orgId ?? undefined,
    runId: idOf(job.payload.runId),
    agentId: idOf(job.payload.agentId),
    machineId: idOf(job.payload.machineId),
    error,
  });
}

export interface WorkerDeps {
  db: Database;
  handlers: JobHandlers;
  pubsub: PubSub;
  /** Memory jobs (idle reflection, nightly consolidation). */
  context?: ContextDeps;
  /** Drive files (purging deleted ones after 30 days). */
  artifacts?: ArtifactDeps;
  /** Approval reminder emails. */
  approvalDigest?: { publicUrl: string; afterHours: number };
  /** People's mailboxes (ADR 0038): IMAP polling for routines, and Composio account checks. */
  mail?: { deps: MailDeps; pollSeconds: number };
  /** The agent browser's live view (ADR 0040): expired handoffs are told to its viewers. */
  browserLive?: BrowserLive;
  /** Agents' desktops (ADR 0058): the ones with an open handoff stay up. */
  desktops?: Pick<DesktopControl, "keepAlive">;
  /** The daily stall-and-noise report (`OPS_REPORT_EMAIL`); absent: none. */
  opsReport?: { to: string[]; publicUrl: string };
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
  /** Snoozed notifications whose time came back to the inbox. */
  notifications: 30_000,
  /** Runs whose worker died (deploy, crash): also once at boot. */
  recovery: 60_000,
  /** Ended runs still holding unread messages (safety net: they get a run of their own); routine runs left open. */
  inboxes: 30_000,
  /** Deleted files past 30 days lose their contents. */
  artifactPurge: 6 * 3600_000,
  /** How often watched IMAP folders are looked at (each is checked every `MAIL_POLL_SECONDS`). */
  mailPoll: 30_000,
  /** Composio accounts' state: mailboxes (expired → "Reconnect") and connectors marked to reconnect (working again → active). */
  mailReconcile: 15 * 60_000,
  /** Workspaces past their deletion's date that nothing keeps any more (a hold lifted, a job lost): also at boot. */
  deletions: 3600_000,
  /** Yesterday's stall-and-noise report, queued for an hour after the UTC day ended (once per day: its dedupe key). */
  opsReport: 3600_000,
  /** AI apps' expired requests, tokens and unused registrations (ADR 0119). */
  apps: 3600_000,
  /** Alerts the autonomy brakes held as noise, posted as one digest per agent and conversation (ADR 0131 §5). */
  autonomyDigest: 10 * 60_000,
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
        log.error("background job failed", { job: name, error });
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

  // A pool, not batches: a slow job (a long agent run) doesn't hold back the ones claimed after it.
  const outboxPump = createOutboxPump(db, deps.handlers, {
    workerId,
    onSlotFree: () => void ticks.get("outbox")?.(),
    onError: (job, error, outcome) => logJobFailure(log, job, error, outcome),
    // How long each job waited to be claimed (ADR 0053 §10): a person's run should never queue behind routines.
    onTiming: (name, ms, attrs) => log.debug(name, { ms, ...attrs }),
  });
  every("outbox", WORKER_INTERVALS_MS.outbox, async () => {
    while (!stopped && (await outboxPump.pump()) > 0) {}
  });

  every("apps", WORKER_INTERVALS_MS.apps, () => purgeApps(db));
  every("partitions", WORKER_INTERVALS_MS.partitions, async () => {
    const created = await ensureMessagePartitions(db);
    if (created > 0) log.info("created message partitions", { created });
    // Old send ids (idempotent resends) are no longer needed.
    const pruned = await pruneMessageClientIds(db);
    if (pruned > 0) log.info("pruned message client ids", { pruned });
    const events = await pruneOperatorEvents(db);
    if (events > 0) log.info("pruned operator events", { pruned: events });
    const cleared = await clearOldOutboxPayloads(db);
    if (cleared > 0) log.info("cleared old job contents", { cleared });
    const calls = await pruneRoutineHookCalls(db);
    if (calls > 0) log.info("pruned webhook calls", { pruned: calls });
    // Requests to join answered or run out 90 days ago go; notices with nothing left waiting close (ADR 0068).
    const requests = await pruneJoinRequests({ db, pubsub: deps.pubsub });
    if (requests > 0) log.info("pruned join requests", { pruned: requests });
  });

  every("deletions", WORKER_INTERVALS_MS.deletions, async () => {
    await pruneDeletionCodes(db);
    const due = await enqueueOverdueDeletions(db);
    if (due > 0) {
      log.info("workspace deletions due", { due });
      void ticks.get("outbox")?.();
    }
  });

  every("approvals", WORKER_INTERVALS_MS.approvals, async () => {
    const expired = await expireApprovals({ db, pubsub: deps.pubsub });
    if (expired > 0) log.info("approvals expired", { expired });
  });

  every("questions", WORKER_INTERVALS_MS.approvals, async () => {
    const expired = await expireQuestions({ db, pubsub: deps.pubsub });
    if (expired > 0) log.info("agent questions expired", { expired });
  });

  every("browserHandoffs", WORKER_INTERVALS_MS.approvals, async () => {
    const expired = await expireBrowserHandoffs(deps.browserLive?.handoffDeps ?? { db, pubsub: deps.pubsub });
    if (expired > 0) log.info("browser handoffs expired", { expired });
    // A page or a desktop a person was asked to work in stays open past the runner's idle shutdown.
    await deps.browserLive?.keepAlive();
    await deps.desktops?.keepAlive();
  });

  every("consultations", WORKER_INTERVALS_MS.approvals, async () => {
    const expired = await expireConsultations({ db, pubsub: deps.pubsub });
    if (expired > 0) log.info("agent consultations expired", { expired });
  });

  every("secrets", WORKER_INTERVALS_MS.approvals, async () => {
    const expired = await expireSecretRequests({ db, pubsub: deps.pubsub });
    if (expired > 0) log.info("secret requests expired", { expired });
  });

  every("recovery", WORKER_INTERVALS_MS.recovery, async () => {
    const r = await recoverStaleRuns({ db, pubsub: deps.pubsub });
    if (r.resumed.length + r.failed.length + r.requeued.length > 0) log.info("stale runs recovered", r);
    // Long work whose run ended without closing it (a crash between the two) gets its end, once (ADR 0121 §7).
    const closed = await reconcileWorks({ db, pubsub: deps.pubsub });
    if (closed > 0) log.warn("background works closed by the sweep", { works: closed });
  });

  every("inboxes", WORKER_INTERVALS_MS.inboxes, async () => {
    const swept = await sweepEndedInboxes({ db, pubsub: deps.pubsub });
    if (swept > 0) log.warn("unread messages of ended runs handed on", { runs: swept });
    // Routine runs left open by an ending that didn't close them, or whose job died (ADR 0053 §5).
    const reaped = await reapRoutineRuns({ db, pubsub: deps.pubsub });
    if (reaped > 0) log.warn("routine runs closed by the reaper", { runs: reaped });
  });

  const files = deps.artifacts;
  if (files) {
    every("artifactPurge", WORKER_INTERVALS_MS.artifactPurge, async () => {
      const purged = await purgeDeletedArtifacts(files);
      if (purged > 0) log.info("deleted files purged", { versions: purged });
    });
  }

  every("autonomyDigest", WORKER_INTERVALS_MS.autonomyDigest, async () => {
    const posted = await postAutonomyDigests({ db, pubsub: deps.pubsub });
    if (posted > 0) log.info("noise digests posted", { posted });
  });

  every("notifications", WORKER_INTERVALS_MS.notifications, async () => {
    const woke = await wakeSnoozedNotifications({ db, pubsub: deps.pubsub });
    if (woke > 0) log.info("snoozed notifications back", { woke });
  });

  every("routines", WORKER_INTERVALS_MS.routines, async () => {
    const fired = await fireDueRoutines({ db, pubsub: deps.pubsub });
    if (fired > 0) log.info("routines fired", { fired });
  });

  const mail = deps.mail;
  if (mail?.deps.mail?.imap) {
    every("mailPoll", Math.min(WORKER_INTERVALS_MS.mailPoll, mail.pollSeconds * 1000), async () => {
      const r = await pollMailWatches(mail.deps, { intervalMs: mail.pollSeconds * 1000, concurrency: 5 });
      if (r.fired > 0) {
        log.info("mail routines fired", r);
        void ticks.get("outbox")?.();
      } else if (r.failed > 0) log.warn("mail polls failed", r);
    });
  }
  const composio = mail?.deps.mail?.composio;
  if (mail && composio) {
    every("mailReconcile", WORKER_INTERVALS_MS.mailReconcile, async () => {
      const r = await reconcileComposioAccounts(mail.deps);
      for (const failure of r.failed) log.warn("mail account check failed", failure);
      const connectors = await reconcileComposioConnectors(db, composio.client);
      if (connectors.healed > 0) log.info("connectors working again at Composio", { healed: connectors.healed });
      for (const failure of connectors.failed) log.warn("connector account check failed", failure);
    });
  }

  const ops = deps.opsReport;
  if (ops) every("opsReport", WORKER_INTERVALS_MS.opsReport, () => enqueueAutonomyReport(db, ops));

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

  // Confirmed waiting list entries from before contacts were synced (no-op for the rest: dedupe key).
  void enqueueWaitlistContacts(db).catch((error) =>
    log.error("background job failed", { job: "waitlistContacts", error }),
  );

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
    /**
     * After `stop`: waits for the jobs running here to finish, until `until` settles, then hands the rest back to
     * the queue, due at once for the next instance. Returns how many went back.
     */
    async drain(until: Promise<unknown>) {
      await Promise.race([outboxPump.idle(), until]);
      return releaseJobs(db, workerId);
    },
  };
}
