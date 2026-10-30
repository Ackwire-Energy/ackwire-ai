import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, gt, inArray, isNull, schema, sql } from "@agenteschat/db";
import { aiConnectIntent, type ConnectIntent } from "./ai-intent";
import { type AiStatusDeps, agentAiState, type NoAiReason, orgHasAi } from "./ai-status";
import { audienceError, canTalkTo } from "./audience";
import { recordAudit } from "./audit";
import { runRequester } from "./cancel";
import { requireChannelAccess } from "./channels";
import { requesterOf, startOrJoinRun } from "./dispatch";
import { ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { publishChannelEvent, publishMessageCreated, publishRouted } from "./events";
import type { Judge } from "./judge";
import { getMessage, insertMessage, type Message, messageView } from "./messages";
import { can, type MemberRole } from "./organizations";
import { type RouterDeps, routeMessage } from "./router";
import { bodyCode } from "./run-tools";
import { type AgentRun, NO_AI, replyThreadOf } from "./runs";
import { withWikiLinks } from "./wiki-links";

const { agentRunSteps, agentRuns, agents, messages, routingDecisions } = schema;

/** The card's English body (the apps show `chat.body.no_ai`, or `no_ai_signed_out` for a sign-in that ended). */
export const NO_AI_TEXT = "I can't answer yet: I have no AI connected.";
const NO_AI_SIGNED_OUT_TEXT = "I can't answer yet: my AI is signed out.";

/** A conversation gets the card again only after this long (per agent; once while the organization has no AI). */
export const NO_AI_CARD_EVERY_MS = 6 * 3600_000;

/** `meta.noAi` of a card: whose it is, who asked, why, and the Connect step the message asked for. */
export interface NoAiCard extends ConnectIntent {
  agentId: string;
  forUserId: string | null;
  reason: NoAiReason;
  /** The run that couldn't think (deleted when "Responder agora" starts it again). */
  runId: string;
}

export const noAiCardOf = (m: Pick<Message, "authorType" | "meta">): NoAiCard | null => {
  const card = m.meta.noAi as Partial<NoAiCard> | undefined;
  return m.authorType === "agent" && card && typeof card.agentId === "string" ? (card as NoAiCard) : null;
};

/** Agents with a card in this conversation within `NO_AI_CARD_EVERY_MS`. */
async function cardsPosted(db: Executor, run: Pick<AgentRun, "orgId" | "channelId">, threadId: string | null) {
  const rows = await db
    .select({ agentId: messages.authorAgentId })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, run.orgId),
        eq(messages.channelId, run.channelId),
        threadId ? eq(messages.threadId, threadId) : isNull(messages.threadId),
        gt(messages.createdAt, new Date(Date.now() - NO_AI_CARD_EVERY_MS)),
        isNull(messages.deletedAt),
        sql`${messages.meta}->>'bodyCode' = ${NO_AI}`,
      ),
    );
  return rows.map((r) => r.agentId);
}

/**
 * The agent says it can't answer for want of an AI, where the run replies, with Connect (`meta.noAi`).
 * Once per agent and conversation every 6 hours, and once per conversation while the whole organization
 * has no AI. A person's message is read by Jev for the Connect step it asks for, outside the transaction
 * (a slow call must not hold its lock). Null when it wasn't repeated.
 */
export async function postNoAiCard(
  deps: AiStatusDeps & { db: Database; pubsub: PubSub; judge?: Judge | null },
  run: AgentRun,
  reason: NoAiReason,
): Promise<Message | null> {
  const { db } = deps;
  const threadId = replyThreadOf(run);
  const posted = await cardsPosted(db, run, threadId);
  if (posted.includes(run.agentId)) return null;
  const orgHasNoAi = !(await orgHasAi(deps, run.orgId));
  const repeated = (agentIds: (string | null)[]) =>
    agentIds.includes(run.agentId) || (agentIds.length > 0 && orgHasNoAi);
  if (repeated(posted)) return null;
  const trigger = await getMessage(db, run.orgId, run.triggerMessageId);
  const forUserId = trigger ? await requesterOf(db, trigger) : null;
  const intent: ConnectIntent =
    trigger?.authorType === "person"
      ? await aiConnectIntent(deps.judge, { orgId: run.orgId, agentId: run.agentId, runId: run.id, text: trigger.body })
      : { intent: "task" };
  const card = await db.transaction(async (tx) => {
    // The agents of one message fail together: they take turns here, so the organization gets one card.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`no-ai-card:${run.channelId}:${threadId ?? ""}`}))`);
    if (repeated(await cardsPosted(tx, run, threadId))) return null;
    const noAi: NoAiCard = { agentId: run.agentId, forUserId, reason, ...intent, runId: run.id };
    return insertMessage(tx, {
      orgId: run.orgId,
      channelId: run.channelId,
      threadId,
      author: { type: "agent", agentId: run.agentId, runId: run.id, hop: run.hop },
      body: reason === "not_signed_in" ? NO_AI_SIGNED_OUT_TEXT : NO_AI_TEXT,
      meta: { ...bodyCode(NO_AI), noAi },
    });
  });
  if (!card) return null;
  const [view] = await withWikiLinks(db, run.orgId, [messageView(card)]);
  if (view) await publishMessageCreated(deps.pubsub, view);
  return card;
}

