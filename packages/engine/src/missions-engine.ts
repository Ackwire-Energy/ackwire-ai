import type { PubSub } from "@agenteschat/adapters";
import { and, desc, type Executor, eq, inArray, rowsOf, schema, sql } from "@agenteschat/db";
import type { BrainKind, BrainSession, BrainTurn, ToolResult } from "./brains/types";
import { abortLocalRun, RUN_CANCEL_TOPIC } from "./cancel";
import { publishChannelEvent, publishMessageCreated } from "./events";
import type { RunIdentity } from "./executor";
import { insertMessage, messageView } from "./messages";
import { enqueueRunJob } from "./mission-runs";
import {
  agentAnswers,
  getMissionRow,
  isLiveTask,
  MISSION_LIMITS,
  MISSION_STUCK,
  type MissionDeps,
  type MissionRow,
  missionOfThread,
  noMentions,
  OPEN_MISSION_STATUSES,
  pauseStuck,
  queueForSession,
  reactivateMission,
  recordMissionEvent,
  sessionTask,
  type WakeKind,
} from "./missions";
import { resumeRunWithResult } from "./run-resume";
import { revokeRunToolTokens } from "./run-tool-tokens";
import { isTerminal, type RunStatus, transitionRun } from "./runs";

const { missions, machineTasks, missionEvents, agentRuns, approvals, agentQuestions, outbox } = schema;

/**
 * Missions on the agent engine (ADR 0032 §6, block 4).
 *
 * A mission's main session is the agent's run in the mission's home thread
 * with the mission's brain: `model` (the API, what "executor agent" was),
 * `claude_code` or `codex` (a session on the mission's computer, resumed by
 * `missions.main_session_id`). Everything that used to resume the executor's
 * main session — a person's word, Start, accepted suggestions, decisions,
 * reviews, approval outcomes, an item's end, the inbox — is a notice in the
 * thread (`meta.missionInbox` / `meta.machineTask`) that starts a run of the
 * engine (`MissionEngine.startRun`), joins the run already working there, or
 * resumes a run paused on that very decision (`MissionEngine.resumeRun`).
 * Item work stays machine tasks (their own branch and session), started by the
 * run with the gateway tool `start_task`.
 *
 * Behind `MISSIONS_ON_ENGINE` (config, default off): `deps.missionsOnEngine`.
 * Off, missions.ts keeps the old path (executor tasks + MCP tools).
 */

// ── The engine, as the mission side needs it ─────────────────────────────────

/** The engine's `RunIdentity` (executor.ts). */
export type MissionRunIdentity = RunIdentity;

/** A run of the mission's agent in its home thread, on a notice already in the thread. */
export interface MissionRunStart
  extends Pick<BrainTurn, "orgId" | "agentId" | "channelId" | "trigger" | "model" | "session"> {
  threadRootId: string;
  /** The notice this run answers. One run per (agent, trigger message): starting twice is a no-op. */
  triggerMessageId: string;
  /** Hop of the notice (the mission's own wake-ups are 0, so their runs are hop 1). */
  hop: number;
  brain: BrainKind;
  missionId: string;
  /** The person behind it (audience and acting rights), or null for the mission's own notices. */
  requestedBy: string | null;
  kind: WakeKind;
}

/** A run paused on a mission tool (a blocking `ask_decision`, `request_review`) gets its answer. */
export interface MissionRunResume {
  run: MissionRunIdentity;
  /** The pause the gateway returned for the call: the decision's or review's row id. */
  pause: NonNullable<ToolResult["pause"]>;
  /** What the brain reads as the tool's result ("Decision: … → … (by …)"). */
  result: ToolResult;
  /** Computer brains: the session to resume with the result. */
  session?: BrainSession;
}

/**
 * How missions start, resume and cancel runs of the agent engine
 * (`createMissionEngine`; tests pass fakes). The brain is the one the engine
 * resolves for the run (`missionTurnFor` first).
 */
