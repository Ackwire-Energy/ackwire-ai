import { DESKTOP_PROTOCOL, type PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, gte, inArray, schema, sql } from "@agenteschat/db";
import { announceAgentStatus } from "./agent-status";
import { recordAudit } from "./audit";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { publishChannelEvent } from "./events";
import { onForumRunFinished } from "./forum";
import type { MachineHub } from "./machine-hub";
import { cancelOrgTasks, type TaskCall } from "./machine-tasks";
import { can, requireActiveMembership } from "./organizations";
import { closeRoutineRun } from "./routine-ledger";
import { ACTIVE_RUN_STATUSES, releaseInbox } from "./run-inbox";
import { isTerminal, type RunStatus, replyThreadOf, transitionRun } from "./runs";
import { cancelSecretRequests, publishSecret, type SecretRequestRow, syncSecretMessage } from "./secrets";
import { standingErrorDetail } from "./standing";

const { agentRuns, agents, approvals, agentQuestions, outbox, messages, channels, machines } = schema;

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
  if (active.get(runId) !== controller) return;
  active.delete(runId);
  missedInterrupts.delete(runId);
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

/**
 * Thrown inside a run interrupted by shutdown: the outbox hands its job back (`handback`), due at once and without
 * spending an attempt, and the next instance continues from the saved transcript.
 */
export class RunInterruptedError extends Error {
  readonly handback = true;
  constructor() {
    super("run interrupted by a server shutdown; it resumes from its last checkpoint");
    this.name = "RunInterruptedError";
  }
}

/** How many runs this process is executing. */
export const activeRunCount = () => active.size;

/** Whether this process is executing the run. */
export const executesHere = (runId: string) => active.has(runId);

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

/** Cross-instance: "stop and send" (`steer: "now"`) cuts the run's current model call short; the run goes on. */
export const RUN_INTERRUPT_TOPIC = "system:run-interrupt";

/**
 * The model call in flight of each run executing here: aborting it ends only
 * that turn (its text so far is kept), never the run nor a tool that runs.
 * `hasRead`: whether the run already read that message (then there is nothing to interrupt for).
 */
const turns = new Map<string, { controller: AbortController; hasRead(messageId: string): boolean }>();

/**
 * "Stop and send" for a run executing here while no model call is registered (a tool runs, or the loop is
 * between taking the steering and starting the next call): the next call checks them when it registers,
 * so a message that landed just after the steering was taken still cuts that call short.
 */
const missedInterrupts = new Map<string, Set<string>>();

/**
 * The next model call of the run. Already aborted if an interrupt came in between for a message the run
 * hasn't read (the caller then reads it before calling the model).
 */
export function registerTurnAbort(runId: string, hasRead: (messageId: string) => boolean) {
  const controller = new AbortController();
  turns.set(runId, { controller, hasRead });
  const missed = missedInterrupts.get(runId);
  if (missed) {
    missedInterrupts.delete(runId);
    if ([...missed].some((id) => !hasRead(id))) controller.abort(new Error("turn interrupted"));
  }
  return controller;
}

export function unregisterTurnAbort(runId: string, controller: AbortController) {
  if (turns.get(runId)?.controller === controller) turns.delete(runId);
}

/** Aborts the run's current model call if it runs here and hasn't read `messageId` yet. */
export function interruptLocalTurn(runId: string, messageId: string) {
  const turn = turns.get(runId);
  if (!turn) {
    // Executing here between two model calls: the next one checks it (read by then, nothing is cut).
    if (!active.has(runId)) return false;
    const missed = missedInterrupts.get(runId) ?? new Set<string>();
    missed.add(messageId);
    missedInterrupts.set(runId, missed);
    return true;
  }
  if (turn.controller.signal.aborted || turn.hasRead(messageId)) return false;
  turn.controller.abort(new Error("turn interrupted"));
  return true;
}

/**
 * A person asked the run to stop and read their message now: the instance
 * executing it aborts the current model call, and the loop reads the message
 * right away. Between calls (a tool runs, it waits for a person) nothing is
 * cut: the message is read at the next step, as any other.
 */
export async function interruptRun(pubsub: PubSub | undefined, runId: string, messageId: string) {
  if (interruptLocalTurn(runId, messageId)) return;
  if (pubsub) await pubsub.publish(RUN_INTERRUPT_TOPIC, { type: "run.interrupt", runId, messageId }).catch(() => {});
}

