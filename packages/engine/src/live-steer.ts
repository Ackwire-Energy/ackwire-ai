import { randomUUID } from "node:crypto";
import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import type { SteerMessage, SteerReply } from "./brains/types";
import { taskNotice } from "./context";
import { publishChannelEvent } from "./events";
import { ACTIVE_RUN_STATUSES, releaseInbox } from "./run-inbox";
import type { AgentRun } from "./runs";

const { agentRuns, messages, users, agents } = schema;

/**
 * Live steering: a person's message reaches a computer brain's turn in
 * progress (Claude Code reads it at its next tool boundary) instead of
 * waiting for the whole CLI turn to end.
 *
 * - `deliverLive` (any instance) asks the instance executing the run, over
 *   pub/sub (`steerTopic`), and waits a moment for its answer.
 * - That instance's executor listens for the whole run (`listenLiveSteering`).
 *   While a computer turn that can take messages is in flight (the brain
 *   handed `BrainIO.steerable`), it takes the run's inbox, renders the
 *   messages exactly as the loop does between turns, and hands them to the
 *   turn, each with its own `uuid` (`agent.run.delivered`, "Ada recebeu").
 * - The turn says which it read (`steer_read`): those join the transcript
 *   (`agent.run.read`, a context step). At the turn's end the ones it never
 *   confirmed go back to the inbox, so the loop reads them with the next turn:
 *   never lost, never read twice.
 * - No such turn (the model brain, a turn between steps, an older runner or
 *   CLI, Codex): the messages stay in the inbox and `deliverLive` is false.
 */

/** Cross-instance: the instance executing the run hands it a message now (if its turn can take one). */
export const steerTopic = (runId: string) => `run-steer:${runId}`;
const steerReplyTopic = (requestId: string) => `run-steer-reply:${requestId}`;

/** How long `deliverLive` waits for the executing instance (no answer: nobody can take it now). */
export const LIVE_STEER_WAIT_MS = 3000;

/**
 * Live delivery to a computer brain mid-turn (Claude Code reads a message at
 * its next tool boundary). Returns true when the message was handed to the
 * turn in progress (its read is confirmed later, `agent.run.read`); false
 * leaves it for the run's next step, as before.
 */
export async function deliverLive(
  deps: { db: Database; pubsub: PubSub; waitMs?: number },
  run: AgentRun,
  input: { messageId: string; urgent: boolean },
): Promise<boolean> {
  if (run.status !== "running") return false;
  const requestId = randomUUID();
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const end = (delivered: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      off();
      resolve(delivered);
    };
    const off = deps.pubsub.subscribe(steerReplyTopic(requestId), (e) => end(e.delivered === true));
    const timer = setTimeout(() => end(false), deps.waitMs ?? LIVE_STEER_WAIT_MS);
    deps.pubsub
      .publish(steerTopic(run.id), {
        type: "run.steer",
        runId: run.id,
        requestId,
        messageId: input.messageId,
        ...(input.urgent ? { urgent: true } : {}),
      })
      .catch(() => end(false));
  });
}

/** A message taken from the inbox, as the run reads it. */
export interface SteeredText {
  id: string;
  text: string;
}

/**
 * Messages people (or events) sent while the run worked, oldest first, as the
 * agent reads them: "[New message from Ada, while you were working]: …", or
 * the notice a task or event carries. Deleted ones are left out.
 */
export async function renderSteered(db: Executor, orgId: string, ids: string[]): Promise<SteeredText[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      id: messages.id,
      body: messages.body,
      meta: messages.meta,
      name: sql<string | null>`coalesce(${users.name}, ${agents.name})`,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .leftJoin(users, eq(users.id, messages.authorUserId))
    .leftJoin(agents, eq(agents.id, messages.authorAgentId))
    .where(and(eq(messages.orgId, orgId), inArray(messages.id, ids), isNull(messages.deletedAt)));
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return rows.map((m) => ({
    id: m.id,
    // A background task that ended while it worked: the notice with its result.
    text:
      taskNotice({ body: m.body, meta: m.meta }, true) ??
      `[New message from ${m.name ?? "someone"}, while you were working]: ${m.body}`,
  }));
}

/** The run fields `releaseInbox` needs. */
type InboxRun = Pick<
  AgentRun,
  "id" | "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId" | "trigger"
>;

/**
 * Puts taken messages back at the front of the run's inbox (read with its next step). A run that
 * ended meanwhile (stopped while its turn ran) hands them on at once, as every ending does.
 */
export async function returnToInbox(db: Database, pubsub: PubSub | undefined, run: InboxRun, ids: string[]) {
  if (ids.length === 0) return;
  const list = sql`array[${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]::uuid[]`;
  const [row] = await db
    .update(agentRuns)
    .set({ pendingMessageIds: sql`${list} || ${agentRuns.pendingMessageIds}` })
    .where(eq(agentRuns.id, run.id))
    .returning({ status: agentRuns.status });
  if (row && !(ACTIVE_RUN_STATUSES as readonly string[]).includes(row.status)) {
    await releaseInbox(db, pubsub, run, { reason: "interrupted" });
  }
}