export interface MissionEngine {
  /**
   * Starts (or joins, when the agent already works in that thread) a run on
   * the notice, inside the caller's transaction (the notice and its run commit
   * together). Null: nothing started (the run for that trigger already exists).
   */
  startRun(tx: Executor, input: MissionRunStart): Promise<{ runId: string; steered: boolean } | null>;
  /** Resumes a paused run with the answer. Null: that run doesn't wait on that pause (the caller starts a turn). */
  resumeRun(input: MissionRunResume): Promise<{ runId: string } | null>;
  /** Cancels the agent's active runs in the thread (stop, close, a new brain before Start). Returns their ids. */
  cancelRuns(input: {
    orgId: string;
    agentId: string;
    channelId: string;
    threadRootId: string;
    actorId: string | null;
    reason: string;
  }): Promise<string[]>;
}

/** Whether this mission side runs on the engine (`MISSIONS_ON_ENGINE`). */
export const missionsOnEngine = (deps: Pick<MissionDeps, "missionsOnEngine">) => deps.missionsOnEngine === true;

export const engineOf = (deps: MissionDeps): MissionEngine => deps.missionEngine ?? createMissionEngine(deps);

// ── Which brain, which session ───────────────────────────────────────────────

const BRAIN_OF_EXECUTOR: Record<string, BrainKind> = { claude: "claude_code", codex: "codex", agent: "model" };
const BRAINS: readonly BrainKind[] = ["model", "claude_code", "codex"];

/** Mission columns block 3a adds (`missions.brain`, `missions.brain_model`): read when present. */
type BrainOverride = { brain?: string | null; brainModel?: string | null };

/**
 * The mission's brain: its own override (`missions.brain`), else its executor
 * (claude → claude_code, codex → codex, agent → model). The model is the
 * mission's (`missions.brain_model`), else the brain's default (undefined).
 */
export function missionBrain(mission: Pick<MissionRow, "executor"> & BrainOverride): {
  brain: BrainKind;
  model?: string;
} {
  const override = mission.brain && (BRAINS as readonly string[]).includes(mission.brain) ? mission.brain : null;
  const brain = (override as BrainKind | null) ?? BRAIN_OF_EXECUTOR[mission.executor] ?? "model";
  return mission.brainModel ? { brain, model: mission.brainModel } : { brain };
}

/** Marks the first engine turn of a session (so later turns resume it). */
const SESSION_EVENT = "engine_session";
/** An open mission moved onto the engine (`migrateMissionToEngine`). */
const MIGRATED_EVENT = "engine_migrated";

/**
 * Whether the session already exists on the machine: an executor task ran it
 * (the old path, or before the switch), or an earlier engine turn started it.
 * `exceptRunId`: the run asking (its own start doesn't count).
 */
export async function sessionStarted(db: Executor, missionId: string, sessionId: string, exceptRunId?: string | null) {
  const rows = rowsOf<{ yes: boolean | string }>(
    await db.execute(sql`select (
        exists (select 1 from ${machineTasks} t where t.mission_id = ${missionId}::uuid and t.session_id = ${sessionId})
        or exists (select 1 from ${missionEvents} e where e.mission_id = ${missionId}::uuid
          and e.kind = ${SESSION_EVENT} and e.data->>'sessionId' = ${sessionId}
          and coalesce(e.data->>'runId', '') <> ${exceptRunId ?? ""})
      ) as yes`),
  );
  const yes = rows[0]?.yes;
  return yes === true || yes === "t";
}

/** The session a computer brain works in: the mission's main session, in its folder, on its computer. */
export async function missionSession(
  db: Executor,
  mission: Pick<MissionRow, "id" | "mainSessionId" | "machineId" | "repoDir">,
  brain: BrainKind,
  options: { fresh?: boolean; exceptRunId?: string | null } = {},
): Promise<BrainSession | undefined> {
  if (brain === "model" || !mission.machineId) return undefined;
  const resume = options.fresh
    ? false
    : await sessionStarted(db, mission.id, mission.mainSessionId, options.exceptRunId);
  return { id: mission.mainSessionId, resume, machineId: mission.machineId, cwd: mission.repoDir };
}