/** Each worker process listens, so a cancel (or an interrupt) reaches the instance that runs it. */
export function listenForRunCancels(pubsub: PubSub) {
  const offCancel = pubsub.subscribe(RUN_CANCEL_TOPIC, (event) => {
    if (typeof event.runId === "string") abortLocalRun(event.runId);
  });
  const offInterrupt = pubsub.subscribe(RUN_INTERRUPT_TOPIC, (event) => {
    if (typeof event.runId === "string" && typeof event.messageId === "string")
      interruptLocalTurn(event.runId, event.messageId);
  });
  return () => {
    offCancel();
    offInterrupt();
  };
}

/**
 * Who asked for the run: the trigger's author, or, for a run that continues a stopped one
 * (its trigger is the stopped reply), who pressed "Continuar".
 */
const continuedBy = sql`${messages.meta}->'canceled'->>'continuedByUserId'`;
export const runRequester = sql<string | null>`coalesce(${messages.authorUserId}, ${continuedBy})`;

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
 * The UI hears `run.canceled` at once. Audited. Messages sent to it that it hasn't read get a run
 * of their own (`releaseInbox`), except `stopMessageId`: the message that asked it to stop.
 */
export async function cancelRun(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  orgId: string,
  runId: string,
  options: { stopMessageId?: string } = {},
): Promise<{ id: string; status: RunStatus; previousStatus: RunStatus }> {
  const { db } = deps;
  const membership = await requireActiveMembership(db, userId, orgId);
  const [row] = await db
    .select({
      run: agentRuns,
      ownerUserId: agents.ownerUserId,
      requester: runRequester,
      channelKind: channels.kind,
    })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .leftJoin(messages, and(eq(messages.id, agentRuns.triggerMessageId), eq(messages.orgId, agentRuns.orgId)))
    .leftJoin(channels, eq(channels.id, agentRuns.channelId))
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.orgId, orgId)));
  if (!row) throw new NotFoundError("Run not found");
  const allowed = row.requester === userId || row.ownerUserId === userId || can(membership, "manage_agents");
  if (!allowed)
    throw new ForbiddenError("Only who asked, the agent's owner or an admin can stop it", "run.cancel_forbidden");

  return stopRun(deps, orgId, row.run, row.channelKind, { type: "person", id: userId }, options);
}

/**
 * Ends a run that hasn't finished: its pending approvals, questions and
 * secret requests close, its queued jobs are dropped, the worker running it
 * aborts, and the app hears it stopped. `actor`: the person who stopped it,
 * or the system (a consultation nobody waits for anymore, ADR 0034).
 * Its unread messages are handed on: by the worker executing it once it has
 * posted the stop (it may restart from a "Parar e mandar"), else here.
 */
