import { and, type Executor, eq, type SQL, schema, sql } from "@agenteschat/db";
import { PROVIDERS } from "@agenteschat/providers";
import { pgSafeJson } from "./format";
import { recordRunFinished } from "./operator-events";
import { standingErrorDetail } from "./standing";

const { agentRuns, agentRunSteps } = schema;

export type AgentRun = typeof agentRuns.$inferSelect;
export type RunStatus = AgentRun["status"];

/** For a select over `agent_runs`: parked on a provider outage (`transcript.outage`), it resumes by itself. */
export const outageParkedSql = sql<boolean>`(${agentRuns.status} = 'waiting_input' and ${agentRuns.transcript} -> 'outage' is not null)`;

/**
 * For a select over `agent_runs`: it ended without answering, so its receipt reads "didn't reply": it passed and posted
 * nothing anywhere (the `passed` step is `silent`, `endQuietly`), or it was canceled before it started.
 * `agent_runs.id` is spelled out: a one-table select renders columns unqualified, and a bare "id" in the
 * subquery would be the step's.
 */
export const passedSql = sql<boolean>`((${agentRuns.status} = 'done' and ${agentRuns.replyMessageId} is null
  and exists (select 1 from ${agentRunSteps} where ${agentRunSteps.runId} = agent_runs.id
  and ${agentRunSteps.kind} = 'context' and ${agentRunSteps.data}->'passed'->>'silent' = 'true'))
  or (${agentRuns.status} = 'canceled' and ${agentRuns.startedAt} is null))`;

/**
 * For a select over `agent_runs`: waiting for its computer, in line for room (`queued`) or for it to be back (`away`),
 * or long work waiting in the agent's line of work (`line`, ADR 0121): nobody is asked anything.
 */
export const computerWaitSql = sql<"queued" | "away" | "line" | null>`(case when ${agentRuns.status} = 'waiting_input'
  and ${agentRuns.waitingMachineId} is not null then (case when ${agentRuns.transcript}->'waitingForBrain'->>'code' = 'busy'
  then 'queued' else 'away' end)
  when ${agentRuns.status} = 'waiting_input' and ${agentRuns.transcript}->'waitingForBrain'->>'code' = 'work_queue' then 'line' end)`;

/**
 * For a select over `agent_runs`: waiting on its plan's limit (`plan`) or its budget (`budget`), long work paused near
 * one too (`usage_pause`, by its `source`): it answers when that renews, nobody is asked.
 */
export const usageWaitSql = sql<"plan" | "budget" | null>`(case when ${agentRuns.status} = 'waiting_input'
  and ${agentRuns.waitingMachineId} is null then (case ${agentRuns.transcript}->'waitingForBrain'->>'code'
  when 'plan_limit' then 'plan' when 'budget' then 'budget'
  when 'usage_pause' then coalesce(${agentRuns.transcript}->'waitingForBrain'->>'source', 'plan') end) end)`;

/**
 * Where a run's replies go: asked in the main timeline (a channel, a DM
 * or a forum post), it answers in the main timeline; asked in a thread, in
 * that thread. The run keeps `threadRootId` (its trigger, when top-level) as
 * the conversation it belongs to. The one rule for the engine, its tools and
 * the bridge: cards and events of a run always land where its replies do.
 */
export function replyThreadOf(run: Pick<AgentRun, "threadRootId" | "triggerMessageId">): string | null {
  return run.threadRootId === run.triggerMessageId ? null : run.threadRootId;
}

/**
 * Allowed transitions of `agent_runs.status` (docs/adr/0008-agent-runs.md):
 * `queued → running → ((waiting_approval | waiting_input) → running)* → done | failed`,
 * and any non-final state → `canceled` (a person stopped it). The last three are terminal. Suspending for an approval is a status
 * change; resuming is enqueueing a new `agent_run.execute` job.
 */