/**
 * The first step of `resolveBrain` (`brainFor(agent, run, mission?)`): a run of
 * the mission's agent in an open mission's home thread thinks with the
 * mission's brain, in its main session. Null: not a mission run (the agent's
 * own brain applies). A person's message in the thread starts its run in the
 * message insert as today; this is how that run gets the mission's brain.
 */
export async function missionTurnFor(
  db: Executor,
  run: { id?: string | null; orgId: string; agentId: string; threadRootId: string },
): Promise<{ missionId: string; brain: BrainKind; model?: string; session?: BrainSession } | null> {
  const mission = await missionOfThread(db, run.orgId, run.threadRootId);
  if (!mission || mission.agentId !== run.agentId || !OPEN_MISSION_STATUSES.includes(mission.status)) return null;
  const choice = missionBrain(mission as MissionRow & BrainOverride);
  const session = await missionSession(db, mission, choice.brain, { exceptRunId: run.id ?? null });
  return { missionId: mission.id, ...choice, ...(session ? { session } : {}) };
}

// ── Telling the main session ─────────────────────────────────────────────────

/** Whether the main session may work now (an active mission, or a proposed one being planned, with a computer). */
const canWork = (mission: Pick<MissionRow, "status" | "machineId">) =>
  Boolean(mission.machineId) &&
  (mission.status === "active" || mission.status === "awaiting_close" || mission.status === "proposed");

export interface TellOptions {
  requestedBy?: string | null;
  from?: string;
  kind?: WakeKind;
  /** The notice's own body and meta (a task's end); default: the text as `meta.missionInbox`. */
  notice?: { body: string; meta: Record<string, unknown> };
  /** The answer to a paused call (a blocking decision or review): resume that run when it waits on it. */
  resume?: NonNullable<ToolResult["pause"]>;
  /** A new main session (planning after a proposal or a new brain): its first turn starts it. */
  freshSession?: boolean;
}

/** The latest run of the agent in the thread that waits for a person (approval or input). */
async function waitingRun(db: Executor, mission: MissionRow) {
  const [row] = await db
    .select({ id: agentRuns.id, status: agentRuns.status })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, mission.orgId),
        eq(agentRuns.agentId, mission.agentId),
        eq(agentRuns.channelId, mission.channelId),
        eq(agentRuns.threadRootId, mission.threadRootId),
        inArray(agentRuns.status, ["waiting_input", "waiting_approval"]),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Tells the mission's main session something, on the engine: a run paused on
 * this very answer resumes; otherwise a notice in the home thread starts a run
 * with the mission's brain (or joins the one working there). Paused, closed,
 * without a computer, or while a pre-switch executor task still holds the
 * session: the text waits in the inbox (delivered by `deliverInboxOnEngine`).
 * The stuck-loop guard counts the mission's own wake-ups for every brain.
 */
