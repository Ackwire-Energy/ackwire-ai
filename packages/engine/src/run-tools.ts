import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, inArray, schema } from "@agenteschat/db";
import { publishApproval } from "./approvals";
import type { BrainTool, ToolResult } from "./brains/types";
import { getChannelCached } from "./context";
import { NotFoundError } from "./errors";
import { type MemoryUpdate, publishChannelEvent, publishMessageCreated } from "./events";
import { getMessage, insertMessage, type Message, messageView } from "./messages";
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
import type { AgentRun } from "./runs";
import { publishSecret, type SecretRequestRow, secretRequestView, syncSecretMessage } from "./secrets";
import { artifactToolDetail, toolCode, toolDetail } from "./tool-detail";
import type { Approval, InvokeResult, ToolGateway } from "./tools/gateway";
import type { ToolContext, ToolDefinition } from "./tools/types";
import { withWikiLinks } from "./wiki-links";

const { agentRuns, approvals, agentQuestions, secretRequests, machineTasks } = schema;

/**
 * Tool access for runs, shared by the engine loop and the runner's `agentes`
 * MCP bridge (ADR 0032 block 2) so both behave the same: where a run's cards
 * and events go (`replyThreadOf` / `runWhere`), the live tool chip
 * (`invokeWithChip`), tool side effects (`absorbToolData`, kept for the
 * engine's next post), bridge identities (`bridgeToolsFor`), calls with error
 * codes (`invokeToolForRun`) and the suspend path for gated calls
 * (`suspendRunForTool`). The engine's contract functions (`toolsForRun` /
 * `executeToolForRun` in `executor.ts`) call these.
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

/** Where a run's events and cards go. */
export interface RunWhere {
  channelId: string;
  threadId: string | null;
  agentId: string;
  runId: string;
}

/**
 * Where the run's replies go. DMs are flat (a reply to a top-level DM message
 * goes in the main timeline), and so are forum posts and a routine's answer
 * (the routine's own message isn't shown, so nothing can hang under it);
 * everything else answers in the thread. The one rule for the engine and the
 * bridge: cards and events of a run always land where its replies do.
 */
export function replyThreadOf(
  run: Pick<AgentRun, "threadRootId" | "triggerMessageId">,
  channelKind: string | undefined,
  topTrigger: Pick<Message, "meta"> | null,
): string | null {
  const topLevel = run.threadRootId === run.triggerMessageId;
  const flat = topLevel && (channelKind === "dm" || channelKind === "forum" || Boolean(topTrigger?.meta.routine));
  return flat ? null : run.threadRootId;
}

/** `replyThreadOf` for a run row: reads its channel and (when top-level) its trigger. */
export async function runWhere(
  db: Database,
  run: Pick<AgentRun, "id" | "orgId" | "agentId" | "channelId" | "threadRootId" | "triggerMessageId">,
): Promise<RunWhere> {
  const topLevel = run.threadRootId === run.triggerMessageId;
  const [channel, topTrigger] = await Promise.all([
    getChannelCached(db, run.orgId, run.channelId),
    topLevel ? getMessage(db, run.orgId, run.triggerMessageId) : Promise.resolve(null),
  ]);
  return {
    channelId: run.channelId,
    threadId: replyThreadOf(run, channel?.kind, topTrigger),
    agentId: run.agentId,
    runId: run.id,
  };
}

/**
 * A body the server writes for an agent message (approval and secret cards,
 * closing lines): its code and params, so the app shows it in the person's
 * language (`chat.body.{code}`); the English body is the fallback.
 */
export const bodyCode = (code: string, params: Record<string, string> = {}) => ({
  bodyCode: code,
  bodyParams: params,
});

export const brainToolOf = (t: ToolDefinition): BrainTool => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
});

// ── Side effects of tools ────────────────────────────────────────────────────

/** What tools leave for the next message the run posts (cards), and how it ends (`react`). */
export interface ToolSideEffects {
  /** Memory changes, for the "memory updated" card (`meta.memoryUpdates`). */
  memoryUpdates?: MemoryUpdate[];
  /** Artifacts created or changed (`meta.artifacts`). */
  artifacts?: { id: string; version: number }[];
  /** A mission proposed with its home elsewhere: its link card (`meta.missionLink`). */
  missionLink?: { missionId: string; threadId: string } | null;
  /** The agent reacted (`react`) instead of replying. */
  reacted?: boolean;
  /** The GitHub repository the run last worked in (`owner/name`), for "Trabalhando em" and Atividade. */
  repo?: string;
  /** A GitHub repository the run was refused (not in the agent's list): Atividade offers to add it. */
  deniedRepo?: string;
}

