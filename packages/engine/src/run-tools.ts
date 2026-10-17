import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, schema } from "@agenteschat/db";
import { publishApproval } from "./approvals";
import type { BrainTool, ToolResult } from "./brains/types";
import { getChannelCached } from "./context";
import { NotFoundError } from "./errors";
import { publishChannelEvent, publishMessageCreated } from "./events";
import { insertMessage, type Message, messageView } from "./messages";
import { notifyMissionApproval } from "./mission-tools";
import { notifyQuestion } from "./notification-producers";
import {
  type AgentQuestionRow,
  publishQuestion,
  QUESTION_TTL_MS,
  questionView,
  syncQuestionMessage,
} from "./questions";
import type { BridgeIdentity } from "./run-tool-tokens";
import { type AgentRun, transitionRun } from "./runs";
import { publishSecret, type SecretRequestRow, secretRequestView, syncSecretMessage } from "./secrets";
import type { Approval, InvokeResult, ToolGateway } from "./tools/gateway";
import type { ToolContext, ToolDefinition } from "./tools/types";
import { withWikiLinks } from "./wiki-links";

const { agentRuns, approvals, agentQuestions, secretRequests, machineTasks } = schema;

/**
 * Tool access from outside the engine loop: the runner's `agentes` MCP bridge
 * (ADR 0032 block 2). The engine's contract functions (`toolsForRun` /
 * `executeToolForRun`) live in `executor.ts`; this module holds what the
 * bridge adds on top: mission-task identities (`bridgeToolsFor`), error codes
 * (`invokeToolForRun`) and the suspend path for gated calls
 * (`suspendRunForTool`), which the engine's `executeToolForRun` uses too.
 */
export interface RunToolsDeps {
  db: Database;
  pubsub?: PubSub;
  /** The Tool Gateway the run's tools come from (a mission task's: the mission tools' own gateway). */
  tools?: ToolGateway | null;
}

/** A tool call's result for the bridge: the contract's `ToolResult` plus a stable error code. */
export interface BridgeCallResult {
  result: ToolResult;
  code?: string;
}

type Located = { ctx: ToolContext; run: AgentRun | null };

/**
 * The tool context of an identity. A run: its row (org and agent must match).
 * A mission task (`taskId`): the task's channel and thread, no run (the
 * gateway records no steps), marked as the task's bridge call.
 */
async function locate(db: Database, id: BridgeIdentity): Promise<Located> {
  if (id.taskId) {
    const [task] = await db
      .select()
      .from(machineTasks)
      .where(
        and(eq(machineTasks.id, id.taskId), eq(machineTasks.orgId, id.orgId), eq(machineTasks.agentId, id.agentId)),
      );
    if (!task) throw new NotFoundError("Task not found");
    return {
      run: null,
      ctx: {
        db,
        orgId: task.orgId,
        agentId: task.agentId,
        runId: "",
        channelId: task.channelId,
        threadRootId: task.threadRootId ?? "",
        triggerMessageId: "",
        bridge: { machineId: id.machineId, taskId: task.id },
      },
    };
  }
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, id.runId), eq(agentRuns.orgId, id.orgId), eq(agentRuns.agentId, id.agentId)));
  if (!run) throw new NotFoundError("Run not found");
  return {
    run,
    ctx: {
      db,
      orgId: run.orgId,
      agentId: run.agentId,
      runId: run.id,
      channelId: run.channelId,
      threadRootId: run.threadRootId,
      triggerMessageId: run.triggerMessageId,
      ...(id.machineId ? { bridge: { machineId: id.machineId } } : {}),
    },
  };
}

const brainToolOf = (t: ToolDefinition): BrainTool => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
});

/**
 * The tools of a bridge identity, as `BrainTool[]`: a run's (the engine's
 * `toolsForRun` list, mission tools when in a mission thread) or a mission
 * task's (its own gateway). `machineId` marks the context as a bridge call.
 */
export async function bridgeToolsFor(deps: RunToolsDeps, id: BridgeIdentity): Promise<BrainTool[]> {
  if (!deps.tools) return [];
  const { ctx } = await locate(deps.db, id);
  return (await deps.tools.list(ctx)).map(brainToolOf);
}

/** The gateway's own refusals, as codes (the gateway returns them as plain error text). */
function codeOf(content: string, data?: Record<string, unknown>) {
  if (typeof data?.code === "string") return data.code;
  if (content.startsWith("Invalid input:")) return "tool.invalid_input";
  if (content.startsWith("Unknown tool")) return "tool.unknown";
  if (content.startsWith("Not allowed:")) return "tool.not_allowed";
  return "tool.failed";
}

