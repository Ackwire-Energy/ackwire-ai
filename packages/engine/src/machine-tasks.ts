import {
  type MachineReplies,
  type MachineRequest,
  type PubSub,
  type RunnerFrame,
  type RunnerTask,
  TASK_LIMITS,
  TASKS_PROTOCOL,
  type TaskExecutor,
} from "@agenteschat/adapters";
import { and, type Database, desc, type Executor, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { getChannelCached } from "./context";
import { createAgentRuns, eligibleChannelAgents, requesterOf } from "./dispatch";
import { publishChannelEvent, publishMessageCreated } from "./events";
import { getMachineById, machineOnline } from "./machines";
import { getMessage, insertMessage, type Message, messageView } from "./messages";
import { enqueue } from "./outbox";
import type { ToolContext } from "./tools/types";

const { machineTasks, agentRuns } = schema;

/**
 * Background tasks on connected machines, server side (ADR 0029 sections 4
 * and 5). The runner runs them detached and reports `task.event` and
 * `task.done`; the replica holding the machine's socket persists both
 * (`machine-hub.ts`). A task's end wakes its conversation through the
 * outbox (`machine.task_done`): a short notice in the thread, then a run of
 * the agent that started it, which tells the people. A machine that goes
 * away interrupts its tasks after a grace; when it comes back its journal is
 * reconciled and Claude Code tasks resume their session by themselves.
 */
export type MachineTaskRow = typeof machineTasks.$inferSelect;
export type MachineTaskStatus = MachineTaskRow["status"];

/** Running tasks of a machine that went offline become `interrupted` after this (it may just be a network blip). */
export const TASK_OFFLINE_GRACE_MS = 60_000;
/** An interrupted task resumes at most this many times in a row. */
export const MAX_TASK_RESUMES = 3;
/** What a resumed Claude Code session is told. */
export const RESUME_PROMPT =
  "You were interrupted (the computer went offline). Check git status in your folder and continue where you stopped.";
export const TASK_TEXT_LIMITS = { title: 120, command: 2000, prompt: 20_000, wakeResult: 4000 } as const;

const ACTIVE: MachineTaskStatus[] = ["queued", "running", "interrupted"];

/** A task as the app and the agent's tools see it. */
export interface MachineTaskView {
  id: string;
  agentId: string;
  machineId: string;
  channelId: string;
  threadId: string | null;
  title: string;
  executor: string;
  status: MachineTaskStatus;
  exitCode: number | null;
  seconds: number | null;
  lastLine: string | null;
  files: string[];
  branch: string | null;
  cwd: string | null;
  resumedFromId: string | null;
  resumedTaskId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  lastEventAt: string | null;
  createdAt: string;
}

export function machineTaskView(row: MachineTaskRow): MachineTaskView {
  return {
    id: row.id,
    agentId: row.agentId,
    machineId: row.machineId,
    channelId: row.channelId,
    threadId: row.threadRootId,
    title: row.title,
    executor: row.executor,
    status: row.status,
    exitCode: row.exitCode,
    seconds: row.seconds,
    lastLine: row.lastLine,
    files: Array.isArray(row.files) ? row.files : [],
    branch: row.branch,
    cwd: row.cwd,
    resumedFromId: row.resumedFromId,
    resumedTaskId: row.resumedTaskId,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `machine.task` to the task's conversation (ADR 0010). */
export async function publishTaskEvent(pubsub: PubSub | undefined, row: MachineTaskRow) {
  await publishChannelEvent(pubsub, {
    type: "machine.task",
    channelId: row.channelId,
    threadId: row.threadRootId,
    task: machineTaskView(row),
  });
}

/** Elapsed seconds now, or at the end. */
export function taskSeconds(row: Pick<MachineTaskRow, "seconds" | "startedAt" | "endedAt">, now = Date.now()) {
  if (row.seconds !== null && row.endedAt) return row.seconds;
  if (!row.startedAt) return row.seconds ?? 0;
  return Math.max(row.seconds ?? 0, Math.round(((row.endedAt?.getTime() ?? now) - row.startedAt.getTime()) / 1000));
}

/** `3 min`, `1 h 05 min`, `40 s`. */
export function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** Titles go into the thread as plain text: no mentions. */
const plainTitle = (title: string) =>
  title
    .replace(/[\p{Cc}]/gu, " ")
    .replace(/@/g, "")
    .trim()
    .slice(0, TASK_TEXT_LIMITS.title) || "Task";

/** How the server reaches the runner: the hub's `call` (any replica), or a local socket's. */
export type TaskCall = <Op extends "task.start" | "task.status" | "task.cancel">(
  machineId: string,
  request: Extract<MachineRequest, { op: Op }>,
) => Promise<MachineReplies[Op]>;

export interface TaskDeps {
  db: Database;
  pubsub?: PubSub;
}

export interface StartTaskInput {
  orgId: string;
  agent: { id: string; handle: string };
  machineId: string;
  /** The runner's protocol (from the machine's last hello): older than 4 can't run tasks. */
  protocol: number;
  machineName: string;
  channelId: string;
  threadRootId: string | null;
  runId: string | null;
  requestedByUserId: string | null;
  title: string;
  executor: TaskExecutor;
  command?: string;
  prompt?: string;
  sessionId?: string | null;
  branch?: string | null;
  maxSeconds?: number;
  resumedFromId?: string | null;
  resumeCount?: number;
  /** `claude`: resume the session (a hint; the runner checks its disk). */
  resume?: boolean;
}

/** A runner older than protocol 4 can't run background tasks: the person has to update it. */
export class RunnerOutdatedError extends Error {
  constructor(readonly machineName: string) {
    super(
      `The runner on the computer ${machineName} is too old for background tasks. Tell the person: its owner should update it with \`agentes-runner update\` (until then use run_code).`,
    );
    this.name = "RunnerOutdatedError";
  }
}

/**
 * Records a task and asks the machine to start it. On failure the row is
 * kept as `failed` with the reason, and the error goes up.
 */
export async function startMachineTask(deps: TaskDeps & { call: TaskCall }, input: StartTaskInput) {
  if (input.protocol < TASKS_PROTOCOL) throw new RunnerOutdatedError(input.machineName);
  const now = new Date();
  const [row] = await deps.db
    .insert(machineTasks)
    .values({
      orgId: input.orgId,
      agentId: input.agent.id,
      machineId: input.machineId,
      channelId: input.channelId,
      threadRootId: input.threadRootId,
      runId: input.runId,
      requestedByUserId: input.requestedByUserId,
      title: plainTitle(input.title),
      executor: input.executor,
      command: (input.command ?? "").slice(0, TASK_TEXT_LIMITS.command),
      prompt: input.prompt ? input.prompt.slice(0, TASK_TEXT_LIMITS.prompt) : null,
      sessionId: input.sessionId ?? null,
      branch: input.branch ?? null,
      resumedFromId: input.resumedFromId ?? null,
      resumeCount: input.resumeCount ?? 0,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("machine_tasks insert returned nothing");
  try {
    const started = await deps.call<"task.start">(input.machineId, {
      agent: input.agent,
      op: "task.start",
      taskId: row.id,
      executor: input.executor,
      ...(input.command ? { command: input.command } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.sessionId ? { session: input.sessionId } : {}),
      ...(input.resume ? { resume: true } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.maxSeconds ? { maxSeconds: input.maxSeconds } : {}),
    });
    const at = new Date(started.startedAt);
    const [running] = await deps.db
      .update(machineTasks)
      .set({
        status: "running",
        command: String(started.command ?? row.command).slice(0, TASK_TEXT_LIMITS.command),
        cwd: started.cwd ?? null,
        branch: started.branch ?? row.branch,
        startedAt: Number.isNaN(at.getTime()) ? new Date() : at,
        lastEventAt: new Date(),
        updatedAt: new Date(),
      })
      // A fast task may already have reported its end.
      .where(and(eq(machineTasks.id, row.id), eq(machineTasks.status, "queued")))
      .returning();
    const fresh = running ?? (await getTask(deps.db, row.id)) ?? row;
    await publishTaskEvent(deps.pubsub, fresh);
    return fresh;
  } catch (error) {
    await deps.db
      .update(machineTasks)
      .set({
        status: "failed",
        endedAt: new Date(),
        lastLine: (error instanceof Error ? error.message : String(error)).slice(0, TASK_LIMITS.line),
        updatedAt: new Date(),
      })
      .where(and(eq(machineTasks.id, row.id), eq(machineTasks.status, "queued")));
    throw error;
  }
}

export async function getTask(db: Executor, taskId: string): Promise<MachineTaskRow | null> {
  const [row] = await db.select().from(machineTasks).where(eq(machineTasks.id, taskId));
  return row ?? null;
}

/** An agent's own task (tools never reach another agent's). */
export async function getAgentTask(db: Executor, orgId: string, agentId: string, taskId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) return null;
  const [row] = await db
    .select()
    .from(machineTasks)
    .where(and(eq(machineTasks.orgId, orgId), eq(machineTasks.agentId, agentId), eq(machineTasks.id, taskId)));
  return row ?? null;
}

/** The agent's recent tasks, running ones first. */
export async function listAgentTasks(db: Executor, orgId: string, agentId: string, limit = 20) {
  return db
    .select()
    .from(machineTasks)
    .where(and(eq(machineTasks.orgId, orgId), eq(machineTasks.agentId, agentId)))
    .orderBy(
      sql`case when ${machineTasks.status} in ('queued', 'running') then 0 else 1 end`,
      desc(machineTasks.createdAt),
    )
    .limit(limit);
}

/** A thread's tasks (the app's live card, the agent's context). */
export async function listThreadTasks(db: Executor, orgId: string, channelId: string, threadRootId: string | null) {
  return db
    .select()
    .from(machineTasks)
    .where(
      and(
        eq(machineTasks.orgId, orgId),
        eq(machineTasks.channelId, channelId),
        threadRootId ? eq(machineTasks.threadRootId, threadRootId) : isNull(machineTasks.threadRootId),
      ),
    )
    .orderBy(desc(machineTasks.createdAt))
    .limit(50);
}

/** `task.event`: the last line, files and elapsed time; an event proves the task runs. */
export async function applyTaskEvent(
  deps: TaskDeps,
  machineId: string,
  frame: Extract<RunnerFrame, { type: "task.event" }>,
) {
  const now = new Date();
  const [row] = await deps.db
    .update(machineTasks)
    .set({
      status: "running",
      ...(frame.line !== undefined ? { lastLine: frame.line } : {}),
      ...(frame.files ? { files: frame.files.slice(0, TASK_LIMITS.files) } : {}),
      ...(frame.seconds !== undefined ? { seconds: Math.round(frame.seconds) } : {}),
      lastEventAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(machineTasks.id, frame.taskId),
        eq(machineTasks.machineId, machineId),
        inArray(machineTasks.status, ["running", "interrupted"]),
        isNull(machineTasks.endedAt),
      ),
    )
    .returning();
  if (row) await publishTaskEvent(deps.pubsub, row);
  return row ?? null;
}

const statusOfDone = (frame: Extract<RunnerFrame, { type: "task.done" }>): MachineTaskStatus =>
  frame.canceled ? "canceled" : frame.exitCode === 0 ? "done" : "failed";

/**
 * `task.done` (not interrupted): the row ends, and the conversation is woken
 * in the same transaction (outbox), unless the agent canceled it itself.
 * Idempotent: a re-sent frame finds the row already ended.
 */
export async function applyTaskDone(
  deps: TaskDeps,
  machineId: string,
  frame: Extract<RunnerFrame, { type: "task.done" }>,
) {
  const now = new Date();
  const row = await deps.db.transaction(async (tx) => {
    const [ended] = await tx
      .update(machineTasks)
      .set({
        status: statusOfDone(frame),
        exitCode: frame.exitCode,
        signal: frame.signal ?? null,
        seconds: frame.seconds,
        ...(frame.lastLine !== undefined ? { lastLine: frame.lastLine } : {}),
        ...(frame.files ? { files: frame.files.slice(0, TASK_LIMITS.files) } : {}),
        result: frame.result ? frame.result.slice(0, TASK_LIMITS.result) : null,
        ...(frame.session ? { sessionId: frame.session } : {}),
        endedAt: now,
        lastEventAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(machineTasks.id, frame.taskId),
          eq(machineTasks.machineId, machineId),
          inArray(machineTasks.status, ACTIVE),
          isNull(machineTasks.endedAt),
        ),
      )
      .returning();
    if (!ended) return null;
    if (!ended.canceledBy?.startsWith("agent:")) await enqueueWake(tx, ended);
    return ended;
  });
  if (row) await publishTaskEvent(deps.pubsub, row);
  return row;
}

const enqueueWake = (tx: Executor, row: Pick<MachineTaskRow, "id" | "orgId">) =>
  enqueue(tx, {
    orgId: row.orgId,
    kind: "machine.task_done",
    payload: { taskId: row.id },
    dedupeKey: `machine.task_done:${row.id}`,
    maxAttempts: 6,
  });

/** Starts a task on the machine whose socket is here (resume after an interruption). */
export type LocalTaskStarter = (input: StartTaskInput) => Promise<MachineTaskRow>;

/**
 * A task whose process went away without an exit (from `task.done
 * { interrupted }`, or missing from the journal on reconnect): final as
 * `interrupted`. Claude Code with a session resumes by itself (the machine's
 * `resume_tasks`, at most `MAX_TASK_RESUMES` in a row) and the thread hears
 * "resumed"; anything else wakes the agent to tell the people.
 */
export async function settleInterruptedTask(
  deps: TaskDeps & { start?: LocalTaskStarter },
  row: MachineTaskRow,
  frame?: Extract<RunnerFrame, { type: "task.done" }>,
) {
  const now = new Date();
  const [claimed] = await deps.db
    .update(machineTasks)
    .set({
      status: "interrupted",
      ...(frame ? { seconds: frame.seconds, ...(frame.lastLine ? { lastLine: frame.lastLine } : {}) } : {}),
      ...(frame?.files ? { files: frame.files } : {}),
      ...(frame?.result ? { result: frame.result.slice(0, TASK_LIMITS.result) } : {}),
      ...(frame?.session ? { sessionId: frame.session } : {}),
      endedAt: now,
      updatedAt: now,
    })
    .where(and(eq(machineTasks.id, row.id), isNull(machineTasks.endedAt), inArray(machineTasks.status, ACTIVE)))
    .returning();
  if (!claimed) return null;
  const machine = await getMachineById(deps.db, claimed.machineId);
  const resumable =
    claimed.executor === "claude" &&
    Boolean(claimed.sessionId) &&
    machine?.resumeTasks !== false &&
    claimed.resumeCount < MAX_TASK_RESUMES &&
    Boolean(deps.start) &&
    !claimed.canceledBy;
  if (resumable && deps.start && machine) {
    const handle = (await deps.db
      .select({ handle: schema.agents.handle })
      .from(schema.agents)
      .where(eq(schema.agents.id, claimed.agentId))
      .then((r) => r[0]?.handle)) as string | undefined;
    try {
      const next = await deps.start({
        orgId: claimed.orgId,
        agent: { id: claimed.agentId, handle: handle ?? "agent" },
        machineId: claimed.machineId,
        protocol: machine.protocol,
        machineName: machine.name,
        channelId: claimed.channelId,
        threadRootId: claimed.threadRootId,
        runId: null,
        requestedByUserId: claimed.requestedByUserId,
        title: claimed.title,
        executor: "claude",
        prompt: RESUME_PROMPT,
        sessionId: claimed.sessionId,
        resume: true,
        resumedFromId: claimed.id,
        resumeCount: claimed.resumeCount + 1,
      });
      const [linked] = await deps.db
        .update(machineTasks)
        .set({ resumedTaskId: next.id, updatedAt: new Date() })
        .where(eq(machineTasks.id, claimed.id))
        .returning();
      await recordAudit(deps.db, {
        orgId: claimed.orgId,
        actor: { type: "system", id: null },
        action: "machine.task_started",
        target: { type: "machine", id: claimed.machineId },
        details: { taskId: next.id, resumedFromId: claimed.id, executor: "claude", title: claimed.title },
      }).catch(() => undefined);
      await postTaskNotice(deps, claimed, {
        body: `The computer ${machine.name} is back: resumed "${claimed.title}" where it stopped.`,
        code: "machine_task_resumed",
        params: { title: claimed.title, computer: machine.name },
        meta: { machineTaskResumed: { fromId: claimed.id, taskId: next.id } },
      });
      await publishTaskEvent(deps.pubsub, linked ?? claimed);
      return claimed;
    } catch {
      // Couldn't resume (no slot, runner refused): the agent hears it was interrupted.
    }
  }
  await enqueueWake(deps.db, claimed);
  await publishTaskEvent(deps.pubsub, claimed);
  return claimed;
}

/**
 * A line the server writes in the task's thread, as the task's agent (no
 * run, no routing): offline, resumed. English text plus a code the app
 * shows in the person's language.
 */
export async function postTaskNotice(
  deps: TaskDeps,
  row: Pick<MachineTaskRow, "orgId" | "agentId" | "channelId" | "threadRootId">,
  notice: { body: string; code: string; params: Record<string, string>; meta?: Record<string, unknown> },
  tx?: Executor,
): Promise<Message> {
  const message = await insertMessage(tx ?? deps.db, {
    orgId: row.orgId,
    channelId: row.channelId,
    threadId: row.threadRootId,
    author: { type: "agent", agentId: row.agentId, runId: null, hop: 0 },
    body: notice.body,
    meta: { ...(notice.meta ?? {}), bodyCode: notice.code, bodyParams: notice.params },
  });
  if (!tx && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
  return message;
}

/**
 * `machine.tasks_offline` (enqueued when a machine's socket closes, due after
 * the grace): still offline, its running tasks become `interrupted` (not
 * final: the machine may come back) and each affected thread gets ONE notice.
 */
export async function interruptOfflineMachineTasks(deps: TaskDeps, machineId: string) {
  const machine = await getMachineById(deps.db, machineId);
  if (!machine || machineOnline(machine)) return [];
  const rows = await deps.db
    .update(machineTasks)
    .set({ status: "interrupted", updatedAt: new Date() })
    .where(and(eq(machineTasks.machineId, machineId), eq(machineTasks.status, "running"), isNull(machineTasks.endedAt)))
    .returning();
  const threads = new Map<string, MachineTaskRow[]>();
  for (const row of rows) {
    const key = `${row.channelId}:${row.threadRootId ?? ""}`;
    threads.set(key, [...(threads.get(key) ?? []), row]);
  }
  const since = (machine.lastSeenAt ?? new Date()).toISOString();
  for (const list of threads.values()) {
    const first = list[0] as MachineTaskRow;
    const n = list.length;
    await postTaskNotice(deps, first, {
      body: `The computer ${machine.name} went offline (since ${since.slice(11, 16)} UTC): ${
        n === 1 ? `"${first.title}" is paused` : `${n} tasks here are paused`
      } until it's back.`,
      code: "machine_offline",
      params: { computer: machine.name, since, count: String(n), title: first.title },
      meta: { machineOffline: { machineId, taskIds: list.map((r) => r.id) } },
    }).catch(() => undefined);
    for (const row of list) await publishTaskEvent(deps.pubsub, row);
  }
  return rows;
}

/**
 * On `hello` from a runner with tasks: what the server thinks runs is
 * checked against the runner's journal. Running there: running here (an
 * offline grace may have said interrupted). Ended there: its `task.done`
 * follows. Not there at all: interrupted (and resumed when it can be).
 */
export async function reconcileMachineTasks(
  deps: TaskDeps & { start?: LocalTaskStarter },
  machineId: string,
  reported: RunnerTask[],
) {
  const rows = await deps.db
    .select()
    .from(machineTasks)
    .where(
      and(eq(machineTasks.machineId, machineId), inArray(machineTasks.status, ACTIVE), isNull(machineTasks.endedAt)),
    );
  const byId = new Map(reported.map((t) => [t.taskId, t]));
  for (const row of rows) {
    const there = byId.get(row.id);
    if (there?.status === "running") {
      if (row.status !== "running") {
        const [back] = await deps.db
          .update(machineTasks)
          .set({ status: "running", lastEventAt: new Date(), updatedAt: new Date() })
          .where(and(eq(machineTasks.id, row.id), isNull(machineTasks.endedAt)))
          .returning();
        if (back) await publishTaskEvent(deps.pubsub, back);
      }
      continue;
    }
    if (there) continue;
    // Being started right now (its `task.start` may still be on the way).
    if (row.status === "queued" && Date.now() - row.createdAt.getTime() < 2 * 60_000) continue;
    await settleInterruptedTask(deps, row);
  }
}

/** The text of a task's end, for the thread (English; the app uses the code). */
function endText(row: MachineTaskRow, computer: string) {
  const took = formatDuration(taskSeconds(row));
  switch (row.status) {
    case "done":
      return `Task "${row.title}" finished on ${computer} after ${took}.`;
    case "canceled":
      return `Task "${row.title}" was canceled on ${computer} after ${took}.`;
    case "interrupted":
      return `Task "${row.title}" was interrupted on ${computer} after ${took} (the computer went away) and couldn't resume by itself.`;
    default:
      return `Task "${row.title}" failed on ${computer} after ${took} (exit code ${row.exitCode ?? "none"}).`;
  }
}

/**
 * `machine.task_done`: wakes the conversation once per task. A notice in the
 * task's thread (as its agent) carries the result for the model
 * (`meta.machineTask`), and a run of that agent starts on it, unless the hop
 * limit or the agent's audience (D31) says no, or the agent left the
 * channel. A run of that agent already active in the thread gets it as a
 * new message instead (one run per agent and conversation).
 */
export async function wakeConversationForTask(deps: TaskDeps, taskId: string, options: { maxHops: number }) {
  const row = await getTask(deps.db, taskId);
  if (!row || row.wokeAt || !row.endedAt) return null;
  const machine = await getMachineById(deps.db, row.machineId);
  const computer = machine?.name ?? "the computer";
  const [origin] = row.runId
    ? await deps.db.select({ hop: agentRuns.hop }).from(agentRuns).where(eq(agentRuns.id, row.runId))
    : [];
  const hop = origin?.hop ?? 1;
  const files = Array.isArray(row.files) ? row.files : [];
  const eligible = await eligibleChannelAgents(
    deps.db,
    row.orgId,
    row.channelId,
    [row.agentId],
    row.requestedByUserId ? { requesterUserId: row.requestedByUserId } : {},
  );
  const result = await deps.db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(machineTasks)
      .set({ wokeAt: new Date() })
      .where(and(eq(machineTasks.id, row.id), isNull(machineTasks.wokeAt)))
      .returning({ id: machineTasks.id });
    if (!claimed) return null;
    const message = await insertMessage(tx, {
      orgId: row.orgId,
      channelId: row.channelId,
      threadId: row.threadRootId,
      author: { type: "agent", agentId: row.agentId, runId: null, hop },
      body: endText(row, computer),
      meta: {
        machineTask: {
          id: row.id,
          title: row.title,
          status: row.status,
          exitCode: row.exitCode,
          seconds: taskSeconds(row),
          computer,
          executor: row.executor,
          ...(row.branch ? { branch: row.branch } : {}),
          ...(row.lastLine ? { lastLine: row.lastLine } : {}),
          ...(files.length ? { files: files.slice(0, 20) } : {}),
          ...(row.result ? { result: row.result.slice(0, TASK_TEXT_LIMITS.wakeResult) } : {}),
        },
        bodyCode: `machine_task_${row.status}`,
        bodyParams: {
          title: row.title,
          computer,
          seconds: String(taskSeconds(row)),
          exitCode: String(row.exitCode ?? ""),
        },
      },
    });
    const runs =
      eligible.length > 0 && message.hop < options.maxHops
        ? await createAgentRuns(tx, message, [row.agentId], "mention")
        : [];
    return { message, runs };
  });
  if (!result) return null;
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(result.message));
  for (const run of result.runs) {
    await publishChannelEvent(deps.pubsub, {
      type: "agent.thinking",
      channelId: row.channelId,
      threadId: run.threadRootId,
      agentId: run.agentId,
      runId: run.id,
    });
  }
  return result;
}

/**
 * Who a task works for: the person behind the run (author of its trigger,
 * up a chain of agents), or, for a run woken by a task, that task's person.
 */
export async function taskRequester(ctx: ToolContext): Promise<string | null> {
  const trigger = await getMessage(ctx.db, ctx.orgId, ctx.triggerMessageId);
  if (!trigger) return null;
  const woke = trigger.meta?.machineTask as { id?: unknown } | undefined;
  if (typeof woke?.id === "string") return (await getTask(ctx.db, woke.id))?.requestedByUserId ?? null;
  return requesterOf(ctx.db, trigger);
}

/** The thread a task started from this run reports to: null for a flat DM (or forum) conversation. */
export async function taskThreadOf(ctx: ToolContext): Promise<string | null> {
  const channel = await getChannelCached(ctx.db, ctx.orgId, ctx.channelId);
  const flat = (channel?.kind === "dm" || channel?.kind === "forum") && ctx.threadRootId === ctx.triggerMessageId;
  return flat ? null : ctx.threadRootId;
}