/**
 * Moves what a tool returned (`output.data`) onto `t`. Returns the memory
 * update, if any, for the caller to announce (`memory.updated`).
 */
export function absorbToolData(t: ToolSideEffects, data: Record<string, unknown> | undefined): MemoryUpdate | null {
  if (!data) return null;
  const artifact = data.artifact as { id: string; version: number } | undefined;
  if (artifact) t.artifacts = [...(t.artifacts ?? []), artifact];
  const link = data.missionLink as { missionId: string; threadId: string } | undefined;
  if (link?.missionId && link.threadId) t.missionLink = link;
  if (data.reacted) t.reacted = true;
  if (typeof data.repo === "string") t.repo = data.repo;
  if (typeof data.deniedRepo === "string") t.deniedRepo = data.deniedRepo;
  const update = data.memoryUpdate as MemoryUpdate | undefined;
  if (update) t.memoryUpdates = [...(t.memoryUpdates ?? []), update];
  return update ?? null;
}

/** Adds side effects gathered elsewhere (the bridge's) onto `t`. */
export function mergeToolEffects(t: ToolSideEffects, e: ToolSideEffects | null | undefined) {
  if (!e) return;
  if (e.artifacts?.length) t.artifacts = [...(t.artifacts ?? []), ...e.artifacts];
  if (e.memoryUpdates?.length) t.memoryUpdates = [...(t.memoryUpdates ?? []), ...e.memoryUpdates];
  if (e.missionLink) t.missionLink = e.missionLink;
  if (e.reacted) t.reacted = true;
  if (e.repo) t.repo = e.repo;
  if (e.deniedRepo) t.deniedRepo = e.deniedRepo;
}

const hasEffects = (e: ToolSideEffects) =>
  Boolean(e.artifacts?.length || e.memoryUpdates?.length || e.missionLink || e.reacted || e.repo || e.deniedRepo);

/** The transcript key where the bridge leaves a computer-brain turn's side effects for the engine. */
const BRIDGE_EFFECTS = "bridgeEffects";

/**
 * A bridged call's side effects (a computer brain's tool through the runner
 * bridge): kept on the run (`transcript.bridgeEffects`) until the engine ends
 * the turn and takes them (`takeBridgeEffects`), exactly as the loop keeps its
 * own (`absorbToolData`): the reply carries the cards, and a `react` closes the
 * turn silently. The memory update is announced now.
 */
async function recordBridgeEffects(
  deps: RunToolsDeps,
  run: AgentRun,
  where: RunWhere,
  data: Record<string, unknown> | undefined,
) {
  const effects: ToolSideEffects = {};
  const update = absorbToolData(effects, data);
  if (!hasEffects(effects)) return;
  await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ transcript: agentRuns.transcript })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.id))
      .for("update");
    // No transcript: the engine never ran this run (it builds one before a computer turn), nothing to keep.
    const t = row?.transcript as Record<string, unknown> | null | undefined;
    if (!t) return;
    const kept = { ...((t[BRIDGE_EFFECTS] ?? {}) as ToolSideEffects) };
    mergeToolEffects(kept, effects);
    await tx
      .update(agentRuns)
      .set({ transcript: { ...t, [BRIDGE_EFFECTS]: kept }, updatedAt: new Date() })
      .where(eq(agentRuns.id, run.id));
  });
  if (update) await publishChannelEvent(deps.pubsub, { type: "memory.updated", ...where, update });
}

/** Takes (and clears) the side effects the bridge kept for this run (`recordBridgeEffects`). */
export async function takeBridgeEffects(db: Database, runId: string): Promise<ToolSideEffects | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ transcript: agentRuns.transcript })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .for("update");
    const t = row?.transcript as Record<string, unknown> | null | undefined;
    const kept = t?.[BRIDGE_EFFECTS] as ToolSideEffects | undefined;
    if (!t || !kept) return null;
    const { [BRIDGE_EFFECTS]: _taken, ...rest } = t;
    await tx.update(agentRuns).set({ transcript: rest, updatedAt: new Date() }).where(eq(agentRuns.id, runId));
    return kept;
  });
}

// ── Calls ────────────────────────────────────────────────────────────────────

/** What `invokeWithChip` needs: the run's tool context, where its events go and the tools of this turn. */
export interface RunToolScope {
  deps: { db: Database; pubsub?: PubSub };
  tools: ToolGateway;
  ctx: ToolContext;
  where: RunWhere;
  /**
   * The run's tool list (for the connector label of the live tool chip).
   * Null when unknown (a bridge call): the chip shows only the tool's name.
   */
  turnTools: ToolDefinition[] | null;
}