export async function stopRun(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  start: typeof agentRuns.$inferSelect,
  channelKind: string | null,
  actor: { type: "person"; id: string } | { type: "system"; reason: string },
  options: { stopMessageId?: string } = {},
): Promise<{ id: string; status: RunStatus; previousStatus: RunStatus }> {
  const { db } = deps;
  const error = actor.type === "person" ? `canceled_by:${actor.id}` : actor.reason;
  let run = start;
  let previous: RunStatus = run.status;
  for (let attempt = 0; ; attempt++) {
    if (isTerminal(run.status)) throw new ConflictError("This task already ended", "run_finished");
    previous = run.status;
    const status = run.status;
    let closedSecrets: SecretRequestRow[] = [];
    const done = await db.transaction(async (tx) => {
      const moved = await transitionRun(tx, run.id, status, "canceled", { error });
      if (!moved) return null;
      // The "stop" itself needs no answer: it never gets a run of its own.
      if (options.stopMessageId) {
        await tx
          .update(agentRuns)
          .set({ pendingMessageIds: sql`array_remove(${agentRuns.pendingMessageIds}, ${options.stopMessageId}::uuid)` })
          .where(eq(agentRuns.id, run.id));
      }
      const now = new Date();
      await tx
        .update(approvals)
        .set({ status: "canceled", decidedAt: now })
        .where(and(eq(approvals.runId, run.id), eq(approvals.status, "pending")));
      await tx
        .update(agentQuestions)
        .set({ status: "canceled" })
        .where(and(eq(agentQuestions.runId, run.id), eq(agentQuestions.status, "open")));
      // Its secret requests close too; each terminal row queues runner key cleanup.
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
        actor: actor.type === "person" ? actor : { type: "system", id: null },
        action: "run.canceled",
        target: { type: "agent_run", id: run.id },
        details: { agentId: run.agentId, from: status, ...(actor.type === "system" ? { reason: actor.reason } : {}) },
      });
      return moved;
    });
    if (done) {
      run = done;
      for (const r of closedSecrets) await publishSecret(deps.pubsub, r, "secret.updated");
      break;
    }
    if (attempt >= 3) throw new ConflictError("This task changed state. Try again.", "run.state_changed");
    const [fresh] = await db.select().from(agentRuns).where(eq(agentRuns.id, run.id));
    if (!fresh) throw new NotFoundError("Run not found");
    run = fresh;
  }

  // The worker running it (here or on another instance) aborts and posts what was written.
  abortLocalRun(run.id);
  if (deps.pubsub) await deps.pubsub.publish(RUN_CANCEL_TOPIC, { type: "run.cancel", runId: run.id }).catch(() => {});
  // A routine's background run is stopped quietly (ADR 0053 §6.7): nothing in a conversation, its ledger
  // ends `canceled` with who stopped it. Any other stop of it (a pause, a delete, the next slot) is closed
  // by whoever stopped it, with its own reason.
  if (run.background && actor.type === "person") {
    await closeRoutineRun(deps, run, { status: "canceled", code: "stopped", byUserId: actor.id }).catch(() => null);
  }
  // The app drops "pensando…" right away.
  const where = {
    channelId: run.channelId,
    threadId: replyThreadOf(run),
    agentId: run.agentId,
    runId: run.id,
  };
  const bg = run.background ? { background: true as const } : {};
  if (actor.type === "person" && !run.background)
    await publishChannelEvent(deps.pubsub, { type: "run.canceled", ...where, byUserId: actor.id });
  await publishChannelEvent(deps.pubsub, { type: "agent.run", ...where, ...bg, status: "canceled" });
  // Its line ends with the run (ADR 0084 §11).
  await announceAgentStatus(deps.pubsub, run.orgId, run.agentId).catch(() => {});
  if (previous !== "running" && run.background) {
    await publishChannelEvent(deps.pubsub, { type: "agent.idle", ...where, ...bg });
    await publishChannelEvent(deps.pubsub, { type: "run.finished", ...where, ...bg, status: "canceled" });
  } else if (previous !== "running") {
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
    if (channelKind === "forum") {
      await onForumRunFinished({ db, pubsub: deps.pubsub }, orgId, run.channelId, run.id).catch(() => {});
    }
    // Nobody executes it: what was sent to it and not read gets a run of its own now, unless its workspace
    // stopped it (that run would only fail too).
    if (!standingErrorDetail(error)) {
      await releaseInbox(db, deps.pubsub, run, {
        reason: "canceled",
        ...(options.stopMessageId ? { exclude: [options.stopMessageId] } : {}),
      }).catch(() => null);
    }
  }
  return { id: run.id, status: run.status, previousStatus: previous };
}

/**
 * Ends what a suspended workspace's agents (or, with `agentId`, an agent being deleted) still have going: every
 * run not finished stops with `reason` (the standing's text, or `agent_archived`) and hands nothing on, its
 * computers stop its tasks, and its agents' desktops end with whatever runs on them (nothing else stops a
 * desktop: they stay on).
 */
export async function stopOrgWork(
  deps: { db: Database; pubsub?: PubSub; hub?: Pick<MachineHub, "call"> },
  orgId: string,
  reason: string,
  agentId?: string,
) {
  const live = await deps.db
    .select({ run: agentRuns, channelKind: channels.kind })
    .from(agentRuns)
    .leftJoin(channels, eq(channels.id, agentRuns.channelId))
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
        agentId ? eq(agentRuns.agentId, agentId) : undefined,
      ),
    );
  for (const { run, channelKind } of live) {
    await stopRun(deps, orgId, run, channelKind, { type: "system", reason }).catch(() => null);
    // A routine's run: its ledger says why (`stopRun` closes it only for a person).
    if (run.background) {
      const code = agentId ? "deleted" : "org_suspended";
      await closeRoutineRun(deps, run, { status: "canceled", code }).catch(() => null);
    }
  }
  const { hub } = deps;
  // A computer that doesn't answer soon can't hold up the caller: its tasks end here instead.
  const call: TaskCall | undefined = hub
    ? (machineId, request) => hub.call(machineId, request, { timeoutMs: 15_000 })
    : undefined;
  await cancelOrgTasks({ db: deps.db, pubsub: deps.pubsub, call }, orgId, "system", agentId);
  if (!hub) return;
  const desktops = await deps.db
    .select({ id: agents.id, handle: agents.handle, name: agents.name, machineId: machines.id })
    .from(agents)
    .innerJoin(machines, eq(machines.id, agents.machineId))
    .where(
      and(
        eq(agents.orgId, orgId),
        gte(machines.protocol, DESKTOP_PROTOCOL),
        agentId ? eq(agents.id, agentId) : undefined,
      ),
    );
  await Promise.all(
    desktops.map(({ machineId, ...agent }) =>
      hub.call(machineId, { op: "desktop.session.stop", agent }, { timeoutMs: 15_000 }).catch(() => null),
    ),
  );
}
