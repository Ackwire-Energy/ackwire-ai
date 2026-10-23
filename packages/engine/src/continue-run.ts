import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { runBrainOf } from "./brains/select";
import { canceledBy, runRequester } from "./cancel";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { publishChannelEvent } from "./events";
import { continuedTranscript, type Transcript } from "./executor";
import { getMessage } from "./messages";
import { can, getMembership } from "./organizations";
import { enqueue } from "./outbox";
import { ACTIVE_RUN_STATUSES, takeInbox } from "./run-inbox";

const { agentRuns, agents, messages, channels, users } = schema;

/**
 * "Continuar" under a reply a person stopped (`POST …/runs/{runId}/continue`):
 * a new run of the same agent, in the same conversation, picks up from the
 * stopped run's conversation plus "[Ana asked you to continue from where you
 * stopped.]". Same people as stopping it: who asked, the agent's owner, or an
 * admin. Only a run a person stopped while it ran (its stopped reply is the
 * new run's trigger, so it continues once); never while the agent already
 * works in that conversation. The stopped reply gets `meta.canceled.continuedRunId`
 * and the app hears `run.continued`. Audited.
 */
export async function continueRun(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  orgId: string,
  runId: string,
): Promise<{ runId: string }> {
  const { db } = deps;
  const membership = await getMembership(db, userId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
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
  const allowed = row.requester === userId || row.ownerUserId === userId || can(membership.role, "manage_agents");
  if (!allowed)
    throw new ForbiddenError("Only who asked, the agent's owner or an admin can continue it", "run.continue_forbidden");

  const stopped = row.run;
  const notContinuable = () => new ConflictError("This task can't be continued", "run.not_continuable");
  // A forum turn belongs to the topic's order (D33): it is never picked up by hand.
  const byPerson = stopped.status === "canceled" && Boolean(canceledBy(stopped.error));
  if (!byPerson || row.channelKind === "forum" || !stopped.transcript) throw notContinuable();
  if (!stopped.replyMessageId) throw notContinuable();
  const reply = await getMessage(db, orgId, stopped.replyMessageId);
  const canceled = reply?.meta.canceled as { continuedRunId?: unknown } | undefined;
  if (!reply || reply.deletedAt || !canceled || canceled.continuedRunId) throw notContinuable();

  // The new run answers where the stopped reply is: its thread, or (flat: a DM) the reply itself.
  const threadRootId = reply.threadId ?? reply.id;
  const roots = [...new Set([stopped.threadRootId, threadRootId])];
  // A DM is one conversation; a channel's are its threads.
  const inConversation = row.channelKind === "dm" ? undefined : inArray(agentRuns.threadRootId, roots);
  const [busy] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRuns.agentId, stopped.agentId),
        eq(agentRuns.channelId, stopped.channelId),
        inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
        // A background run (a routine's) holds no conversation.
        eq(agentRuns.background, false),
        inConversation,
      ),
    )
    .limit(1);
  if (busy) throw new ConflictError("This agent is already working here", "run.agent_busy");

  const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  const line = `[${person?.name ?? "A person"} asked you to continue from where you stopped.]`;
  const transcript = continuedTranscript(stopped.transcript as unknown as Transcript, line);
  const newRunId = Bun.randomUUIDv7();
  const created = await db.transaction(async (tx) => {
    // One continuation per stopped reply: it is the new run's trigger, unique per agent.
    const [inserted] = await tx
      .insert(agentRuns)
      .values({
        id: newRunId,
        orgId,
        agentId: stopped.agentId,
        channelId: stopped.channelId,
        threadRootId,
        triggerMessageId: reply.id,
        // Nobody brings it in this time: a person asked for it.
        trigger: stopped.trigger === "router" ? "mention" : stopped.trigger,
        hop: stopped.hop,
        transcript: transcript as unknown as Record<string, unknown>,
        issueId: stopped.issueId,
        // A computer brain resumes the session it was stopped in.
        brainSessionId: stopped.brainSessionId,
      })
      .onConflictDoNothing()
      .returning({ id: agentRuns.id });
    if (!inserted) return false;
    const mark = JSON.stringify({ continuedRunId: newRunId, continuedByUserId: userId });
    await tx
      .update(messages)
      .set({ meta: sql`jsonb_set(${messages.meta}, '{canceled}', (${messages.meta}->'canceled') || ${mark}::jsonb)` })
      .where(and(eq(messages.orgId, orgId), eq(messages.id, reply.id)));
    await enqueue(tx, {
      orgId,
      kind: "agent_run.execute",
      payload: { runId: newRunId },
      dedupeKey: `agent_run.execute:${newRunId}`,
      maxAttempts: 4,
    });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "run.continued",
      target: { type: "agent_run", id: newRunId },
      details: { agentId: stopped.agentId, continues: stopped.id },
    });
    return true;
  });
  if (!created) throw notContinuable();

  const where = { channelId: stopped.channelId, threadId: reply.threadId, agentId: stopped.agentId };
  await publishChannelEvent(deps.pubsub, {
    type: "run.continued",
    ...where,
    runId: stopped.id,
    newRunId,
    messageId: reply.id,
  });
  // The new run shows as any live run: "pensando…" right away.
  await publishChannelEvent(deps.pubsub, { type: "agent.thinking", ...where, runId: newRunId });
  return { runId: newRunId };
}