/**
 * One tool call through the Tool Gateway, with the live tool chip
 * (`agent.tool` before and after). The gateway checks the scope, validates the
 * input, records the steps and gates sensitive calls (approval / question /
 * secret outcomes).
 */
export async function invokeWithChip(
  scope: RunToolScope,
  use: { id: string; name: string; input: unknown },
): Promise<InvokeResult> {
  const { deps, ctx, where } = scope;
  const def = scope.turnTools?.find((t) => t.name === use.name);
  const connector = def?.connectorLabel;
  // A short label for the UI (skill, issue, file); built-in tools only, never connector inputs.
  const input = use.input as Record<string, unknown> | undefined;
  const builtIn = scope.turnTools !== null && !(connector || def?.connectionId);
  const detail = builtIn
    ? (toolDetail(use.name, input) ??
      (await artifactToolDetail(deps.db, ctx.orgId, ctx.channelId, use.name, input).catch(() => undefined)))
    : undefined;
  const code = builtIn ? toolCode(use.name, input) : undefined;
  await publishChannelEvent(deps.pubsub, {
    type: "agent.tool",
    ...where,
    tool: use.name,
    ...(connector ? { connector } : {}),
    ...(detail ? { detail } : {}),
    toolUseId: use.id,
    ...(code ? { code } : {}),
  });
  return scope.tools
    .invoke(ctx, { toolUseId: use.id, name: use.name, input: (use.input ?? {}) as Record<string, unknown> })
    .finally(() => publishChannelEvent(deps.pubsub, { type: "agent.tool", ...where, tool: null }));
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

/**
 * The tools of a bridge identity, as `BrainTool[]`: a run's (the Tool Gateway
 * list with its scopes, mission tools when in a mission thread) or a mission
 * task's (its own gateway). `machineId` marks the context as a bridge call.
 */
export async function bridgeToolsFor(deps: RunToolsDeps, id: BridgeIdentity): Promise<BrainTool[]> {
  if (!deps.tools) return [];
  const { ctx } = await locate(deps.db, id);
  const tools = await deps.tools.list(ctx);
  // Our own tools before the connectors': a cap on the list (`MCP_TOOLS_MAX`) only ever drops connector tools.
  return [...tools.filter((t) => !t.connectionId), ...tools.filter((t) => t.connectionId)].map(brainToolOf);
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
 * One call for a run or a mission task from outside the engine loop (the
 * runner bridge, `executeToolForRun`), with the error code the bridge answers
 * with. Same path as the loop: the live tool chip where the run's replies go,
 * the Tool Gateway, the side effects kept for the engine's next post
 * (`recordBridgeEffects`), and a gated call (approval, `ask_user`,
 * `request_secret`, a mission tool's own wait) suspends the run
 * (`suspendRunForTool`). A mission task's tools are never gated (their waits
 * are the mission's own).
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
  const where = run ? await runWhere(deps.db, run) : null;
  const use = { id: call.id, name: call.name, input };
  const outcome = where
    ? await invokeWithChip({ deps, tools, ctx, where, turnTools: null }, use)
    : await tools.invoke(ctx, { toolUseId: call.id, name: call.name, input });
  if (run && where && outcome.type === "result") await recordBridgeEffects(deps, run, where, outcome.output.data);
  const wait = outcome.type === "result" && !outcome.output.isError ? waitOf(outcome.output.data) : null;
  const suspend = async (pause: RunPause, r: AgentRun): Promise<BridgeCallResult> => {
    const result = await suspendRunForTool(deps, r, { id: call.id, name: call.name }, pause);
    return result.isError ? { result, code: "bridge.run_not_running" } : { result };
  };
  if (wait && run) {
    return suspend(
      { type: "wait", id: wait.id, content: outcome.type === "result" ? outcome.output.content : "" },
      run,
    );
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
  return suspend(outcome, run);
}

/**
 * A mission tool's own wait (ADR 0032 §6): a blocking `ask_decision` or a
 * `request_review` on the engine returns `data.pause` with the decision's or
 * review's id; the run waits on it (`waiting_input`) and resumes with the
 * answer (`resumeRunWithResult`).
 */
export function waitOf(data: Record<string, unknown> | undefined): { id: string } | null {
  const pause = data?.pause as { kind?: unknown; id?: unknown } | undefined;
  return pause && typeof pause.id === "string" && pause.id ? { id: pause.id } : null;
}

/** A gated call the run pauses on: the gateway's (approval, question, secret) or a mission tool's wait. */
export type RunPause = Exclude<InvokeResult, { type: "result" }> | { type: "wait"; id: string; content: string };

/**
 * A computer brain's gated call (through the bridge) pauses the run exactly
 * like the model path does: the approval / question / secret card is posted
 * where the run's replies go (`runWhere`), the call joins the transcript's
 * pending calls, and the run moves to `waiting_approval` / `waiting_input`. On
 * the decision the engine resumes the run, and the brain session gets the
 * result ("approved: …" / "refused: …").
 *
 * The run row is locked first and its state decides before anything is
 * posted: `running` → it suspends; already waiting on a call bridged in this
 * turn (two gated calls at once) → this call joins the pending calls; anything
 * else (ended, canceled, waiting for its computer) → nothing is posted, the
 * gated request is canceled and the brain reads an error.
 *
 * Returns the `ToolResult` the brain reads: stop and end the turn.
 */
export async function suspendRunForTool(
  deps: RunToolsDeps,
  run: AgentRun,
  call: { id: string; name: string },
  gated: RunPause,
): Promise<ToolResult> {
  const { db } = deps;
  const where = await runWhere(db, run);
  const threadId = where.threadId;
  const wanted = gated.type === "approval" ? "waiting_approval" : "waiting_input";
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
    // Lock and decide first: the card is posted only when the pending call is kept too.
    const [locked] = await tx
      .select({ status: agentRuns.status, transcript: agentRuns.transcript })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.id))
      .for("update");
    const transcript = locked?.transcript as
      | (Record<string, unknown> & {
          pending?: { calls: Record<string, unknown>[] };
          postedCount?: number;
          waitingForBrain?: unknown;
        })
      | null
      | undefined;
    const joinsPause =
      (locked?.status === "waiting_approval" || locked?.status === "waiting_input") &&
      !transcript?.waitingForBrain &&
      (transcript?.pending?.calls ?? []).some((c) => c.bridged === true);
    if (!locked || (locked.status !== "running" && !joinsPause)) {
      // Nothing waits on it: the request the gateway made is canceled, nothing is posted.
      if (gated.type === "approval") {
        await tx
          .update(approvals)
          .set({ status: "canceled", decidedAt: new Date() })
          .where(and(eq(approvals.id, gated.approval.id), eq(approvals.status, "pending")));
      } else if (gated.type === "secret") {
        await tx
          .update(secretRequests)
          .set({ status: "canceled" })
          .where(and(eq(secretRequests.id, gated.requestId), eq(secretRequests.status, "pending")));
      }
      return null;
    }
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
    // The engine's resume reads the pending calls from the transcript.
    const pendingCall = {
      toolUseId: call.id,
      name: call.name,
      // Its tool_use lives in the computer brain's session, not in the transcript: resumed as text.
      bridged: true,
      ...(gated.type === "approval" ? { approvalId: gated.approval.id } : {}),
      ...(questionId ? { questionId } : {}),
      ...(gated.type === "secret" ? { secretRequestId: gated.requestId } : {}),
      ...(gated.type === "wait" ? { waitId: gated.id } : {}),
    };
    // Waiting on an answer as well as an approval: the run waits for input (the resume checks every call).
    const status: "waiting_approval" | "waiting_input" =
      locked.status === "waiting_input" || wanted === "waiting_input" ? "waiting_input" : wanted;
    await tx
      .update(agentRuns)
      .set({
        status,
        updatedAt: new Date(),
        // Without a transcript (never executed by the engine) there is nothing to resume from: state only.
        ...(transcript
          ? {
              transcript: {
                ...transcript,
                postedCount: (transcript.postedCount ?? 0) + messages.length,
                pending: { calls: [...(transcript.pending?.calls ?? []), pendingCall] },
              },
            }
          : {}),
      })
      .where(
        and(eq(agentRuns.id, run.id), inArray(agentRuns.status, ["running", "waiting_approval", "waiting_input"])),
      );
    return { messages, card, question, secret, status, changed: locked.status !== status };
  });

  if (!posted) {
    return {
      content: "This run isn't running anymore, so nothing was asked. Stop now and end your turn.",
      isError: true,
    };
  }
  const waitingFor = posted.status;
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
  if (posted.changed) {
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
  if (gated.type === "wait") {
    return {
      content: `${gated.content} Stop now and end your turn; you'll be resumed with the answer.`.trim(),
      pause: { kind: "input", id: gated.id },
    };
  }
  return {
    content: `Asked: ${gated.text} Stop now and end your turn; you'll be resumed with the answer.`,
    pause: { kind: "input", id: questionId ?? call.id },
  };
}