export async function tellMainOnEngine(
  deps: MissionDeps,
  mission: MissionRow,
  text: string,
  options: TellOptions = {},
): Promise<{ delivered: boolean; runId?: string; resumed?: boolean }> {
  const body = text.slice(0, MISSION_LIMITS.sendText);
  let fresh = (await getMissionRow(deps.db, mission.id)) ?? mission;
  if (!OPEN_MISSION_STATUSES.includes(fresh.status)) return { delivered: false };
  const kind = options.kind ?? (options.requestedBy ? "person" : "system");
  if (fresh.status === "awaiting_close" && (options.requestedBy || kind === "person")) {
    fresh = await reactivateMission(deps, fresh, "message");
  }
  const entry = { sessionId: fresh.mainSessionId, cwd: fresh.repoDir, text: body, at: new Date().toISOString() };
  if (!canWork(fresh)) {
    await queueForSession(deps.db, fresh, entry);
    return { delivered: false };
  }
  const choice = missionBrain(fresh as MissionRow & BrainOverride);
  // A session an executor task (from before the switch) still runs: one process per session, so it waits.
  if (choice.brain !== "model" && isLiveTask(await sessionTask(deps.db, fresh.id, fresh.mainSessionId))) {
    await queueForSession(deps.db, fresh, entry);
    return { delivered: false };
  }
  const engine = engineOf(deps);
  if (options.resume) {
    const waiting = await waitingRun(deps.db, fresh);
    if (waiting) {
      const session = await missionSession(deps.db, fresh, choice.brain);
      const resumed = await engine.resumeRun({
        run: { orgId: fresh.orgId, agentId: fresh.agentId, runId: waiting.id, machineId: fresh.machineId ?? "" },
        pause: options.resume,
        result: { content: body },
        ...(session ? { session } : {}),
      });
      if (resumed) {
        await recordMissionEvent(deps.db, fresh, "engine_resumed", {
          runId: resumed.runId,
          pause: options.resume,
        });
        return { delivered: true, runId: resumed.runId, resumed: true };
      }
    }
  }
  // The stuck-loop guard: a person's word resets it; other wake-ups count until the plan moves.
  const [counted] = await deps.db
    .update(missions)
    .set({ idleWakeups: kind === "person" ? 0 : sql`${missions.idleWakeups} + 1` })
    .where(eq(missions.id, fresh.id))
    .returning({ idle: missions.idleWakeups });
  if (fresh.status === "active" && (counted?.idle ?? 0) > MISSION_STUCK.idleWakeups) {
    await queueForSession(deps.db, fresh, entry);
    await pauseStuck(deps, fresh, "no_progress");
    return { delivered: false };
  }
  const requester = options.requestedBy ?? fresh.ownerId;
  const answers = requester ? await agentAnswers(deps.db, fresh, requester) : false;
  const from = options.from ?? "the mission";
  const session = await missionSession(deps.db, fresh, choice.brain, { fresh: options.freshSession });
  const out = await deps.db.transaction(async (tx) => {
    const message = await insertMessage(tx, {
      orgId: fresh.orgId,
      channelId: fresh.channelId,
      threadId: fresh.threadRootId,
      author: { type: "agent", agentId: fresh.agentId, runId: null, hop: 0 },
      body: options.notice?.body ?? (noMentions(body).slice(0, 39_000) || "…"),
      meta: options.notice?.meta ?? {
        missionInbox: { missionId: fresh.id, from, text: noMentions(body), requestedBy: requester, kind },
        bodyCode: "mission_inbox",
        bodyParams: { from },
      },
    });
    const started = answers
      ? await engine.startRun(tx, {
          orgId: fresh.orgId,
          agentId: fresh.agentId,
          channelId: fresh.channelId,
          threadRootId: fresh.threadRootId,
          triggerMessageId: message.id,
          hop: message.hop,
          trigger: body,
          brain: choice.brain,
          ...(choice.model ? { model: choice.model } : {}),
          ...(session ? { session } : {}),
          missionId: fresh.id,
          requestedBy: options.requestedBy ?? null,
          kind,
        })
      : null;
    // The session's first turn: later turns resume it.
    if (session && !session.resume && started && !started.steered) {
      await recordMissionEvent(tx, fresh, SESSION_EVENT, { sessionId: session.id, runId: started.runId });
    }
    return { message, started };
  });
  if (deps.pubsub) {
    await publishMessageCreated(deps.pubsub, messageView(out.message));
    if (out.started && !out.started.steered) {
      await publishChannelEvent(deps.pubsub, {
        type: "agent.thinking",
        channelId: fresh.channelId,
        threadId: fresh.threadRootId,
        agentId: fresh.agentId,
        runId: out.started.runId,
      });
    }
  }
  await recordMissionEvent(deps.db, fresh, "agent_woken", {
    kind,
    brain: choice.brain,
    messageId: out.message.id,
    runId: out.started?.runId ?? null,
  });
  const runId = out.started?.runId;
  return { delivered: Boolean(runId), ...(runId ? { runId } : {}) };
}

