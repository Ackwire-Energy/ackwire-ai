import type { PubSub } from "@agenteschat/adapters";
import { type Database, eq, schema } from "@agenteschat/db";
import { ProviderError } from "@agenteschat/providers";
import { getAgent } from "./agents";
import { buildRunContext } from "./context";
import { BudgetExceededError, MissingCredentialError, NotFoundError, ValidationError } from "./errors";
import { type ChannelEvent, publishChannelEvent, publishMessageCreated } from "./events";
import type { ModelGateway } from "./gateway";
import { insertMessage, messageView } from "./messages";
import { PermanentJobError } from "./outbox";
import { type AgentRun, addRunStep, type RunStatus, transitionRun } from "./runs";

export interface RunExecutorDeps {
  db: Database;
  gateway: ModelGateway;
  pubsub: PubSub;
  maxOutputTokens: number;
  contextMessages: number;
  /** Coalesce stream deltas for this long before publishing (0 = publish every delta). */
  deltaFlushMs?: number;
}

/** Errors that will not get better by retrying: the run fails right away with a readable reason. */
const userFacing = (error: unknown): string | null => {
  if (error instanceof BudgetExceededError) return "budget_exceeded";
  if (error instanceof MissingCredentialError) return "missing_credential";
  if (error instanceof ValidationError || error instanceof NotFoundError) return error.message;
  if (error instanceof ProviderError && !error.retryable) return `provider_error: ${error.message}`;
  return null;
};

/**
 * Executes one agent run (job `agent_run.execute`), end to end:
 * claim the run (queued → running), build context, stream through the Model
 * Gateway while publishing deltas to the channel, then persist the reply,
 * the steps and `done` in one transaction, and publish the message.
 *
 * Retries: transient provider failures rethrow so the outbox retries the job;
 * the run stays `running` and the retry restarts the turn. On the final
 * attempt, or for permanent problems (budget, credential), the run fails.
 */
export async function executeRun(deps: RunExecutorDeps, runId: string, options: { finalAttempt: boolean }) {
  const { db } = deps;
  const [loaded] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
  if (!loaded) throw new PermanentJobError(`agent run ${runId} not found`);
  let run: AgentRun = loaded;
  if (run.status === "done" || run.status === "failed" || run.status === "waiting_approval") return;
  if (run.status === "queued") {
    const started = await transitionRun(db, run.id, "queued", "running");
    if (!started) return; // another worker got it
    run = started;
  }
  // status is `running` here: either we just started it, or a previous attempt died mid-turn.

  const event = (status: RunStatus, error?: string): ChannelEvent => ({
    type: "agent.run",
    channelId: run.channelId,
    threadId: run.threadRootId,
    runId: run.id,
    agentId: run.agentId,
    status,
    ...(error ? { error } : {}),
  });
  const fail = async (reason: string) => {
    await addRunStep(db, run, "error", { reason });
    await transitionRun(db, run.id, "running", "failed", { error: reason });
    await publishChannelEvent(deps.pubsub, event("failed", reason));
  };

  const agent = await getAgent(db, run.orgId, run.agentId);
  if (!agent || agent.archivedAt) return fail("agent_archived");
  await publishChannelEvent(deps.pubsub, event("running"));

  const context = await buildRunContext(db, run, agent, { maxMessages: deps.contextMessages });
  await addRunStep(db, run, "context", { ...context.stats, model: agent.model });

  const deltas = createDeltaPublisher(deps.pubsub, run, deps.deltaFlushMs ?? 50);
  let result: Awaited<ReturnType<ModelGateway["stream"]>>;
  try {
    result = await deps.gateway.stream({
      orgId: run.orgId,
      agentId: agent.id,
      runId: run.id,
      system: context.system,
      messages: context.messages,
      maxTokens: deps.maxOutputTokens,
      onDelta: deltas.push,
    });
  } catch (error) {
    await deltas.flush();
    const reason = userFacing(error);
    if (reason) return fail(reason);
    if (options.finalAttempt) return fail(`gave_up: ${error instanceof Error ? error.message : String(error)}`);
    await addRunStep(db, run, "error", { reason: "transient", message: String(error), willRetry: true });
    throw error;
  }
  await deltas.flush();

  const callStep = {
    model: result.model,
    stopReason: result.stopReason,
    usageRecordId: result.usageRecordId,
    costNanoUsd: result.costNanoUsd,
    ...result.usage,
  };
  if (result.stopReason === "refusal" || result.text.trim() === "") {
    await addRunStep(db, run, "model_call", callStep);
    return fail(result.stopReason === "refusal" ? "model_refused" : "empty_reply");
  }

  const reply = await db.transaction(async (tx) => {
    await addRunStep(tx, run, "model_call", callStep);
    const message = await insertMessage(tx, {
      orgId: run.orgId,
      channelId: run.channelId,
      threadId: run.threadRootId,
      author: { type: "agent", agentId: agent.id, runId: run.id, hop: run.hop },
      body: result.text,
    });
    await addRunStep(tx, run, "message", { messageId: message.id, truncated: result.stopReason === "max_tokens" });
    const done = await transitionRun(tx, run.id, "running", "done", { replyMessageId: message.id, error: null });
    if (!done) throw new PermanentJobError("run changed state while executing");
    return message;
  });
  await publishMessageCreated(deps.pubsub, messageView(reply));
  await publishChannelEvent(deps.pubsub, event("done"));
}

/**
 * Batches stream deltas so a fast model doesn't send one pub/sub message per
 * token (each is a NOTIFY on the Postgres adapter). Chunks stay well under the
 * NOTIFY payload limit.
 */
function createDeltaPublisher(pubsub: PubSub, run: AgentRun, flushMs: number) {
  const MAX_CHUNK = 2000;
  let buffer = "";
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: Promise<void> = Promise.resolve();

  const send = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    while (buffer.length > 0) {
      const text = buffer.slice(0, MAX_CHUNK);
      buffer = buffer.slice(MAX_CHUNK);
      const evt: ChannelEvent = {
        type: "agent.delta",
        channelId: run.channelId,
        threadId: run.threadRootId,
        runId: run.id,
        agentId: run.agentId,
        seq: seq++,
        text,
      };
      pending = pending.then(() => publishChannelEvent(pubsub, evt));
    }
  };
  return {
    push(text: string) {
      buffer += text;
      if (flushMs === 0 || buffer.length >= MAX_CHUNK) send();
      else timer ??= setTimeout(send, flushMs);
    },
    async flush() {
      send();
      await pending;
    },
  };
}