type Steer = (messages: SteerMessage[]) => Promise<SteerReply>;

export interface LiveSteeringHooks {
  /** Takes the run's inbox (the loop's own: the same messages are never taken twice). */
  take(): Promise<string[]>;
  /** Handed to the turn (not read yet): a "stop and send" for them has nothing more to do. */
  onHanded?(ids: string[]): void;
  /** Back in the inbox (never confirmed read). */
  onReturned?(ids: string[]): void;
  /** The turn read these (oldest first): they join the conversation. */
  onRead(read: SteeredText[]): Promise<void> | void;
}

export interface LiveSteering {
  /** `BrainIO.steerable`: the turn in flight can take messages (null: it ended). */
  steerable(steer: Steer | null): void;
  /** `steer_read` from the turn. */
  read(uuids: string[]): void;
  /** The turn ended: no more handoffs; what it never confirmed goes back to the inbox. Returns those ids. */
  endTurn(): Promise<string[]>;
  /** The run is done here. */
  close(): void;
}

/**
 * The executing side, for one run: answers `deliverLive` requests while the
 * run executes here (false at once when no turn can take a message).
 */
export function listenLiveSteering(
  deps: { db: Database; pubsub: PubSub },
  run: InboxRun,
  threadId: string | null,
  hooks: LiveSteeringHooks,
): LiveSteering {
  const where = { channelId: run.channelId, threadId, agentId: run.agentId, runId: run.id };
  let steer: Steer | null = null;
  /** This turn can't take messages (an older CLI): not asked again until the next turn. */
  let refused = false;
  /** Handed to the turn in flight and not confirmed yet, by uuid. */
  const handed = new Map<string, SteeredText>();
  let chain: Promise<unknown> = Promise.resolve();
  const reads = new Set<Promise<unknown>>();

  const deliver = async (messageId: string, urgent: boolean): Promise<boolean> => {
    if ([...handed.values()].some((h) => h.id === messageId)) return true;
    const turn = steer;
    if (!turn || refused) return false;
    const ids = await hooks.take();
    if (ids.length === 0) return false;
    const rows = await renderSteered(deps.db, run.orgId, ids);
    if (rows.length === 0) return false;
    const sent = rows.map((r) => ({ row: r, uuid: randomUUID() }));
    const reply = await turn(
      sent.map(({ row, uuid }) => ({ uuid, text: row.text, ...(urgent && row.id === messageId ? { urgent } : {}) })),
    ).catch((): SteerReply => ({ status: "no_turn" }));
    const ok = new Set(reply.status === "accepted" ? reply.accepted : []);
    if (reply.status === "unsupported") refused = true;
    const back = sent.filter((s) => !ok.has(s.uuid)).map((s) => s.row.id);
    const taken = sent.filter((s) => ok.has(s.uuid));
    for (const s of taken) handed.set(s.uuid, s.row);
    // Deleted meanwhile (not rendered): dropped, as the loop drops them.
    await returnToInbox(deps.db, deps.pubsub, run, back);
    if (back.length) hooks.onReturned?.(back);
    if (taken.length === 0) return false;
    const takenIds = taken.map((s) => s.row.id);
    hooks.onHanded?.(takenIds);
    await publishChannelEvent(deps.pubsub, { type: "agent.run.delivered", ...where, messageIds: takenIds });
    return takenIds.includes(messageId);
  };

  const off = deps.pubsub.subscribe(steerTopic(run.id), (e) => {
    if (e.type !== "run.steer" || typeof e.requestId !== "string" || typeof e.messageId !== "string") return;
    const { requestId, messageId } = e;
    const urgent = e.urgent === true;
    // One at a time: each takes the inbox whole.
    const next = chain.then(async () => {
      const delivered = await deliver(messageId, urgent).catch(() => false);
      await deps.pubsub.publish(steerReplyTopic(requestId), { type: "run.steer.reply", delivered }).catch(() => {});
    });
    chain = next.catch(() => {});
  });

  return {
    steerable(next) {
      steer = next;
      if (next) refused = false;
    },
    read(uuids) {
      const rows = uuids.flatMap((u) => {
        const row = handed.get(u);
        handed.delete(u);
        return row ? [row] : [];
      });
      if (rows.length === 0) return;
      const done = Promise.resolve(hooks.onRead(rows))
        .then(() =>
          publishChannelEvent(deps.pubsub, { type: "agent.run.read", ...where, messageIds: rows.map((r) => r.id) }),
        )
        .catch(() => {});
      reads.add(done);
      done.finally(() => reads.delete(done));
    },
    async endTurn() {
      steer = null;
      await chain;
      await Promise.all([...reads]);
      const left = [...handed.values()].map((r) => r.id);
      handed.clear();
      await returnToInbox(deps.db, deps.pubsub, run, left).catch(() => {});
      if (left.length) hooks.onReturned?.(left);
      return left;
    },
    close() {
      steer = null;
      off();
    },
  };
}