/**
 * The inbox on the engine: what waits for the main session goes out at once
 * (one notice, one run or join); what waits for item sessions still resumes
 * them as machine tasks (`deliverItemInbox`, the old per-session path).
 */
export async function deliverInboxOnEngine(
  deps: MissionDeps,
  missionId: string,
  deliverItemInbox: (deps: MissionDeps, mission: MissionRow, except: string) => Promise<number>,
) {
  const mission = await getMissionRow(deps.db, missionId);
  if (!mission || mission.inbox.length === 0) return 0;
  let sent = 0;
  const main = mission.inbox.filter((e) => e.sessionId === mission.mainSessionId || mission.executor === "agent");
  const choice = missionBrain(mission as MissionRow & BrainOverride);
  const held = choice.brain !== "model" && isLiveTask(await sessionTask(deps.db, mission.id, mission.mainSessionId));
  if (main.length > 0 && canWork(mission) && !held) {
    const ats = main.map((e) => e.at);
    const all = mission.executor === "agent";
    // Claim these entries first (another delivery may run at the same time).
    const [claimed] = await deps.db
      .update(missions)
      .set({
        inbox: sql`coalesce((select jsonb_agg(x.value) from jsonb_array_elements(${missions.inbox}) x
          where not ((${all}::boolean or x.value->>'sessionId' = ${mission.mainSessionId})
            and x.value->>'at' = any(${`{${ats.join(",")}}`}::text[]))), '[]'::jsonb)`,
      })
      .where(
        and(
          eq(missions.id, mission.id),
          sql`exists (select 1 from jsonb_array_elements(${missions.inbox}) x where x.value->>'at' = ${ats[0] as string})`,
        ),
      )
      .returning({ id: missions.id });
    if (claimed) {
      const text = main.map((e) => e.text).join("\n\n");
      const out = await tellMainOnEngine(deps, mission, text, { from: "the mission", kind: "system" }).catch(
        async () => {
          for (const e of main) await queueForSession(deps.db, mission, e);
          return { delivered: false };
        },
      );
      if (out.delivered) sent++;
    }
  }
  if (mission.executor !== "agent") sent += await deliverItemInbox(deps, mission, mission.mainSessionId);
  return sent;
}

/** Stop, close or a new brain: the main session's runs in the thread are canceled. */
export async function cancelMainRuns(deps: MissionDeps, mission: MissionRow, actorId: string | null, reason: string) {
  const ids = await engineOf(deps).cancelRuns({
    orgId: mission.orgId,
    agentId: mission.agentId,
    channelId: mission.channelId,
    threadRootId: mission.threadRootId,
    actorId,
    reason,
  });
  if (ids.length > 0) await recordMissionEvent(deps.db, mission, "engine_runs_canceled", { runIds: ids, reason });
  return ids;
}

// ── Open missions at switch time ─────────────────────────────────────────────

export interface MissionMigration {
  missionId: string;
  status: "migrated" | "already" | "closed" | "missing";
  brain?: BrainKind;
  /** A pre-switch executor task still runs the main session: the inbox waits for its end. */
  waitingOnTaskId?: string | null;
  /** Item tasks still running (they stay machine tasks; their end reaches the engine run). */
  liveItems?: number;
  /** Texts for the main session that were waiting in the inbox and went out as one engine turn. */
  deliveredInbox?: number;
}

/**
 * Moves one open mission onto the engine (idempotent: a `engine_migrated`
 * event marks it, taken under the mission's row lock):
 *
 * - its `main_session_id` stays: the brain resumes that session (executor tasks
 *   ran it, so `sessionStarted` is already true); agent mode is already runs;
 * - a main-session task still running finishes as it is; texts for the main
 *   session wait in the inbox until it ends (`onMissionTaskEnded` →
 *   `deliverInbox`, now on the engine);
 * - otherwise what waits in the inbox for the main session goes out now, as
 *   one engine turn; item sessions keep their inbox (they stay machine tasks);
 * - pending decisions, reviews and approvals need nothing: their answer goes
 *   through `tellSession`, which resumes a paused run or starts a turn.
 */
