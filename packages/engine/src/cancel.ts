import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { publishChannelEvent } from "./events";
import { onForumRunFinished } from "./forum";
import { can, getMembership } from "./organizations";
import { isTerminal, type RunStatus, transitionRun } from "./runs";
import { cancelSecretRequests, publishSecret, type SecretRequestRow, syncSecretMessage } from "./secrets";

const { agentRuns, agents, approvals, agentQuestions, outbox, messages, channels } = schema;

/** Cross-instance: the worker running the run aborts it (LISTEN/NOTIFY with the Postgres pub/sub). */
export const RUN_CANCEL_TOPIC = "system:run-cancel";

/** How often a running run's worker says it is alive; after `RUN_STALE_MS` without it, the run is recovered. */
export const RUN_HEARTBEAT_MS = 20_000;
export const RUN_STALE_MS = 2 * 60_000;

/** Runs executing in this process, by id: canceling aborts the model stream, tools and code. */
const active = new Map<string, AbortController>();

export function registerRunAbort(runId: string) {
  const controller = new AbortController();
  active.set(runId, controller);
  return controller;
}

export function unregisterRunAbort(runId: string, controller: AbortController) {
  if (active.get(runId) === controller) active.delete(runId);
}

/** Aborts the run if it executes here. */
export function abortLocalRun(runId: string) {
  const controller = active.get(runId);
  if (!controller) return false;
  controller.abort(new Error("run canceled"));
  return true;
}

/** Abort reason when the server shuts down: the run is checkpointed and resumed elsewhere, not canceled. */
export const SHUTDOWN_REASON = "server_shutdown";
export const isShutdown = (reason: unknown) => reason === SHUTDOWN_REASON;

/** Thrown inside a run interrupted by shutdown: the job is retried (by the next instance) from the saved transcript. */
export class RunInterruptedError extends Error {
  constructor() {
    super("run interrupted by a server shutdown; it resumes from its last checkpoint");
    this.name = "RunInterruptedError";
  }
}

/** How many runs this process is executing. */
export const activeRunCount = () => active.size;

/** Graceful shutdown: waits up to `ms` for runs to finish, then interrupts the rest (they resume elsewhere). */
export async function drainLocalRuns(ms: number, options: { graceMs?: number } = {}) {
  const deadline = Date.now() + ms;
  while (active.size > 0 && Date.now() < deadline) await Bun.sleep(100);
  const interrupted = [...active.keys()];
  for (const controller of active.values()) controller.abort(SHUTDOWN_REASON);
  // Give them a moment to checkpoint and hand the job back.
  const grace = Date.now() + (options.graceMs ?? 5_000);
  while (active.size > 0 && Date.now() < grace) await Bun.sleep(50);
  return interrupted;
}

/** Each worker process listens, so a cancel reaches the instance that runs it. */
export function listenForRunCancels(pubsub: PubSub) {
  return pubsub.subscribe(RUN_CANCEL_TOPIC, (event) => {
    if (typeof event.runId === "string") abortLocalRun(event.runId);
  });
}

/** Who canceled (stored on the run as `canceled_by:{userId}`). */
export const canceledBy = (error: string | null | undefined) =>
  error?.startsWith("canceled_by:") ? error.slice("canceled_by:".length) : null;

/**
 * Stops an agent's run (`POST …/runs/{runId}/cancel`): the person who asked,
 * the agent's owner, or an admin.
 * - Queued: it never starts (its job is dropped).
 * - Waiting for an approval or an answer: it ends; the approval or question is canceled.
 * - Running: the worker aborts the model stream (usage so far is recorded),
 *   stops before the next tool, kills running code, and posts what the agent
 *   wrote so far with "Stopped by …".
 * The UI hears `run.canceled` at once. Audited.
 */