export interface AnswerNowDeps extends AiStatusDeps {
  db: Database;
  pubsub?: PubSub;
  /** The router of `message.posted`; null when routing is off. */
  router?: RouterDeps | null;
}

type Answering = { agentId: string; runId: string }[];

/**
 * The runs a "Responder agora" is about: for a card, its agent's newest run in that conversation; for a
 * person's message, the runs it started.
 */
async function answeringRuns(db: Database, message: Message, card: NoAiCard | null) {
  const query = db
    .select({ run: agentRuns, agent: agents, requester: runRequester })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .leftJoin(messages, and(eq(messages.id, agentRuns.triggerMessageId), eq(messages.orgId, agentRuns.orgId)));
  if (!card) return query.where(and(eq(agentRuns.orgId, message.orgId), eq(agentRuns.triggerMessageId, message.id)));
  return query
    .where(
      and(
        eq(agentRuns.orgId, message.orgId),
        eq(agentRuns.agentId, card.agentId),
        eq(agentRuns.channelId, message.channelId),
        eq(agentRuns.background, false),
        // Where the card is: its thread, or the main timeline (a run asked there has its trigger as its root).
        message.threadId
          ? eq(agentRuns.threadRootId, message.threadId)
          : sql`${agentRuns.threadRootId} = ${agentRuns.triggerMessageId}`,
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
}

type AnsweringRun = Awaited<ReturnType<typeof answeringRuns>>[number];

const forbidden = () =>
  new ForbiddenError("Only who asked, the agent's owner or an admin can do this", "run.answer_forbidden");
const stillMissing = () => new ConflictError("There is still no AI connected", "ai.still_missing");
const notRestartable = () =>
  new ConflictError("This reply had already started, so it can't start over: ask again", "run.not_restartable");

/**
 * A `no_ai` run that resumed (after an approval or a question) or met a signed-out tool in a later turn may
 * have done things; starting it over would do them again, and deleting it would take its approvals,
 * questions and steps with it.
 */
const WORK_STEPS = ["tool_call", "message", "approval"] as const;

async function didWork(db: Executor, runId: string) {
  const [step] = await db
    .select({ id: agentRunSteps.id })
    .from(agentRunSteps)
    .where(and(eq(agentRunSteps.runId, runId), inArray(agentRunSteps.kind, [...WORK_STEPS])))
    .limit(1);
  return step !== undefined;
}

/**
 * Starts a failed `no_ai` run again on the person's own message, in one transaction: the old run is
 * deleted (it did nothing; its steps go with it), so `(trigger_message_id, agent_id)` stays unique and the
 * requester, authority and context are the normal ones. Null when another call got there first; `worked`
 * when the run had done something, and stays.
 */
async function restartNoAiRun(deps: AnswerNowDeps, userId: string, failed: AgentRun) {
  const trigger = await getMessage(deps.db, failed.orgId, failed.triggerMessageId);
  if (!trigger || trigger.deletedAt) return null;
  // A failed run gets no more steps, so this still holds in the transaction below.
  if (await didWork(deps.db, failed.id)) return "worked" as const;
  const started = await deps.db.transaction(async (tx) => {
    const [gone] = await tx
      .delete(agentRuns)
      .where(and(eq(agentRuns.id, failed.id), eq(agentRuns.status, "failed"), eq(agentRuns.error, NO_AI)))
      .returning({ id: agentRuns.id });
    if (!gone) return null;
    const next = await startOrJoinRun(tx, trigger, failed.agentId, failed.trigger);
    if (!next) return null;
    const runId = "created" in next ? next.created.id : next.joined;
    await recordAudit(tx, {
      orgId: failed.orgId,
      actor: { type: "person", id: userId },
      action: "run.answered_after_connect",
      target: { type: "agent_run", id: runId },
      details: { oldRunId: failed.id, agentId: failed.agentId, messageId: trigger.id },
    });
    return { runId, created: "created" in next ? next.created : null };
  });
  if (!started) return null;
  if (started.created) {
    await publishChannelEvent(deps.pubsub, {
      type: "agent.thinking",
      channelId: started.created.channelId,
      threadId: replyThreadOf(started.created),
      agentId: failed.agentId,
      runId: started.runId,
    });
  }
  return { agentId: failed.agentId, runId: started.runId };
}

/**
 * Routes a message again whose decision was `no_ai`: the decision is deleted and `routeMessage` called
 * directly (enqueueing `message.posted` again would do nothing: its dedupe key is still in the outbox).
 * Null when there is no such decision (any more).
 */
async function rerouteNoAiMessage(deps: AnswerNowDeps, userId: string, role: MemberRole, message: Message) {
  if (!deps.router) return null;
  const noAiDecision = and(
    eq(routingDecisions.orgId, message.orgId),
    eq(routingDecisions.messageId, message.id),
    eq(routingDecisions.error, NO_AI),
  );
  const [decision] = await deps.db.select({ id: routingDecisions.id }).from(routingDecisions).where(noAiDecision);
  if (!decision) return null;
  if (message.authorUserId !== userId && !can(role, "manage_agents")) throw forbidden();
  if (!(await orgHasAi(deps, message.orgId))) throw stillMissing();
  const deleted = await deps.db.delete(routingDecisions).where(noAiDecision).returning({ id: routingDecisions.id });
  if (deleted.length === 0) return null;
  const res = await routeMessage(deps.router, { orgId: message.orgId, messageId: message.id });
  await publishRouted(deps.pubsub, message, {
    strategy: res.seenBy ? "router" : "none",
    seenBy: res.seenBy ?? [],
    runs: res.runs,
    ...(res.reason ? { reason: res.reason } : {}),
    ...(res.decidedBy ? { decidedBy: res.decidedBy } : {}),
  });
  return res.runs.map((r) => ({ agentId: r.agentId, runId: r.id }));
}

/**
 * "Responder agora" (`POST …/messages/{id}/answer-now`, ADR 0061), once an AI is connected. The id is a
 * no-AI card (its agent's newest run in that conversation) or the person's message (the runs it started,
 * else its `no_ai` routing decision). A failed `no_ai` run that did nothing starts again on the person's
 * own message (one that did something: 409 `run.not_restartable`); a `no_ai` decision is routed again. Who
 * asked, the agent's owner or an admin (like "Continuar"). 409 `ai.still_missing` while there's still none;
 * 403 `audience.*` when the agent no longer answers who asked; pressed again, it returns what answers the
 * message.
 */
export async function answerNow(
  deps: AnswerNowDeps,
  userId: string,
  orgId: string,
  messageId: string,
): Promise<{ runs: Answering }> {
  const message = await getMessage(deps.db, orgId, messageId);
  if (!message || message.deletedAt) throw new NotFoundError("Message not found");
  const { membership } = await requireChannelAccess(deps.db, userId, orgId, message.channelId);
  const card = noAiCardOf(message);
  const found = await answeringRuns(deps.db, message, card);
  const failed = found.filter((r) => r.run.status === "failed" && r.run.error === NO_AI && !r.run.background);
  if (failed.length > 0) {
    const allowed = failed.filter(
      (r) => r.requester === userId || r.agent.ownerUserId === userId || can(membership.role, "manage_agents"),
    );
    if (allowed.length === 0) throw forbidden();
    const ready: AnsweringRun[] = [];
    for (const r of allowed) if ((await agentAiState(deps, r.agent, r.run)).state !== "no_ai") ready.push(r);
    if (ready.length === 0) throw stillMissing();
    // Who the agent answers may have narrowed since (an agent moved onto a plan answers only its owner until they
    // turn on Responde a todos, ADR 0059 §5):
    // a run starts again only for someone it still answers.
    const heard = ready.filter((r) => canTalkTo(r.agent, r.requester));
    const [first] = ready;
    if (heard.length === 0 && first) throw await audienceError(deps.db, first.agent);
    const runs: Answering = [];
    let worked = false;
    for (const r of heard) {
      const started = await restartNoAiRun(deps, userId, r.run);
      if (started === "worked") worked = true;
      else if (started) runs.push(started);
    }
    if (runs.length === 0 && worked) throw notRestartable();
    return { runs };
  }
  if (!card && message.authorType === "person") {
    const rerouted = await rerouteNoAiMessage(deps, userId, membership.role, message);
    if (rerouted) return { runs: rerouted };
  }
  return { runs: found.map((r) => ({ agentId: r.run.agentId, runId: r.run.id })) };
}
