import { MISSION_WORKTREE_PROTOCOL } from "@agenteschat/adapters";
import { and, desc, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { recordAudit } from "./audit";
import { ConflictError } from "./errors";
import { publishUserEvent } from "./events";
import { MachineRequestError } from "./machine-hub";
import {
  claimQueuedTask,
  getTask,
  launchTask,
  type MachineTaskMode,
  type MachineTaskRow,
  type QueuedTaskStart,
  queueMachineTask,
} from "./machine-tasks";
import { MachineOfflineError, MachinePausedError } from "./machines";
import { missionAllowRules } from "./mission-command-rules";
import { MISSION_RULES } from "./mission-rules";
import {
  deliverInbox,
  getMission,
  getMissionRow,
  type MissionDeps,
  type MissionRow,
  missionBranchPrefix,
  OPEN_MISSION_STATUSES,
  postMissionMessage,
  publishMissionEvent,
  recordMissionEvent,
  requestFilesSync,
  requireAct,
  requireMission,
  requireOpen,
  tellSession,
} from "./missions";

const { missions, machineTasks, missionEvents } = schema;

/**
 * One worktree per mission (ADR 0044), server side. At Start the runner makes
 * the mission's own copy of the project (`mission.worktree ensure`): a git
 * worktree at `.worktrees/m-<short id>` on the branch
 * `agentes/<short id>/<slug>`, from the branch checked out in `repo_dir`.
 * When it is new and the project has something to prepare it with (a
 * lockfile, `agentes.json`), a `setup` task runs there first. The main
 * session and every item then work in that folder: write items one at a
 * time (each ends in a commit), read items in parallel. Items that can't
 * start now (the folder is busy, the computer is full or away) wait in our
 * queue (`machine_tasks.start_request`) and start by themselves, oldest first
 * (`startQueuedMissionTasks`). A folder without git has no worktree: the
 * mission works in `repo_dir` itself, items still one writer at a time.
 */

export type WorktreeState = "none" | "preparing" | "ready" | "failed" | "removed";
export const WORKTREE_STATES: readonly WorktreeState[] = ["none", "preparing", "ready", "failed", "removed"];
export const worktreeStateOf = (v: unknown): WorktreeState =>
  typeof v === "string" && (WORKTREE_STATES as readonly string[]).includes(v) ? (v as WorktreeState) : "none";

/** Setup (the install) is killed after this long. */
export const SETUP_MAX_SECONDS = 600;
/** What a failed setup keeps of its output. */
const SETUP_ERROR_LINES = 15;
const SETUP_ERROR_CHARS = 2000;
/** `ensure` copies files and may prune: more than a plain request. */
const ENSURE_TIMEOUT_MS = 120_000;
/** Queued tasks one scheduling pass starts at most. */
const START_BATCH = 20;

const shortId = (missionId: string) => missionId.replace(/-/g, "").slice(-8);

/** The mission's folder, relative to the agent's folder (`.worktrees/` stays out of git on the runner). */
export const missionWorktreePath = (missionId: string) => `.worktrees/m-${shortId(missionId)}`;

/** Words of a title as a branch name: lowercase ASCII, dashes, at most 40 characters ("" when nothing is left). */
export function branchSlug(title: string) {
  return title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** `agentes/<short id>/<slug of the title>` (or `…/work`): under the mission's prefix, the only branches it may push. */
export const missionBranchName = (mission: Pick<MissionRow, "id" | "title">) =>
  `${missionBranchPrefix(mission.id)}${branchSlug(mission.title) || "work"}`;

/**
 * Where the mission's sessions work, relative to the agent's folder: its own
 * folder once it is ready (`repo_dir` itself when the project has no git),
 * else `repo_dir` (planning before Start, missions from before ADR 0044).
 */
export const missionCwd = (mission: Pick<MissionRow, "repoDir" | "worktreePath" | "worktreeState">) =>
  mission.worktreeState === "ready" && mission.worktreePath !== null ? mission.worktreePath : mission.repoDir;

/** Work waits while the mission's folder is being prepared or failed to be (an active mission only). */
export const worktreeBlocksWork = (mission: Pick<MissionRow, "status" | "worktreeState">) =>
  (mission.status === "active" || mission.status === "awaiting_close") &&
  (mission.worktreeState === "preparing" || mission.worktreeState === "failed");

/** The folder the `.agentes/` files go to now; null while there is none to write (preparing, failed, removed). */
export const missionFilesDir = (mission: Pick<MissionRow, "repoDir" | "worktreePath" | "worktreeState">) =>
  mission.worktreeState === "ready"
    ? (mission.worktreePath ?? mission.repoDir)
    : mission.worktreeState === "none"
      ? mission.repoDir
      : null;

const SHA = /^[0-9a-f]{7,64}$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
export const shortSha = (sha: string) => sha.slice(0, 12);

/** The `ensure` answer, read leniently (what we asked for when a field is missing). */
function ensuredOf(data: unknown, path: string, branch: string) {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const baseSha = str(d.baseSha);
  return {
    path: str(d.path) || path,
    branch: str(d.branch) || branch,
    baseBranch: str(d.baseBranch) || null,
    baseSha: SHA.test(baseSha) ? baseSha : null,
    created: d.created === true,
    dirty: d.dirty === true,
    setupCommand: str(d.setupCommand) || null,
    copied: Array.isArray(d.copied) ? d.copied.length : 0,
  };
}

async function agentScope(deps: MissionDeps, mission: MissionRow) {
  const agent = await getAgentCached(deps.db, mission.orgId, mission.agentId);
  return { id: mission.agentId, handle: agent?.handle ?? "agent" };
}

/** Writes worktree columns; a changed state is told to the home conversation (`mission.updated change: worktree`). */
async function setWorktree(
  deps: MissionDeps,
  mission: MissionRow,
  patch: Partial<
    Pick<MissionRow, "branch" | "baseBranch" | "baseSha" | "worktreePath" | "worktreeState" | "worktreeError">
  >,
) {
  const [row] = await deps.db
    .update(missions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(missions.id, mission.id))
    .returning();
  const fresh = row ?? mission;
  if (patch.worktreeState && patch.worktreeState !== mission.worktreeState) {
    await recordMissionEvent(deps.db, fresh, "worktree_state", {
      from: mission.worktreeState,
      to: patch.worktreeState,
    });
    await publishMissionEvent(deps, fresh, "worktree", { worktreeState: fresh.worktreeState });
  }
  return fresh;
}

/** The latest setup task of the mission. */
async function lastSetupTask(deps: MissionDeps, missionId: string) {
  const [row] = await deps.db
    .select()
    .from(machineTasks)
    .where(and(eq(machineTasks.missionId, missionId), eq(machineTasks.mode, "setup")))
    .orderBy(desc(machineTasks.createdAt))
    .limit(1);
  return row ?? null;
}

const isLive = (t: MachineTaskRow | null) =>
  Boolean(t && !t.endedAt && ["queued", "running", "interrupted"].includes(t.status));

/**
 * Makes sure the mission's folder is there (ADR 0044): at Start, when the
 * computer comes back, on Resume and before the first item of a mission
 * that has none yet. A new folder (or one made again from the branch) runs
 * setup first (`preparing`); otherwise the mission is `ready` and what waited
 * goes out. Offline, paused or a runner too old: nothing changes (it runs
 * again when the computer is back). Not a git repository: the mission works
 * in `repo_dir` with no branch. The branch gone: the mission pauses and the
 * thread says so (`fresh` starts again from the base: the person's "Tentar
 * de novo"). Returns the fresh row.
 */
export async function ensureMissionWorktree(
  deps: MissionDeps,
  missionId: string,
  options: { fresh?: boolean } = {},
): Promise<MissionRow | null> {
  let mission = await getMissionRow(deps.db, missionId);
  if (!mission || !OPEN_MISSION_STATUSES.includes(mission.status) || mission.status === "proposed") return mission;
  if (!deps.hub || !mission.machineId) return mission;
  // A folder without git: the mission works in repo_dir itself, nothing to keep.
  if (mission.worktreeState === "ready" && !mission.branch) return mission;
  const status = await deps.hub.status(mission.machineId).catch(() => null);
  if (!status?.online || status.orgId !== mission.orgId || status.protocol < MISSION_WORKTREE_PROTOCOL) return mission;
  const path = mission.branch && mission.worktreePath ? mission.worktreePath : missionWorktreePath(mission.id);
  const branch = mission.branch ?? missionBranchName(mission);
  const baseSha = options.fresh ? null : mission.baseSha;
  if (mission.worktreeState === "none") mission = await setWorktree(deps, mission, { worktreeState: "preparing" });
  let reply: unknown;
  try {
    reply = await deps.hub.call<"mission.worktree">(
      mission.machineId as string,
      {
        op: "mission.worktree",
        action: "ensure",
        repo: mission.repoDir,
        path,
        branch,
        ...(baseSha ? { baseSha } : {}),
        agent: await agentScope(deps, mission),
      },
      { timeoutMs: ENSURE_TIMEOUT_MS },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof MachineRequestError ? error.code : null;
    if (code === "bad_request" && /not a git repository/i.test(message)) {
      // No git: no copy, no commits; items still take turns writing in repo_dir.
      const row = await setWorktree(deps, mission, {
        worktreePath: mission.repoDir,
        branch: null,
        baseBranch: null,
        baseSha: null,
        worktreeError: null,
      });
      await recordMissionEvent(deps.db, row, "worktree_no_git", {});
      return markReady(deps, row);
    }
    if (code === "branch_missing") return failWorktree(deps, mission, "branch_missing", message);
    // Away, paused or slow: tried again when the computer is back.
    if (
      error instanceof MachineOfflineError ||
      error instanceof MachinePausedError ||
      code === "timeout" ||
      code === "canceled" ||
      code === "paused"
    ) {
      return mission;
    }
    return failWorktree(deps, mission, "ensure", message);
  }
  const got = ensuredOf(reply, path, branch);
  const keepBase = !options.fresh && mission.baseSha;
  const before = mission.worktreeState;
  mission = await setWorktree(deps, mission, {
    worktreePath: got.path,
    branch: got.branch,
    // The base is fixed at Start: the runner always answers the repository's current branch.
    baseBranch: keepBase ? mission.baseBranch : got.baseBranch,
    baseSha: keepBase ? mission.baseSha : got.baseSha,
    worktreeError: null,
  });
  await recordMissionEvent(deps.db, mission, "worktree_ensured", {
    created: got.created,
    dirty: got.dirty,
    copied: got.copied,
  });
  // A new folder is prepared; one whose setup never finished (interrupted, failed and retried) runs it again.
  const needsSetup = got.created || before === "preparing" || before === "failed";
  if (needsSetup) {
    const setup = await lastSetupTask(deps, mission.id);
    if (isLive(setup)) return mission;
    const alreadyDone = !got.created && setup?.status === "done" && before !== "failed";
    if (got.setupCommand && !alreadyDone) return startSetup(deps, mission, got.setupCommand);
  }
  return mission.worktreeState === "ready" ? mission : markReady(deps, mission);
}

/** The setup command as a task in the mission's folder (through the queue, like items). */
async function startSetup(deps: MissionDeps, mission: MissionRow, command: string) {
  const row = await setWorktree(deps, mission, { worktreeState: "preparing", worktreeError: null });
  try {
    await queueItem(deps, row, {
      title: "Prepare the project",
      executor: "shell",
      command,
      cwd: row.worktreePath ?? missionWorktreePath(row.id),
      mode: "setup",
      maxSeconds: SETUP_MAX_SECONDS,
      requestedBy: row.ownerId,
    });
  } catch (error) {
    return failWorktree(deps, row, "setup", error instanceof Error ? error.message : String(error));
  }
  return (await getMissionRow(deps.db, row.id)) ?? row;
}

/** The folder is ready: what waited goes out (Start's prompt, messages), the files are written there, queued items start. */
async function markReady(deps: MissionDeps, mission: MissionRow) {
  const row = await setWorktree(deps, mission, { worktreeState: "ready", worktreeError: null });
  await requestFilesSync(deps.db, row);
  await deliverInbox(deps, row.id).catch(() => 0);
  if (row.machineId) await startQueuedMissionTasks(deps, row.machineId).catch(() => 0);
  return (await getMissionRow(deps.db, row.id)) ?? row;
}

type FailReason = "setup" | "ensure" | "branch_missing";

/**
 * The folder couldn't be made or prepared: `failed` with the reason, the
 * mission pauses (no item starts in a broken folder) and the thread gets a
 * card (`meta.missionSetup`) with "Tentar de novo" for the owner and deciders.
 */
async function failWorktree(deps: MissionDeps, mission: MissionRow, reason: FailReason, error: string) {
  const text = error.slice(-SETUP_ERROR_CHARS);
  let row = await setWorktree(deps, mission, { worktreeState: "failed", worktreeError: text });
  const [paused] = await deps.db
    .update(missions)
    .set({ status: "paused", pausedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(missions.id, row.id), inArray(missions.status, ["active", "awaiting_close"])))
    .returning();
  if (paused) row = paused;
  await recordMissionEvent(deps.db, row, "worktree_failed", { reason, error: text });
  await recordAudit(deps.db, {
    orgId: row.orgId,
    actor: { type: "system", id: null },
    action: "mission.paused",
    target: { type: "mission", id: row.id },
    details: { code: "mission.worktree_failed", reason },
  }).catch(() => undefined);
  const computer = row.machineId ? ((await deps.hub?.status(row.machineId).catch(() => null))?.name ?? "") : "";
  const body =
    reason === "branch_missing"
      ? `The mission's branch ${row.branch ?? ""} is gone from ${computer || "the computer"}, so I paused the mission. Trying again starts over from the project as it is now.`
      : `I couldn't prepare the project for this mission, so I paused it. The last lines:\n${text}`;
  await postMissionMessage(deps, row, body, {
    missionSetup: {
      missionId: row.id,
      state: "failed",
      reason,
      error: text,
      ...(row.branch ? { branch: row.branch } : {}),
    },
    bodyCode: reason === "branch_missing" ? "mission_branch_missing" : "mission_setup_failed",
    bodyParams: reason === "branch_missing" ? { branch: row.branch ?? "", computer } : { error: text },
  });
  if (paused) await publishMissionEvent(deps, row, "paused", { code: "mission.worktree_failed", reason });
  for (const userId of row.ownerId ? [row.ownerId] : []) {
    await publishUserEvent(deps.pubsub, row.orgId, userId, {
      type: "mission.needs_you",
      kind: "setup",
      missionId: row.id,
      threadId: row.threadRootId,
      code: "mission.worktree_failed",
    });
  }
  return row;
}

/** The last lines a failed setup printed (what the card shows). */
function setupError(task: MachineTaskRow) {
  const lines = Array.isArray(task.recentLines) ? task.recentLines.slice(-SETUP_ERROR_LINES) : [];
  const text = lines.length ? lines.join("\n") : (task.result ?? task.lastLine ?? "");
  return (text || `exit code ${task.exitCode ?? "none"}`).slice(-SETUP_ERROR_CHARS);
}

/** A setup task ended: ready (exit 0), failed (the card), or interrupted (made again when the computer is back). */
export async function onSetupEnded(deps: MissionDeps, task: MachineTaskRow) {
  if (!task.missionId) return;
  const mission = await getMissionRow(deps.db, task.missionId);
  if (!mission || mission.worktreeState !== "preparing" || !OPEN_MISSION_STATUSES.includes(mission.status)) return;
  if (task.status === "done") {
    await markReady(deps, mission);
  } else if (task.status === "failed") {
    await failWorktree(deps, mission, "setup", setupError(task));
  } else if (task.status === "interrupted") {
    await ensureMissionWorktree(deps, mission.id);
  }
}

/** A write item of the mission (other than `exceptId`) holds the folder now or waits before it. */
async function writeAhead(deps: MissionDeps, missionId: string, exceptId: string) {
  const [row] = await deps.db
    .select({ id: machineTasks.id })
    .from(machineTasks)
    .where(
      and(
        eq(machineTasks.missionId, missionId),
        eq(machineTasks.mode, "write"),
        isNull(machineTasks.endedAt),
        inArray(machineTasks.status, ["queued", "running", "interrupted"]),
        sql`${machineTasks.id} <> ${exceptId}::uuid`,
        sql`${machineTasks.createdAt} <= (select created_at from ${machineTasks} where id = ${exceptId}::uuid)`,
      ),
    )
    .limit(1);
  return Boolean(row);
}

interface ItemInput {
  title: string;
  executor: "claude" | "codex" | "shell";
  prompt?: string;
  command?: string;
  sessionId?: string | null;
  resume?: boolean;
  /** Default: the mission's folder. */
  cwd?: string | null;
  mode: MachineTaskMode;
  maxSeconds?: number;
  runId?: string | null;
  requestedBy?: string | null;
}

/** Records a task of the mission in the queue, then lets the queue start what may start. */
async function queueItem(deps: MissionDeps, mission: MissionRow, input: ItemInput) {
  if (!deps.hub || !mission.machineId) throw new ConflictError("This mission has no computer", "mission.needs_computer");
  const status = await deps.hub.status(mission.machineId);
  if (!status || status.orgId !== mission.orgId) {
    throw new ConflictError("The mission's computer was removed", "mission.needs_computer");
  }
  const agent = await agentScope(deps, mission);
  const git = Boolean(mission.branch);
  const title = input.title.slice(0, 120);
  const row = await queueMachineTask(
    { db: deps.db, pubsub: deps.pubsub },
    {
      orgId: mission.orgId,
      agent,
      machineId: mission.machineId,
      protocol: status.protocol,
      machineName: status.name,
      channelId: mission.channelId,
      threadRootId: mission.threadRootId,
      runId: input.runId ?? null,
      requestedByUserId: input.requestedBy ?? mission.ownerId,
      title,
      executor: input.executor,
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.command ? { command: input.command } : {}),
      sessionId: input.sessionId ?? null,
      resume: input.resume ?? false,
      cwd: input.cwd || missionCwd(mission) || null,
      mode: input.mode,
      worktreeBranch: mission.branch,
      ...(input.maxSeconds ? { maxSeconds: input.maxSeconds } : {}),
      // Every write item ends in a commit (the runner adds " (stopped)" when it didn't finish).
      ...(input.mode === "write" && git
        ? {
            commit: { message: `agentes: ${title}` },
            ...(mission.baseBranch && mission.baseSha
              ? { baseCheck: { branch: mission.baseBranch, sha: mission.baseSha } }
              : {}),
          }
        : {}),
      // Setup is a plain command (no mission tools); items get the mission's tools and rules.
      ...(input.mode === "setup"
        ? { missionId: mission.id }
        : {
            mission: {
              id: mission.id,
              rules: MISSION_RULES,
              branchPrefix: missionBranchPrefix(mission.id),
              allow: await missionAllowRules(deps.db, mission.id),
              // Read items run with the planning turn's read-only permissions.
              ...(input.mode === "read" ? { mode: "plan" as const } : {}),
            },
          }),
    },
  );
  await startQueuedMissionTasks(deps, mission.machineId);
  return (await getTask(deps.db, row.id)) ?? row;
}

/**
 * Starts an item of the mission (`start_task`, a resumed item session):
 * queued, then started at once when it may. Returns the row (status
 * `queued` when it waits) and why it waits.
 */
export async function startMissionItem(
  deps: MissionDeps,
  mission: MissionRow,
  input: Omit<ItemInput, "executor" | "mode"> & { mode: "write" | "read" },
) {
  const row = await queueItem(deps, mission, {
    ...input,
    executor: mission.executor === "codex" ? "codex" : "claude",
  });
  const waitsFor =
    row.status !== "queued" || row.endedAt
      ? null
      : input.mode === "write" && (await writeAhead(deps, mission.id, row.id))
        ? ("write" as const)
        : ("slot" as const);
  return { row, waitsFor };
}

/**
 * Starts what may start in a machine's queue, oldest first (ADR 0044): after
 * a task of that machine ends, when the computer comes back, when a
 * mission's folder becomes ready and when a mission resumes. A full or absent
 * computer puts the task back and stops; another refusal fails it (its end
 * is told like any other). Returns how many started.
 */
export async function startQueuedMissionTasks(deps: MissionDeps, machineId: string) {
  const hub = deps.hub;
  if (!hub) return 0;
  let started = 0;
  for (let i = 0; i < START_BATCH; i++) {
    const claimed = await claimQueuedTask(deps.db, machineId);
    if (!claimed) break;
    try {
      const out = await launchTask({ db: deps.db, pubsub: deps.pubsub, call: hub.call }, claimed.row, claimed.start, {
        requeue: true,
      });
      if (out.queued) break;
      started++;
      if (claimed.row.missionId) {
        await publishMissionTask(deps, claimed.row.missionId, claimed.row.id);
        if (out.baseBehind) await noticeBaseBehind(deps, claimed.row.missionId, out.baseBehind).catch(() => undefined);
      }
    } catch {
      // Failed for good: its end is told to the mission (`machine.task_done`).
    }
  }
  return started;
}

async function publishMissionTask(deps: MissionDeps, missionId: string, taskId: string) {
  const mission = await getMissionRow(deps.db, missionId);
  if (mission) await publishMissionEvent(deps, mission, "task", { taskId });
}

/** After any task of a machine ended: its queue may move (`machine.task_done`). */
export async function afterMachineTaskEnded(deps: MissionDeps, taskId: string) {
  const task = await getTask(deps.db, taskId);
  if (task) await startQueuedMissionTasks(deps, task.machineId);
}

/**
 * A write item found the base branch moved since Start (`task.start`
 * `baseBehind`): the main session hears it once per new count. Nothing is
 * rebased by itself.
 */
export async function noticeBaseBehind(deps: MissionDeps, missionId: string, behind: number) {
  const mission = await getMissionRow(deps.db, missionId);
  if (!mission || !OPEN_MISSION_STATUSES.includes(mission.status) || behind <= 0) return false;
  const [told] = await deps.db
    .select({ n: sql<number | null>`max((${missionEvents.data}->>'behind')::int)` })
    .from(missionEvents)
    .where(and(eq(missionEvents.missionId, mission.id), eq(missionEvents.kind, "base_behind")));
  if (behind <= Number(told?.n ?? 0)) return false;
  await recordMissionEvent(deps.db, mission, "base_behind", { behind });
  const base = mission.baseBranch ?? "the base branch";
  await tellSession(
    deps,
    mission,
    { sessionId: mission.mainSessionId, cwd: missionCwd(mission) },
    `${base} moved ${behind} commit${behind === 1 ? "" : "s"} ahead since this mission started from it${
      mission.baseSha ? ` (${shortSha(mission.baseSha)})` : ""
    }. Nothing was rebased. If the mission needs those changes, say so to the people before merging anything.`,
    { from: "the computer", kind: "system" },
  ).catch(() => undefined);
  return true;
}

/**
 * Closing (ADR 0044): the runner takes the folder away and the branch stays,
 * unless the person chose to delete everything on cancel. A failure never
 * blocks the close: it is recorded and tried again when the computer is back.
 */
export async function removeMissionWorktree(
  deps: MissionDeps,
  mission: MissionRow,
  options: { deleteBranch?: boolean } = {},
) {
  if (!mission.branch || !mission.worktreePath || mission.worktreeState === "removed") return mission;
  if (mission.worktreeState === "none") return mission;
  const deleteBranch = options.deleteBranch === true;
  try {
    if (!deps.hub || !mission.machineId) throw new Error("no computer");
    await deps.hub.call<"mission.worktree">(
      mission.machineId,
      {
        op: "mission.worktree",
        action: "remove",
        repo: mission.repoDir,
        path: mission.worktreePath,
        branch: mission.branch,
        ...(deleteBranch ? { deleteBranch: true } : {}),
        agent: await agentScope(deps, mission),
      },
      { timeoutMs: ENSURE_TIMEOUT_MS },
    );
  } catch (error) {
    await recordMissionEvent(deps.db, mission, "worktree_remove_failed", {
      deleteBranch,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    }).catch(() => undefined);
    return mission;
  }
  const row = await setWorktree(deps, mission, { worktreeState: "removed" });
  await recordMissionEvent(deps.db, row, "worktree_removed", { deleteBranch });
  return row;
}

/** Closed missions on a machine whose folder is still there (removing it failed or the computer was away). */
export async function removeLeftWorktrees(deps: MissionDeps, machineId: string) {
  const left = await deps.db
    .select()
    .from(missions)
    .where(
      and(
        eq(missions.machineId, machineId),
        inArray(missions.status, ["done", "canceled"]),
        inArray(missions.worktreeState, ["preparing", "ready", "failed"]),
        sql`${missions.branch} is not null`,
      ),
    );
  for (const mission of left) {
    const [last] = await deps.db
      .select({ data: missionEvents.data })
      .from(missionEvents)
      .where(and(eq(missionEvents.missionId, mission.id), eq(missionEvents.kind, "worktree_remove_failed")))
      .orderBy(desc(missionEvents.createdAt))
      .limit(1);
    await removeMissionWorktree(deps, mission, { deleteBranch: last?.data?.deleteBranch === true });
  }
}

/**
 * "Tentar de novo" on the setup card (owner or deciders): the folder is made
 * or prepared again and the mission resumes. After a lost branch it starts
 * over from the project as it is now (that is the person's choice).
 */
export async function retryMissionWorktree(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "prepare the project again");
  requireOpen(mission);
  if (mission.worktreeState !== "failed") {
    throw new ConflictError("The project wasn't left unprepared", "mission.worktree_not_failed", {
      worktreeState: mission.worktreeState,
    });
  }
  const [last] = await deps.db
    .select({ data: missionEvents.data })
    .from(missionEvents)
    .where(and(eq(missionEvents.missionId, mission.id), eq(missionEvents.kind, "worktree_failed")))
    .orderBy(desc(missionEvents.createdAt))
    .limit(1);
  const fresh = last?.data?.reason === "branch_missing";
  let row = await setWorktree(deps, mission, {
    worktreeState: "preparing",
    worktreeError: null,
    ...(fresh ? { baseSha: null, baseBranch: null, worktreePath: null } : {}),
  });
  const [resumed] = await deps.db
    .update(missions)
    .set({ status: "active", pausedAt: null, idleWakeups: 0, updatedAt: new Date() })
    .where(and(eq(missions.id, row.id), eq(missions.status, "paused")))
    .returning();
  if (resumed) {
    row = resumed;
    await recordMissionEvent(deps.db, row, "resumed", { by: userId, reason: "worktree_retry" });
    await publishMissionEvent(deps, row, "resumed");
  }
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "mission.worktree_retried",
    target: { type: "mission", id: row.id },
    details: { fresh },
  });
  await ensureMissionWorktree(deps, row.id, { fresh });
  return getMission(deps, userId, orgId, row.id);
}