export async function cancelRun(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  orgId: string,
  runId: string,
): Promise<{ id: string; status: RunStatus; previousStatus: RunStatus }> {
  const { db } = deps;
  const membership = await getMembership(db, userId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
  const [row] = await db
    .select({
      run: agentRuns,
      ownerUserId: agents.ownerUserId,
      requester: messages.authorUserId,
      channelKind: channels.kind,
    })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .leftJoin(messages, and(eq(messages.id, agentRuns.triggerMessageId), eq(messages.orgId, agentRuns.orgId)))
    .leftJoin(channels, eq(channels.id, agentRuns.channelId))
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));
  if (!row) throw new NotFoundError("Run not found");
  const allowed = row.requester === userId || row.ownerUserId === userId || can(membership.role, "manage_agents");
  if (!allowed)
    throw new ForbiddenError("Only who asked, the agent's owner or an admin can stop it", "run.cancel_forbidden");

  let run = row.run;
  let previous: RunStatus = run.status;
  for (let attempt = 0; ; attempt++) {
    if (isTerminal(run.status)) throw new ConflictError("This task already ended", "run_finished");
    previous = run.status;
    const status = run.status;
    let closedSecrets: SecretRequestRow[] = [];
    const done = await db.transaction(async (tx) => {
      const moved = await transitionRun(tx, run.id, status, "canceled", { error: `canceled_by:${userId}` });
      if (!moved) return null;
      const now = new Date();
      await tx
        .update(approvals)
        .set({ status: "canceled", decidedAt: now })
        .where(and(eq(approvals.runId, run.id), eq(approvals.status, "pending")));
      await tx
        .update(agentQuestions)
        .set({ status: "canceled" })
        .where(and(eq(agentQuestions.runId, run.id), eq(agentQuestions.status, "open")));
      // Its secret requests close too (the keys left on the computer are pruned there).
      closedSecrets = await cancelSecretRequests(tx, run.id);
      for (const r of closedSecrets) await syncSecretMessage(tx, r);
      // Jobs of this run that haven't started never will.
      await tx
        .delete(outbox)
        .where(
          and(
            eq(outbox.kind, "agent_run.execute"),
            eq(outbox.status, "pending"),
            sql`${outbox.payload}->>'runId' = ${run.id}`,
          ),
        );
      await recordAudit(tx, {
        orgId,
        actor: { type: "person", id: userId },
        action: "run.canceled",
        target: { type: "agent_run", id: run.id },
        details: { agentId: run.agentId, from: status },
      });
      return moved;
    });
    if (done) {
      run = done;
      for (const r of closedSecrets) await publishSecret(deps.pubsub, r, "secret.updated");
      break;
    }
    if (attempt >= 3) throw new ConflictError("This task changed state; try again", "run.state_changed");
    const [fresh] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    if (!fresh) throw new NotFoundError("Run not found");
    run = fresh;
  }

  // The worker running it (here or on another instance) aborts and posts what was written.
  abortLocalRun(run.id);
  if (deps.pubsub) await deps.pubsub.publish(RUN_CANCEL_TOPIC, { type: "run.cancel", runId: run.id }).catch(() => {});
  // The app drops "pensando…" right away.
  const flat = (row.channelKind === "dm" || row.channelKind === "forum") && run.threadRootId === run.triggerMessageId;
  const where = {
    channelId: run.channelId,
    threadId: flat ? null : run.threadRootId,
    agentId: run.agentId,
    runId: run.id,
  };
  await publishChannelEvent(deps.pubsub, { type: "run.canceled", ...where, byUserId: userId });
  await publishChannelEvent(deps.pubsub, { type: "agent.run", ...where, status: "canceled" });
  if (previous !== "running") {
    // Nobody is executing it: finish it for the app here.
    await publishChannelEvent(deps.pubsub, { type: "agent.idle", ...where });
    await publishChannelEvent(deps.pubsub, { type: "run.finished", ...where, status: "canceled" });
    await publishChannelEvent(deps.pubsub, {
      type: "message.handled",
      channelId: run.channelId,
      messageId: run.triggerMessageId,
      agentId: run.agentId,
      runId: run.id,
      status: "canceled",
    });
    // A forum turn that never ran: the topic moves on.
    if (row.channelKind === "forum") {
      await onForumRunFinished({ db, pubsub: deps.pubsub }, orgId, run.channelId, run.id).catch(() => {});
    }
  }
  return { id: run.id, status: run.status, previousStatus: previous };
}