/** The stop-and-send message left the stopped run's inbox before the restart (handed on already). */
class AlreadyHandedOn extends Error {}

/**
 * "Parar e mandar" to a computer brain (Claude Code, Codex): its turn can't be cut halfway, so the
 * task was stopped (`postPersonMessage`). Once its stop is posted (`stopped`, the reply), a new run
 * of the same agent starts from that message: same conversation, the stopped run's context and its
 * computer session, plus "[Ana stopped you to say this:] …". Only for a message of the person who
 * stopped it, still unread (`meta.steerNow`). The stopped reply is marked continued (no "Continuar"),
 * and the app hears it read the message. The stopped run's other unread messages go along (the new
 * run reads them at its first step). Returns the new run's id, or null when there is nothing to do.
 */
export async function restartAfterStopAndSend(
  deps: { db: Database; pubsub?: PubSub },
  stoppedRunId: string,
  reply: { id: string; threadId: string | null },
  transcript: Transcript,
): Promise<string | null> {
  const { db } = deps;
  const [stopped] = await db.select().from(agentRuns).where(eq(agentRuns.id, stoppedRunId));
  const by = canceledBy(stopped?.error);
  if (!stopped || !by || stopped.pendingMessageIds.length === 0) return null;
  // A model brain reads a "Parar e mandar" mid-task (its call is cut); only a computer brain is restarted.
  // The brain the stopped run thought with (a fallback ran on the model brain), the agent's before its first turn.
  const [agent] = await db.select({ brain: agents.brain }).from(agents).where(eq(agents.id, stopped.agentId));
  if (!agent || runBrainOf(stopped, agent) === "model") return null;
  const [said] = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.orgId, stopped.orgId),
        inArray(messages.id, stopped.pendingMessageIds),
        eq(messages.authorUserId, by),
        sql`${messages.meta}->>'steerNow' = 'true'`,
      ),
    )
    .orderBy(sql`${messages.createdAt} desc`)
    .limit(1);
  if (!said) return null;
  const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, by));
  const line = `[${person?.name ?? "A person"} stopped you to say this:]\n\n${said.body}`;
  const newRunId = Bun.randomUUIDv7();
  const created = await db
    .transaction(async (tx) => {
      // The message is its trigger (it started no run of this agent: it went into the stopped one).
      const [inserted] = await tx
        .insert(agentRuns)
        .values({
          id: newRunId,
          orgId: stopped.orgId,
          agentId: stopped.agentId,
          channelId: stopped.channelId,
          threadRootId: said.threadId ?? said.id,
          triggerMessageId: said.id,
          trigger: stopped.trigger === "router" ? "mention" : stopped.trigger,
          hop: stopped.hop,
          transcript: continuedTranscript(transcript, line) as unknown as Record<string, unknown>,
          issueId: stopped.issueId,
          brainSessionId: stopped.brainSessionId,
        })
        .onConflictDoNothing()
        .returning({ id: agentRuns.id });
      if (!inserted) return false;
      // The stopped run's unread messages move to the new run (taken: nothing is handed on twice).
      // Already handed on (the message is no longer there): nothing to restart; undo the insert.
      const unread = await takeInbox(tx, stopped.id);
      if (!unread.includes(said.id)) throw new AlreadyHandedOn();
      const rest = unread.filter((id) => id !== said.id);
      if (rest.length > 0)
        await tx.update(agentRuns).set({ pendingMessageIds: rest }).where(eq(agentRuns.id, newRunId));
      const mark = JSON.stringify({ continuedRunId: newRunId, continuedByUserId: by });
      await tx
        .update(messages)
        .set({ meta: sql`jsonb_set(${messages.meta}, '{canceled}', (${messages.meta}->'canceled') || ${mark}::jsonb)` })
        .where(and(eq(messages.orgId, stopped.orgId), eq(messages.id, reply.id)));
      await enqueue(tx, {
        orgId: stopped.orgId,
        kind: "agent_run.execute",
        payload: { runId: newRunId },
        dedupeKey: `agent_run.execute:${newRunId}`,
        maxAttempts: 4,
      });
      return true;
    })
    .catch((error: unknown) => {
      if (error instanceof AlreadyHandedOn) return false;
      throw error;
    });
  if (!created) return null;
  const where = { channelId: stopped.channelId, threadId: reply.threadId, agentId: stopped.agentId };
  await publishChannelEvent(deps.pubsub, {
    type: "run.continued",
    ...where,
    runId: stopped.id,
    newRunId,
    messageId: reply.id,
  });
  await publishChannelEvent(deps.pubsub, {
    type: "agent.run.read",
    ...where,
    runId: stopped.id,
    messageIds: [said.id],
  });
  await publishChannelEvent(deps.pubsub, { type: "agent.thinking", ...where, runId: newRunId });
  return newRunId;
}