export const RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ["running", "failed", "canceled"],
  running: ["waiting_approval", "waiting_input", "done", "failed", "canceled"],
  waiting_approval: ["running", "failed", "canceled"],
  /** Waiting for a person to answer an `ask_user` question (or for it to expire). */
  waiting_input: ["running", "failed", "canceled"],
  done: [],
  failed: [],
  /** A person stopped it; whatever it wrote so far is kept. */
  canceled: [],
};

/** A run's error (and a routing decision's) when nobody could think: no AI connected. */
export const NO_AI = "no_ai" as const;
/** A run's error when the person behind it is at their monthly AI limit (ADR 0141): its card says so. */
export const PERSON_LIMIT = "person_limit" as const;
/** An older run's error from when a run waited at most 30 minutes for room on its computer (still worded). */
export const COMPUTER_BUSY = "computer_busy" as const;
/** A run's error when it went in circles and its kind of run can't end with Continuar (a routine's, a forum's). */
export const STUCK_ERROR = "stuck" as const;

/** A run's error when its server stopped in the middle of a tool call (a deploy, a crash, a reboot). */
export const INTERRUPTED_BY_RESTART = "Interrupted by a server restart";

/**
 * A computer brain's generic failure codes (`BrainFailure.code`, from the brains and the runner): worded as the
 * computer's problem, the code kept only as a detail. The ones that call for a different step (signed out, outdated
 * program, missing CLI, plan limit) keep their own code.
 */
const COMPUTER_ERRORS = new Set(["runner_error", "runner_failed", "claude_failed", "bad_request"]);

/** Older stored errors name Claude's provider by the company, "Anthropic": they read with today's label. */
const providerNow = (label: string) => (label === "Anthropic" ? PROVIDERS.anthropic.label : label);

/**
 * The stable code (and params) of a run's stored `error`, for the app to
 * word it in the person's language; the stored text stays as the fallback.
 */
export function runErrorDetail(error: string | null | undefined): {
  errorCode: string;
  errorParams?: Record<string, string>;
} | null {
  if (!error) return null;
  const simple = [
    "budget_exceeded",
    "too_many_tool_calls",
    "empty_reply",
    "model_refused",
    "agent_archived",
    NO_AI,
    PERSON_LIMIT,
    COMPUTER_BUSY,
    STUCK_ERROR,
  ];
  if (simple.includes(error)) return { errorCode: `run.${error}` };
  if (error === "timeout") return { errorCode: "run.computer_timeout", errorParams: { code: error } };
  if (COMPUTER_ERRORS.has(error)) return { errorCode: "run.computer_failed", errorParams: { code: error } };
  if (error.startsWith("provider_error:")) {
    return { errorCode: "run.provider_error", errorParams: { detail: error.slice(15).trim() } };
  }
  if (error.startsWith("gave_up:"))
    return { errorCode: "run.provider_unavailable", errorParams: { detail: error.slice(8).trim() } };
  if (error.startsWith("canceled_by:"))
    return { errorCode: "run.canceled", errorParams: { byUserId: error.slice(12) } };
  const standing = standingErrorDetail(error);
  if (standing) return standing;
  // Older rows hold the Portuguese texts these errors used to have, or an earlier wording: still recognized.
  if (
    error === INTERRUPTED_BY_RESTART ||
    error === "Interrupted by a server update" ||
    error === "Interrompida por uma atualização do servidor"
  ) {
    return { errorCode: "run.interrupted", errorParams: { reason: "deploy" } };
  }
  const none =
    /^Add an API key for (.+) in the workspace settings$/.exec(error) ??
    /^Configure uma chave da API da (.+) nas configurações do workspace$/.exec(error);
  if (none) return { errorCode: "run.missing_credential", errorParams: { provider: providerNow(none[1] as string) } };
  if (
    error.startsWith("This agent's API key was revoked") ||
    error.startsWith("A chave da API deste agente foi revogada")
  )
    return { errorCode: "run.credential_revoked" };
  const wrong =
    /^This agent's model is from (.+), but the chosen key is from (.+)$/.exec(error) ??
    /^O modelo deste agente é da (.+), mas a chave escolhida é da (.+)$/.exec(error);
  if (wrong) {
    return {
      errorCode: "run.credential_wrong_provider",
      errorParams: { modelProvider: providerNow(wrong[1] as string), keyProvider: providerNow(wrong[2] as string) },
    };
  }
  const unregistered = /^No provider registered for (.+)$/.exec(error);
  if (unregistered)
    return { errorCode: "run.provider_unavailable", errorParams: { detail: unregistered[1] as string } };
  const unlisted = /^OpenRouter doesn't list (.+) anymore\./.exec(error);
  if (unlisted) return { errorCode: "run.model_unlisted", errorParams: { model: unlisted[1] as string } };
  return { errorCode: "run.failed", errorParams: { detail: error.slice(0, 300) } };
}

