import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, desc, eq, inArray, rowsOf, schema, sql } from "@agenteschat/db";
import { textOf } from "@agenteschat/providers";
import { RUN_STALE_MS } from "./cancel";
import { onConsultedRunFinished } from "./consultations";
import { publishChannelEvent, publishMessageCreated } from "./events";
import { onForumRunFinished } from "./forum";
import { insertMessage, messageView } from "./messages";
import { enqueue } from "./outbox";
import { type AgentRun, addRunStep, runErrorDetail, transitionRun } from "./runs";

const { agentRuns, agentRunSteps, outbox, channels } = schema;

export const INTERRUPTED_BY_RESTART = "Interrupted by a server update";
/** A run is resumed at most this many times after a dead worker; then it fails. */
const MAX_RECOVERIES = 2;

type StoredTranscript = {
  messages?: { role: string; content: Parameters<typeof textOf>[0] }[];
  postedUpTo?: number;
};

/**
 * Finds runs whose worker died (a deploy or a crash: no heartbeat for
 * `RUN_STALE_MS`) and recovers them. Called on boot and every minute.
 * - Running, between steps (no tool call cut in half): resumed through the
 *   outbox from the saved transcript.
 * - Running with a tool call cut in half (it may have had effects), or
 *   recovered too often: failed with "Interrupted by a server update";
 *   what the agent wrote so far is posted; the app hears it.
 * - Queued with no job left: its job is enqueued again.
 */
export async function recoverStaleRuns(
  deps: { db: Database; pubsub?: PubSub },
  options: { now?: Date; staleMs?: number } = {},
): Promise<{ resumed: string[]; failed: string[]; requeued: string[] }> {
  const { db } = deps;
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.staleMs ?? RUN_STALE_MS));
  const out = { resumed: [] as string[], failed: [] as string[], requeued: [] as string[] };
  const liveJob = sql`exists (select 1 from ${outbox} o where o.kind = 'agent_run.execute'
      and o.payload->>'runId' = ${agentRuns.id}::text
      and (o.status = 'pending' or (o.status = 'processing' and o.locked_until > ${now.toISOString()}::timestamptz)))`;

  // Running with no heartbeat: its worker is gone even if the job's lease hasn't expired yet.
  const stale = await db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.status, "running"),
        sql`coalesce(${agentRuns.heartbeatAt}, ${agentRuns.startedAt}, ${agentRuns.updatedAt}) < ${cutoff.toISOString()}::timestamptz`,
        sql`not exists (select 1 from ${outbox} o where o.kind = 'agent_run.execute'
          and o.payload->>'runId' = ${agentRuns.id}::text and o.status = 'pending')`,
      ),
    )
    .orderBy(asc(agentRuns.createdAt))
    .limit(100);
  for (const run of stale) {
    const steps = await db
      .select({ kind: agentRunSteps.kind, data: agentRunSteps.data })
      .from(agentRunSteps)
      .where(eq(agentRunSteps.runId, run.id))
      .orderBy(desc(agentRunSteps.seq))
      .limit(500);
    const recovered = steps.filter((s) => s.kind === "error" && s.data.reason === "recovered").length;
    const results = new Set(steps.filter((s) => s.kind === "tool_result").map((s) => String(s.data.toolUseId)));
    const cutTool = steps.some((s) => s.kind === "tool_call" && !results.has(String(s.data.toolUseId)));
    if (!cutTool && recovered < MAX_RECOVERIES && run.transcript) {
      await resume(db, run);
      out.resumed.push(run.id);
    } else if (await failInterrupted(deps, run)) {
      out.failed.push(run.id);
    }
  }

  // Queued long ago with no job to run it (lost): enqueue it again.
  const lost = await db
    .select({ id: agentRuns.id, orgId: agentRuns.orgId })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.status, "queued"),
        sql`${agentRuns.createdAt} < ${cutoff.toISOString()}::timestamptz`,
        sql`not ${liveJob}`,
      ),
    )
    .limit(100);
  for (const run of lost) {
    await enqueue(db, {
      orgId: run.orgId,
      kind: "agent_run.execute",
      payload: { runId: run.id },
      dedupeKey: `agent_run.execute:${run.id}:requeue:${now.getTime()}`,
      maxAttempts: 4,
    });
    out.requeued.push(run.id);
  }
  return out;
}

/** Hands the run back to the outbox: its job is released (or a new one made); the executor continues from the transcript. */
async function resume(db: Database, run: AgentRun) {
  await db.transaction(async (tx) => {
    const released = await tx
      .update(outbox)
      .set({ status: "pending", lockedUntil: null, lockedBy: null, nextAttemptAt: new Date() })
      .where(
        and(
          eq(outbox.kind, "agent_run.execute"),
          sql`${outbox.payload}->>'runId' = ${run.id}`,
          eq(outbox.status, "processing"),
          sql`${outbox.attempts} < ${outbox.maxAttempts}`,
        ),
      )
      .returning({ id: outbox.id });
    if (released.length === 0) {
      await enqueue(tx, {
        orgId: run.orgId,
        kind: "agent_run.execute",
        payload: { runId: run.id },
        dedupeKey: `agent_run.execute:${run.id}:recover:${Date.now()}`,
        maxAttempts: 4,
      });
    }
    // Fresh heartbeat so the next sweep doesn't take it again before a worker claims it.
    await tx.update(agentRuns).set({ heartbeatAt: new Date() }).where(eq(agentRuns.id, run.id));
    await addRunStep(tx, run, "error", { reason: "recovered", message: "worker stopped; resumed from the last step" });
  });
}