export async function migrateMissionToEngine(
  deps: MissionDeps,
  missionId: string,
  deliverItemInbox: (deps: MissionDeps, mission: MissionRow, except: string) => Promise<number>,
): Promise<MissionMigration> {
  const marked = await deps.db.transaction(async (tx) => {
    const [row] = await tx.select().from(missions).where(eq(missions.id, missionId)).for("update");
    if (!row) return { status: "missing" as const };
    if (!OPEN_MISSION_STATUSES.includes(row.status)) return { status: "closed" as const, row };
    const [done] = await tx
      .select({ data: missionEvents.data })
      .from(missionEvents)
      .where(and(eq(missionEvents.missionId, row.id), eq(missionEvents.kind, MIGRATED_EVENT)))
      .limit(1);
    if (done) return { status: "already" as const, row, data: done.data };
    const { brain } = missionBrain(row as MissionRow & BrainOverride);
    const main = await sessionTask(tx, row.id, row.mainSessionId);
    const live = rowsOf<{ n: number | string }>(
      await tx.execute(sql`select count(*) as n from ${machineTasks} t where t.mission_id = ${row.id}::uuid
        and t.session_id is distinct from ${row.mainSessionId}
        and t.status in ('queued', 'running', 'interrupted') and t.ended_at is null`),
    );
    const data = {
      brain,
      sessionId: row.mainSessionId,
      waitingOnTaskId: isLiveTask(main) ? (main?.id ?? null) : null,
      liveItems: Number(live[0]?.n ?? 0),
      inbox: row.inbox.length,
    };
    await recordMissionEvent(tx, row, MIGRATED_EVENT, data);
    return { status: "migrated" as const, row, data };
  });
  if (marked.status === "missing") return { missionId, status: "missing" };
  if (marked.status === "closed") return { missionId, status: "closed" };
  const data = marked.data as { brain?: BrainKind; waitingOnTaskId?: string | null; liveItems?: number };
  if (marked.status === "already") {
    return { missionId, status: "already", ...(data.brain ? { brain: data.brain } : {}) };
  }
  let deliveredInbox = 0;
  if (!data.waitingOnTaskId && marked.row.inbox.length > 0) {
    const before = marked.row.inbox.filter(
      (e) => e.sessionId === marked.row.mainSessionId || marked.row.executor === "agent",
    ).length;
    const engineDeps = { ...deps, missionsOnEngine: true };
    await deliverInboxOnEngine(engineDeps, missionId, deliverItemInbox).catch(() => 0);
    const after = (await getMissionRow(deps.db, missionId))?.inbox ?? [];
    const left = after.filter((e) => e.sessionId === marked.row.mainSessionId || marked.row.executor === "agent");
    deliveredInbox = Math.max(0, before - left.length);
  }
  return {
    missionId,
    status: "migrated",
    ...(data.brain ? { brain: data.brain } : {}),
    waitingOnTaskId: data.waitingOnTaskId ?? null,
    liveItems: data.liveItems ?? 0,
    deliveredInbox,
  };
}

/** Every open mission, all orgs (run once when `MISSIONS_ON_ENGINE` is turned on; safe to run again). */
export async function migrateOpenMissions(
  deps: MissionDeps,
  deliverItemInbox: (deps: MissionDeps, mission: MissionRow, except: string) => Promise<number>,
) {
  const rows = await deps.db
    .select({ id: missions.id })
    .from(missions)
    .where(inArray(missions.status, OPEN_MISSION_STATUSES));
  const out: MissionMigration[] = [];
  for (const r of rows) {
    out.push(
      await migrateMissionToEngine(deps, r.id, deliverItemInbox).catch(
        (): MissionMigration => ({ missionId: r.id, status: "missing" }),
      ),
    );
  }
  return out;
}

// ── The engine missions use ──────────────────────────────────────────────────