export const isTerminal = (status: RunStatus) => RUN_TRANSITIONS[status].length === 0;
export const canTransition = (from: RunStatus, to: RunStatus) => RUN_TRANSITIONS[from].includes(to);

export class InvalidRunTransitionError extends Error {
  constructor(from: RunStatus, to: RunStatus) {
    super(`agent run can't go from ${from} to ${to}`);
    this.name = "InvalidRunTransitionError";
  }
}

/**
 * Compare-and-set transition: succeeds only if the run is still in `from`.
 * Returns the updated run, or null when another worker moved it first.
 */
export async function transitionRun(
  db: Executor,
  runId: string,
  from: RunStatus,
  to: RunStatus,
  patch: {
    error?: string | null;
    replyMessageId?: string;
    /** A plain object, or `storedTranscript` (keeps what the bridge left on the row). */
    transcript?: Record<string, unknown> | SQL;
    /** Waiting for this computer to come back (ADR 0032 §5); cleared by any move out of `waiting_input`. */
    waitingMachineId?: string | null;
    /** A failure: the brain's code and the provider's cause (`run.finished`; not stored on the run). */
    failure?: { code: string; cause?: string | null };
  } = {},
): Promise<AgentRun | null> {
  if (!canTransition(from, to)) throw new InvalidRunTransitionError(from, to);
  const { failure, ...set } = patch;
  const now = new Date();
  const [row] = await db
    .update(agentRuns)
    .set({
      status: to,
      updatedAt: now,
      ...(to === "running"
        ? { startedAt: sql`coalesce(${agentRuns.startedAt}, ${now.toISOString()}::timestamptz)`, heartbeatAt: now }
        : {}),
      ...(isTerminal(to) ? { finishedAt: now } : {}),
      // Only a run waiting for its computer keeps the machine it waits for.
      ...(to === "waiting_input" ? {} : { waitingMachineId: null }),
      ...set,
    })
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.status, from)))
    .returning();
  if (row && isTerminal(to)) {
    await recordRunFinished(
      db,
      row,
      to === "failed"
        ? { code: failure?.code ?? runErrorDetail(row.error)?.errorCode ?? null, cause: failure?.cause ?? null }
        : undefined,
    );
    await releaseProfileTurns(db, row.id);
  }
  return row ?? null;
}

/** A run's browser profile turns end with it (done, failed or canceled; ADR 0110 §4). */
export async function releaseProfileTurns(db: Executor, runId: string) {
  await db
    .update(schema.browserProfiles)
    .set({ heldByRunId: null, heldByAgentId: null, heldUntil: null, heldSince: null })
    .where(eq(schema.browserProfiles.heldByRunId, runId));
}

export type StepKind = (typeof schema.agentRunStepKindEnum.enumValues)[number];

/** Appends a step to a run's trail (numbered in order). */
export async function addRunStep(
  db: Executor,
  run: Pick<AgentRun, "id" | "orgId">,
  kind: StepKind,
  data: Record<string, unknown>,
) {
  await db.insert(agentRunSteps).values({
    orgId: run.orgId,
    runId: run.id,
    kind,
    data: pgSafeJson(data),
    seq: sql`(select coalesce(max(${agentRunSteps.seq}), 0) + 1 from ${agentRunSteps} where ${agentRunSteps.runId} = ${run.id})`,
  });
}