/**
 * One bridge call with the error code the bridge answers with. A run's
 * gated call (approval, `ask_user`, `request_secret`) suspends the run here
 * (`suspendRunForTool`), exactly like the model path; a mission task's tools
 * are never gated (their waits are the mission's own).
 */
export async function invokeToolForRun(
  deps: RunToolsDeps,
  id: BridgeIdentity,
  call: { id: string; name: string; input: unknown },
): Promise<BridgeCallResult> {
  const tools = deps.tools;
  if (!tools) return { result: { content: "No tools are available in this run.", isError: true }, code: "tool.none" };
  const { ctx, run } = await locate(deps.db, id);
  const input = (
    call.input && typeof call.input === "object" && !Array.isArray(call.input) ? call.input : {}
  ) as Record<string, unknown>;
  const where = run ? await whereOf(deps.db, run) : null;
  if (where)
    await publishChannelEvent(deps.pubsub, { type: "agent.tool", ...where, tool: call.name, toolUseId: call.id });
  let outcome: InvokeResult;
  try {
    outcome = await tools.invoke(ctx, { toolUseId: call.id, name: call.name, input });
  } finally {
    if (where) await publishChannelEvent(deps.pubsub, { type: "agent.tool", ...where, tool: null });
  }
  if (outcome.type === "result") {
    const isError = outcome.output.isError === true;
    return {
      result: { content: outcome.output.content, ...(isError ? { isError: true } : {}) },
      ...(isError ? { code: codeOf(outcome.output.content, outcome.output.data) } : {}),
    };
  }
  if (!run) {
    return { result: { content: "This call can't wait for a person here.", isError: true }, code: "tool.not_allowed" };
  }
  return { result: await suspendRunForTool(deps, run, { id: call.id, name: call.name }, outcome) };
}

/** Where a run's events and cards go: its thread, or the main timeline of a flat DM or forum turn. */
async function whereOf(db: Database, run: AgentRun) {
  const topLevel = run.threadRootId === run.triggerMessageId;
  let flat = false;
  if (topLevel) {
    const channel = await getChannelCached(db, run.orgId, run.channelId);
    flat = channel?.kind === "dm" || channel?.kind === "forum";
  }
  return { channelId: run.channelId, threadId: flat ? null : run.threadRootId, agentId: run.agentId, runId: run.id };
}

const bodyCode = (code: string, params: Record<string, string> = {}) => ({ bodyCode: code, bodyParams: params });

/**
 * A computer brain's gated call (through the bridge) pauses the run exactly
 * like the model path does: the approval / question / secret card is posted
 * in the run's thread, the call joins the transcript's pending calls (when
 * the engine keeps one), and the run moves to `waiting_approval` /
 * `waiting_input`. On the decision the engine resumes the run, and the brain
 * session gets the result ("approved: …" / "refused: …").
 *
 * Returns the `ToolResult` the brain reads: stop and end the turn.
 */