/**
 * `MissionEngine` on the agent engine (ADR 0032): a start is a run row and its
 * `agent_run.execute` job in the caller's transaction (`enqueueRunJob`; one
 * run per agent and trigger message: a second start for the same notice is a
 * no-op), or the notice joins the run already working in the thread. The
 * engine resolves the mission's brain and session when the run executes
 * (`resolveBrain` → `missionTurnFor`). A resume answers the run's waiting
 * call (`resumeRunWithResult`, pause id = the decision's or review's id);
 * cancel stops the agent's runs in the thread and revokes their tool tokens.
 */
export function createMissionEngine(deps: { pubsub?: PubSub; db: MissionDeps["db"] }): MissionEngine {
  return {
    async startRun(tx, input) {
      const [existing] = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.orgId, input.orgId),
            eq(agentRuns.agentId, input.agentId),
            eq(agentRuns.triggerMessageId, input.triggerMessageId),
          ),
        )
        .limit(1);
      if (existing) return null;
      const out = await enqueueRunJob(
        tx,
        {
          id: input.triggerMessageId,
          orgId: input.orgId,
          channelId: input.channelId,
          threadId: input.threadRootId,
          hop: input.hop,
        },
        input.agentId,
      );
      if (out.run) return { runId: out.run.id, steered: false };
      if (out.steered) return { runId: out.steered, steered: true };
      return null;
    },
    async resumeRun(input) {
      return resumeRunWithResult(deps.db, { runId: input.run.runId, waitId: input.pause.id, result: input.result });
    },
    async cancelRuns(input) {
      const ids = await cancelThreadRuns(deps, input);
      for (const runId of ids) await revokeRunToolTokens(deps.db, { runId }).catch(() => undefined);
      return ids;
    },
  };
}

/** Cancels the agent's active runs in a thread, for the mission (not a person's own stop: no permission check here). */
async function cancelThreadRuns(
  deps: { pubsub?: PubSub; db: MissionDeps["db"] },
  input: { orgId: string; agentId: string; channelId: string; threadRootId: string; actorId: string | null },
) {
  const active = await deps.db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.orgId, input.orgId),
        eq(agentRuns.agentId, input.agentId),
        eq(agentRuns.channelId, input.channelId),
        eq(agentRuns.threadRootId, input.threadRootId),
        inArray(agentRuns.status, ["queued", "running", "waiting_approval", "waiting_input"]),
      ),
    );
  const ids: string[] = [];
  for (const run of active) {
    const from: RunStatus = run.status;
    if (isTerminal(from)) continue;
    const moved = await deps.db.transaction(async (tx) => {
      const row = await transitionRun(tx, run.id, from, "canceled", {
        error: `canceled_by:${input.actorId ?? "mission"}`,
      });
      if (!row) return null;
      const now = new Date();
      await tx
        .update(approvals)
        .set({ status: "canceled", decidedAt: now })
        .where(and(eq(approvals.runId, run.id), eq(approvals.status, "pending")));
      await tx
        .update(agentQuestions)
        .set({ status: "canceled" })
        .where(and(eq(agentQuestions.runId, run.id), eq(agentQuestions.status, "open")));
      await tx
        .delete(outbox)
        .where(
          and(
            eq(outbox.kind, "agent_run.execute"),
            eq(outbox.status, "pending"),
            sql`${outbox.payload}->>'runId' = ${run.id}`,
          ),
        );
      return row;
    });
    if (!moved) continue;
    ids.push(run.id);
    abortLocalRun(run.id);
    if (deps.pubsub) await deps.pubsub.publish(RUN_CANCEL_TOPIC, { type: "run.cancel", runId: run.id }).catch(() => {});
    const where = { channelId: run.channelId, threadId: run.threadRootId, agentId: run.agentId, runId: run.id };
    await publishChannelEvent(deps.pubsub, { type: "agent.run", ...where, status: "canceled" });
    if (from !== "running") {
      await publishChannelEvent(deps.pubsub, { type: "agent.idle", ...where });
      await publishChannelEvent(deps.pubsub, { type: "run.finished", ...where, status: "canceled" });
    }
  }
  return ids;
}