/** Ends the run as failed, keeps what it wrote, and tells the channel (so the live row goes away). */
async function failInterrupted(deps: { db: Database; pubsub?: PubSub }, run: AgentRun) {
  const { db } = deps;
  const [channel] = await db.select({ kind: channels.kind }).from(channels).where(eq(channels.id, run.channelId));
  const flat = (channel?.kind === "dm" || channel?.kind === "forum") && run.threadRootId === run.triggerMessageId;
  const threadId = flat ? null : run.threadRootId;
  const t = (run.transcript ?? {}) as StoredTranscript;
  const said = (t.messages ?? [])
    .slice(t.postedUpTo ?? 0)
    .filter((m) => m.role === "assistant")
    .map((m) => textOf(m.content).trim())
    .filter(Boolean)
    .join("\n\n");
  const note = `_${INTERRUPTED_BY_RESTART}. Ask again to continue._`;
  const result = await db.transaction(async (tx) => {
    const failed = await transitionRun(tx, run.id, "running", "failed", { error: INTERRUPTED_BY_RESTART });
    if (!failed) return null;
    const message = await insertMessage(tx, {
      orgId: run.orgId,
      channelId: run.channelId,
      threadId,
      author: { type: "agent", agentId: run.agentId, runId: run.id, hop: run.hop },
      body: said ? `${said}\n\n${note}` : note,
      // `text`: what the agent wrote; the app explains the interruption in the person's language.
      meta: { interrupted: { reason: "deploy", text: said } },
    });
    await tx.update(agentRuns).set({ replyMessageId: message.id }).where(eq(agentRuns.id, run.id));
    await addRunStep(tx, run, "error", { reason: "interrupted", message: INTERRUPTED_BY_RESTART });
    // Its job is done for good.
    await tx
      .update(outbox)
      .set({ status: "failed", lockedUntil: null, lastError: INTERRUPTED_BY_RESTART })
      .where(
        and(
          eq(outbox.kind, "agent_run.execute"),
          sql`${outbox.payload}->>'runId' = ${run.id}`,
          inArray(outbox.status, ["pending", "processing"]),
        ),
      );
    return message;
  });
  if (!result) return false;
  const where = { channelId: run.channelId, threadId, agentId: run.agentId, runId: run.id };
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(result));
  await publishChannelEvent(deps.pubsub, {
    type: "agent.run",
    ...where,
    status: "failed",
    error: INTERRUPTED_BY_RESTART,
    ...runErrorDetail(INTERRUPTED_BY_RESTART),
  });
  await publishChannelEvent(deps.pubsub, { type: "agent.idle", ...where });
  await publishChannelEvent(deps.pubsub, {
    type: "run.finished",
    ...where,
    status: "failed",
    error: INTERRUPTED_BY_RESTART,
    ...runErrorDetail(INTERRUPTED_BY_RESTART),
  });
  await publishChannelEvent(deps.pubsub, {
    type: "message.handled",
    channelId: run.channelId,
    messageId: run.triggerMessageId,
    agentId: run.agentId,
    runId: run.id,
    status: "failed",
  });
  if (channel?.kind === "forum") {
    await onForumRunFinished({ db, pubsub: deps.pubsub }, run.orgId, run.channelId, run.id).catch(() => {});
  }
  // It was answering another agent: the asker hears it now instead of waiting for the question to expire.
  await onConsultedRunFinished({ db, pubsub: deps.pubsub }, run, "failed", INTERRUPTED_BY_RESTART).catch(() => {});
  return true;
}

/** Runs still active in a channel, for the app to reconcile its live rows on load and reconnect. */
export async function activeRunsIn(db: Database, orgId: string, channelId: string) {
  const rows = rowsOf<{
    id: string;
    agent_id: string;
    status: AgentRun["status"];
    thread_root_id: string;
    trigger_message_id: string;
    started_at: string | Date | null;
    heartbeat_at: string | Date | null;
    created_at: string | Date;
    kind: string;
  }>(
    await db.execute(sql`select r.id, r.agent_id, r.status, r.thread_root_id, r.trigger_message_id, r.started_at,
        r.heartbeat_at, r.created_at, c.kind
      from ${agentRuns} r join ${channels} c on c.id = r.channel_id
      where r.org_id = ${orgId}::uuid and r.channel_id = ${channelId}::uuid
        and r.status in ('queued', 'running', 'waiting_approval', 'waiting_input')
      order by r.created_at`),
  );
  const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());
  return rows.map((r) => ({
    runId: r.id,
    agentId: r.agent_id,
    channelId,
    status: r.status,
    threadId:
      (r.kind === "dm" || r.kind === "forum") && r.thread_root_id === r.trigger_message_id ? null : r.thread_root_id,
    triggerMessageId: r.trigger_message_id,
    startedAt: iso(r.started_at),
    heartbeatAt: iso(r.heartbeat_at),
    createdAt: iso(r.created_at) as string,
  }));
}