export async function suspendRunForTool(
  deps: RunToolsDeps,
  run: AgentRun,
  call: { id: string; name: string },
  gated: Exclude<InvokeResult, { type: "result" }>,
): Promise<ToolResult> {
  const { db } = deps;
  const where = await whereOf(db, run);
  const threadId = where.threadId;
  const waitingFor = gated.type === "approval" ? "waiting_approval" : "waiting_input";
  const questionId = gated.type === "question" ? Bun.randomUUIDv7() : null;
  const post = (tx: Executor, body: string, meta: Record<string, unknown>) =>
    insertMessage(tx, {
      orgId: run.orgId,
      channelId: run.channelId,
      threadId,
      author: { type: "agent", agentId: run.agentId, runId: run.id, hop: run.hop },
      body,
      meta,
    });

  const posted = await db.transaction(async (tx) => {
    const messages: Message[] = [];
    let card: Approval | null = null;
    let question: AgentQuestionRow | null = null;
    let secret: SecretRequestRow | null = null;
    if (gated.type === "approval") {
      const message = await post(tx, `Approval request: ${gated.approval.title}`, {
        ...bodyCode("approval_request", { title: gated.approval.title }),
        approvalId: gated.approval.id,
      });
      messages.push(message);
      const [linked] = await tx
        .update(approvals)
        .set({ messageId: message.id })
        .where(eq(approvals.id, gated.approval.id))
        .returning();
      card = linked ?? gated.approval;
    } else if (gated.type === "question" && questionId) {
      const [inserted] = await tx
        .insert(agentQuestions)
        .values({
          id: questionId,
          orgId: run.orgId,
          runId: run.id,
          agentId: run.agentId,
          channelId: run.channelId,
          threadId,
          toolUseId: call.id,
          text: gated.text,
          choices: gated.choices,
          expiresAt: new Date(Date.now() + QUESTION_TTL_MS),
        })
        .onConflictDoNothing()
        .returning();
      if (inserted) {
        const message = await post(tx, gated.text, { questionId, question: questionView(inserted) });
        messages.push(message);
        const [linked] = await tx
          .update(agentQuestions)
          .set({ messageId: message.id })
          .where(eq(agentQuestions.id, questionId))
          .returning();
        if (linked) {
          await syncQuestionMessage(tx, linked);
          message.meta = { ...message.meta, question: questionView(linked) };
          question = linked;
        }
      }
    } else if (gated.type === "secret") {
      const [request] = await tx
        .update(secretRequests)
        .set({ threadId })
        .where(eq(secretRequests.id, gated.requestId))
        .returning();
      if (request) {
        const message = await post(tx, `Secret request: ${request.name}`, {
          ...bodyCode("secret_request", { name: request.name }),
          secretRequestId: request.id,
          secretRequest: secretRequestView(request),
        });
        messages.push(message);
        const [linked] = await tx
          .update(secretRequests)
          .set({ messageId: message.id })
          .where(eq(secretRequests.id, request.id))
          .returning();
        if (linked) {
          await syncSecretMessage(tx, linked);
          message.meta = { ...message.meta, secretRequest: secretRequestView(linked) };
          secret = linked;
        }
      }
    }
    // The engine's resume reads the pending calls from the transcript (when it keeps one for this run).
    const [fresh] = await tx
      .select({ transcript: agentRuns.transcript })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.id));
    const transcript = fresh?.transcript as
      | (Record<string, unknown> & { pending?: { calls: Record<string, unknown>[] }; postedCount?: number })
      | null;
    const pendingCall = {
      toolUseId: call.id,
      name: call.name,
      // Its tool_use lives in the computer brain's session, not in the transcript: resumed as text.
      bridged: true,
      ...(gated.type === "approval" ? { approvalId: gated.approval.id } : {}),
      ...(questionId ? { questionId } : {}),
      ...(gated.type === "secret" ? { secretRequestId: gated.requestId } : {}),
    };
    const patch = transcript
      ? {
          transcript: {
            ...transcript,
            postedCount: (transcript.postedCount ?? 0) + messages.length,
            pending: { calls: [...(transcript.pending?.calls ?? []), pendingCall] },
          },
        }
      : {};
    const suspended = await transitionRun(tx, run.id, "running", waitingFor, patch);
    return { messages, card, question, secret, suspended: Boolean(suspended) };
  });

  const pubsub = deps.pubsub;
  if (pubsub) {
    for (const m of await withWikiLinks(db, run.orgId, posted.messages.map(messageView))) {
      await publishMessageCreated(pubsub, m);
    }
  }
  if (deps.pubsub && posted.card) {
    await publishApproval({ db, pubsub: deps.pubsub }, posted.card, "approval.created");
    if (posted.card.missionId) {
      await notifyMissionApproval({ db, pubsub: deps.pubsub }, posted.card).catch(() => undefined);
    }
  }
  if (posted.question) {
    await publishQuestion(deps.pubsub, posted.question, "question.asked");
    await notifyQuestion({ db, pubsub: deps.pubsub } as Parameters<typeof notifyQuestion>[0], posted.question).catch(
      () => {},
    );
  }
  if (posted.secret) await publishSecret(deps.pubsub, posted.secret, "secret.requested");
  if (posted.suspended) {
    await publishChannelEvent(deps.pubsub, {
      type: "agent.run",
      channelId: run.channelId,
      threadId,
      runId: run.id,
      agentId: run.agentId,
      status: waitingFor,
    });
  }

  if (gated.type === "approval") {
    return {
      content: `Waiting for a person to approve: ${gated.approval.title}. Stop now and end your turn; you'll be resumed with the decision.`,
      pause: { kind: "approval", id: gated.approval.id },
    };
  }
  if (gated.type === "secret") {
    return {
      content: "Waiting for a person to provide the secret. Stop now and end your turn; you'll be resumed.",
      pause: { kind: "input", id: gated.requestId },
    };
  }
  return {
    content: `Asked: ${gated.text} Stop now and end your turn; you'll be resumed with the answer.`,
    pause: { kind: "input", id: questionId ?? call.id },
  };
}
