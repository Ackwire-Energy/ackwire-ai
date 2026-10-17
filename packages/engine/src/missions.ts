import { MISSION_PROTOCOL, type PubSub, TASK_OUTPUT_PROTOCOL, TASKS_PROTOCOL } from "@agenteschat/adapters";
import {
  and,
  asc,
  type Database,
  desc,
  type Executor,
  eq,
  inArray,
  isNull,
  or,
  rowsOf,
  schema,
  sql,
} from "@agenteschat/db";
import { getAgentCached } from "./agents";
import type { ArtifactDeps } from "./artifacts";
import { audienceSql } from "./audience";
import { recordAudit } from "./audit";
import { requireChannelAccess } from "./channels";
import { eligibleChannelAgents } from "./dispatch";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishMessageCreated, publishUserEvent } from "./events";
import type { Judge } from "./judge";
import { type MachineCaller, MachineRequestError } from "./machine-hub";
import {
  formatDuration,
  type MachineTaskRow,
  publishTaskEvent,
  RECENT_LINES,
  startMachineTask,
  taskSeconds,
} from "./machine-tasks";
import { MachineOfflineError, machineOnline } from "./machines";
import { insertMessage, type Message, messageView } from "./messages";
import { missionAllowRules, pendingCommandCounts, pendingCommandsSql } from "./mission-command-rules";
import { MISSION_RULES } from "./mission-rules";
import { enqueueRunJob } from "./mission-runs";
import {
  cancelMainRuns,
  deliverInboxOnEngine,
  type MissionEngine,
  missionsOnEngine,
  type TellOptions,
  tellMainOnEngine,
} from "./missions-engine";
import { notifyMissionEnded } from "./notification-producers";
import { can, requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import type { SearchDeps } from "./search";
import { autoThreadTitle, createThreadFromRange } from "./threads";
import { createWikiPage } from "./wiki";

const {
  missions,
  missionParticipants,
  missionPlanVersions,
  missionDecisions,
  missionReviews,
  missionFiles,
  missionEvents,
  missionJoinRequests,
  missionDeliveries,
  machineTasks,
  machines,
  messages,
  threads,
  users,
} = schema;

/**
 * Missions (ADR 0029): the control layer of long work. The executor on the
 * person's connected computer (Claude Code, Codex) is the brain: its main
 * session planned the mission, hears what people send and splits the work
 * into tasks; our side shows, stores, asks for approval and delivers, with
 * code and no model.
 *
 * - One mission per thread (its home). Seeing is inherited from the home;
 *   acting (work on the machine, decisions, reviews, controls) is the
 *   owner's and the `decide` participants'. `comment` participants give
 *   opinions on decisions; everyone else is read only, and their messages to
 *   the agent there become suggestions (decided in the message insert).
 * - Talking to a session = resuming it on the machine (`claude -p --resume`)
 *   with the text as the prompt, as a new machine task. A session whose task
 *   still runs, a paused mission or an offline computer can't hear it now:
 *   the text waits in `missions.inbox` and goes out when the session's task
 *   ends, the mission resumes or the computer comes back.
 * - `.agentes/` files (mission.md, decisions.md) are written to the machine
 *   after every change (debounced job `mission.sync_files`); notes.md is read
 *   back after each mission task.
 */
export type MissionRow = typeof missions.$inferSelect;
export type MissionStatus = MissionRow["status"];
export type MissionRole = "owner" | "decide" | "comment" | "none";
export type PlanItem = schema.MissionPlanItem;
export type PlanStatus = PlanItem["status"];

export const PLAN_STATUSES: PlanStatus[] = ["todo", "doing", "waiting_you", "done", "dropped"];

/**
 * Who does the work on the computer: Claude Code or Codex (the executor is
 * the brain, ADR 0029), or `agent`: our agent itself, with its own tools
 * (`start_task`, `run_code`, files) on the connected computer, keeping the
 * plan with its mission tools. Stored as text; validated here.
 */
export type MissionExecutor = "claude" | "codex" | "agent";
export const MISSION_EXECUTORS: readonly MissionExecutor[] = ["claude", "codex", "agent"];
export const isMissionExecutor = (v: unknown): v is MissionExecutor =>
  typeof v === "string" && (MISSION_EXECUTORS as readonly string[]).includes(v);

/**
 * "Pedir aprovação de comandos" (ADR 0029): `always` (every command off the
 * allow list gets a card), `low_risk_auto` (the judge allows the low-risk
 * ones within what code allows; the default for new missions) or `never`
 * (everything but the deny list). Stored as text; validated here.
 */
export type CommandApproval = "always" | "low_risk_auto" | "never";
export const COMMAND_APPROVALS: readonly CommandApproval[] = ["always", "low_risk_auto", "never"];
export const isCommandApproval = (v: unknown): v is CommandApproval =>
  typeof v === "string" && (COMMAND_APPROVALS as readonly string[]).includes(v);
export const commandApprovalOf = (v: unknown): CommandApproval => (isCommandApproval(v) ? v : "always");
/** New missions of an agent without a default of its own ("Usar como padrão") start here. */
export const DEFAULT_MISSION_COMMAND_APPROVAL: CommandApproval = "low_risk_auto";
/** The autonomy an agent's new missions start with (`agents.mission_command_approval`). */
export function agentMissionApproval(agent: { missionCommandApproval?: string | null } | null | undefined) {
  const v = agent?.missionCommandApproval;
  return isCommandApproval(v) ? v : DEFAULT_MISSION_COMMAND_APPROVAL;
}

/**
 * Codex needs `exec --json`, `exec … resume <id>` and no `--full-auto` (ADR
 * 0029, "Codex"): 0.163.0 is the release verified on a real machine.
 */
export const CODEX_MIN_VERSION = "0.163.0";

/** `codex-cli 0.163.0` → [0, 163, 0]; null when there is no version in it. */
export function versionOf(text: string | undefined): number[] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const atLeast = (have: number[], want: number[]) => {
  for (let i = 0; i < 3; i++) if ((have[i] ?? 0) !== (want[i] ?? 0)) return (have[i] ?? 0) > (want[i] ?? 0);
  return true;
};

/** What a computer can run a mission with: what it has installed (protocol 7) and what its runner speaks. */
export function machineExecutors(machine: {
  protocol: number;
  execAllowed: boolean;
  executors?: schema.MachineExecutors | null;
}): { available: MissionExecutor[]; codexTooOld: boolean } {
  if (!machine.execAllowed || machine.protocol < TASKS_PROTOCOL) return { available: [], codexTooOld: false };
  const found = machine.executors ?? {};
  // A runner that doesn't report its CLIs (older than protocol 7): Claude Code is assumed, as before.
  const unknown = !found.detectedAt;
  const available: MissionExecutor[] = [];
  let codexTooOld = false;
  if (machine.protocol >= MISSION_PROTOCOL) {
    if (unknown || found.claude) available.push("claude");
    if (found.codex) {
      const v = versionOf(found.codex.version);
      if (v && atLeast(v, versionOf(CODEX_MIN_VERSION) as number[])) available.push("codex");
      else codexTooOld = true;
    }
  }
  available.push("agent");
  return { available, codexTooOld };
}

/** The default: Claude Code when the computer has it, else our agent. */
export const defaultExecutor = (available: MissionExecutor[]): MissionExecutor =>
  available.includes("claude") ? "claude" : "agent";

/** The stuck-loop guard (agent mode): the same task failing this many times in a row, or this many idle wake-ups. */
export const MISSION_STUCK = { failures: 3, idleWakeups: 5 } as const;

/** The mission's branches start with this (the runner lets its executor push only these). */
export const missionBranchPrefix = (missionId: string) => `agentes/${missionId.replace(/-/g, "").slice(-8)}/`;
export const MISSION_LIMITS = {
  title: 120,
  goal: 2000,
  planItems: 60,
  itemTitle: 200,
  itemNote: 500,
  sendText: 8000,
  inbox: 50,
  repoDir: 300,
  /** Plan items in a mission view (the strip); the full plan is `GET …/plan`. */
  viewItems: 40,
  /** `GET …/tasks/{id}/output`: at most this many lines. */
  outputLines: 200,
} as const;
/** Open: work may still happen (`awaiting_close` waits for its owner to conclude it). */
export const OPEN_MISSION_STATUSES: MissionStatus[] = ["proposed", "active", "paused", "awaiting_close"];
const OPEN = OPEN_MISSION_STATUSES;

export interface MissionDeps {
  db: Database;
  pubsub?: PubSub;
  /** Connected computers: start, resume and cancel tasks; read and write `.agentes/`. */
  hub?: MachineCaller | null;
  /** Drive (uploads of review files and artifacts). */
  artifacts?: ArtifactDeps;
  /** Search over what the agent may see (`get_context`). */
  search?: SearchDeps;
  /** Our public URL (the runner pushes uploads there). */
  publicUrl?: string;
  /** Semantic judgments (judge.ts): low-risk commands in `low_risk_auto` missions. */
  judge?: Judge;
  /**
   * `MISSIONS_ON_ENGINE` (ADR 0032 §6): the main session is the agent's run in the home
   * thread with the mission's brain (missions-engine.ts). Off (default): executor tasks.
   */
  missionsOnEngine?: boolean;
  /** The engine the mission side starts, resumes and cancels runs with (default: today's run queue). */
  missionEngine?: MissionEngine | null;
}

// ── Prompts the executor gets (English, plain) ───────────────────────────────

export function planPrompt(mission: Pick<MissionRow, "title" | "goal">) {
  return [
    `Mission: ${mission.title}`,
    `Goal: ${mission.goal}`,
    "",
    "PLAN MODE. Explore the mission folder (a code repository or plain files) read-only: don't change any file and don't run anything that writes.",
    "Then call the agentes tool update_plan with the first items of the plan (a checklist; short, stable ids),",
    "and call report with the goal in one sentence for the people. Then end your turn: the people review the plan and press Start.",
    "Write the plan items, reports, decisions and reviews in the language of the goal (the people's language).",
  ].join("\n");
}

/** Agent mode: what our agent is told when its mission is proposed (it plans it itself). */
export function agentPlanPrompt(mission: Pick<MissionRow, "title" | "goal">) {
  return [
    `Mission proposed: ${mission.title}. Goal: ${mission.goal}`,
    "PLAN MODE: explore the mission folder on the computer read-only (read_file, list_files, run_code with read-only commands); don't change anything yet.",
    "Then call update_plan with the first items (a checklist; short, stable ids) and report the goal in one sentence. Then end your turn: the people review the plan and press Start.",
    "Write the plan items, reports, decisions and reviews in the language of the goal (the people's language).",
  ].join("\n");
}

/** Agent mode: what our agent is told when the owner presses Start. */
export const AGENT_START_PROMPT =
  "The person approved the plan. Do the work now on the computer: start_task for anything long (it wakes you when it ends), run_code for short commands; keep the plan with update_plan, report milestones, ask decisions with ask_decision, request_review when there is something to show, and request_approval before any merge, deploy or rollback.";

export const START_PROMPT =
  "The person approved the plan. Proceed: split the work into tasks with start_task (each gets its own branch in a git repository, its own subfolder otherwise; small work you can do yourself) using the agentes tools; keep the plan updated; ask for a review when you have something to show.";

// ── Small helpers ────────────────────────────────────────────────────────────

/** Executor text goes into the thread as plain text: an @ never mentions anyone. */
export const noMentions = (text: string) => text.replace(/@(?=[A-Za-z0-9])/g, "@⁠");
/** Control characters (but newlines and tabs) become spaces. */
const visible = (text: string) =>
  Array.from(text, (ch) => {
    const c = ch.charCodeAt(0);
    return (c < 32 && ch !== "\n" && ch !== "\t") || c === 127 ? " " : ch;
  }).join("");
const clean = (text: unknown, max: number) =>
  visible(typeof text === "string" ? text.slice(0, max * 2) : "")
    .trim()
    .slice(0, max);
const oneLine = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

async function namesOf(db: Executor, ids: (string | null | undefined)[]) {
  const wanted = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, wanted));
  for (const r of rows) out.set(r.id, r.name);
  return out;
}
const nameOf = async (db: Executor, id: string | null | undefined) =>
  (id ? (await namesOf(db, [id])).get(id) : undefined) ?? "someone";

export async function getMissionRow(db: Executor, missionId: string): Promise<MissionRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(missionId)) return null;
  const [row] = await db.select().from(missions).where(eq(missions.id, missionId));
  return row ?? null;
}

export async function missionOfThread(db: Executor, orgId: string, threadRootId: string) {
  const [row] = await db
    .select()
    .from(missions)
    .where(and(eq(missions.orgId, orgId), eq(missions.threadRootId, threadRootId)));
  return row ?? null;
}

/** The person's role in a mission: owner, a participant's role, or none. */
export async function missionRole(db: Executor, mission: Pick<MissionRow, "id" | "ownerId">, userId: string) {
  if (mission.ownerId && mission.ownerId === userId) return "owner" as const;
  const [p] = await db
    .select({ role: missionParticipants.role })
    .from(missionParticipants)
    .where(and(eq(missionParticipants.missionId, mission.id), eq(missionParticipants.userId, userId)));
  return (p?.role ?? "none") as MissionRole;
}

const mayAct = (role: MissionRole) => role === "owner" || role === "decide";

/** The mission and the caller's place in it; whoever reads its home channel sees it. */
export async function requireMission(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const mission = await getMissionRow(deps.db, missionId);
  if (!mission || mission.orgId !== orgId) throw new NotFoundError("Mission not found", "mission.not_found");
  const { membership } = await requireChannelAccess(deps.db, userId, orgId, mission.channelId).catch(() => {
    throw new NotFoundError("Mission not found", "mission.not_found");
  });
  const role = await missionRole(deps.db, mission, userId);
  return { mission, role, isAdmin: can(membership.role, "manage_members") };
}

export function requireAct(role: MissionRole, what = "do this") {
  if (!mayAct(role)) {
    throw new ForbiddenError(`Only the mission's owner or someone who can decide can ${what}`, "mission.not_allowed");
  }
}

export function requireOpen(mission: MissionRow) {
  if (!OPEN.includes(mission.status)) throw new ConflictError("This mission is closed", "mission.closed");
}

/** The mission's agent answers this person (D31) and is still in the mission's conversation. */
export async function agentAnswers(
  db: Executor,
  mission: Pick<MissionRow, "orgId" | "channelId" | "agentId">,
  userId: string,
) {
  const ok = await eligibleChannelAgents(db, mission.orgId, mission.channelId, [mission.agentId], {
    requesterUserId: userId,
  });
  return ok.length > 0;
}

/**
 * Mission tools per hour, per task (the executor's MCP tools) or per agent
 * (agent mode): a loop can't flood the thread or the approvers. Beyond it the
 * call fails with `mission.rate_limited`.
 */
export const MISSION_TOOL_RATES: Record<string, number> = {
  report: 30,
  update_plan: 60,
  ask_decision: 10,
  request_review: 10,
  request_approval: 5,
  upload_artifact: 30,
  start_task: 30,
  complete_mission: 5,
};

/** Counts this call (a `tool_call` event) and refuses past the hourly limit. */
export async function checkMissionToolRate(
  db: Executor,
  mission: Pick<MissionRow, "id" | "orgId">,
  tool: string,
  key: string,
) {
  const limit = MISSION_TOOL_RATES[tool];
  if (!limit) return;
  const rows = rowsOf<{ n: number | string }>(
    await db.execute(sql`select count(*)::int as n from ${missionEvents}
      where mission_id = ${mission.id}::uuid and kind = 'tool_call' and created_at > now() - interval '1 hour'
        and data->>'tool' = ${tool} and data->>'key' = ${key}`),
  );
  if (Number(rows[0]?.n ?? 0) >= limit) {
    throw new ConflictError(
      `Too many ${tool} calls in the last hour (at most ${limit}). Slow down: do the work, then report once.`,
      "mission.rate_limited",
      { tool, limit: String(limit) },
    );
  }
  await recordMissionEvent(db, mission, "tool_call", { tool, key });
}

/** Appends to the mission's feed. */
export async function recordMissionEvent(
  db: Executor,
  mission: Pick<MissionRow, "id" | "orgId">,
  kind: string,
  data: Record<string, unknown> = {},
) {
  await db.insert(missionEvents).values({ orgId: mission.orgId, missionId: mission.id, kind, data });
}

/** `mission.updated` to the home conversation (ADR 0010). */
export async function publishMissionEvent(
  deps: Pick<MissionDeps, "pubsub">,
  mission: Pick<MissionRow, "id" | "channelId" | "threadRootId" | "status">,
  change: string,
  extra: Record<string, unknown> = {},
) {
  await publishChannelEvent(deps.pubsub, {
    type: "mission.updated",
    channelId: mission.channelId,
    threadId: mission.threadRootId,
    missionId: mission.id,
    status: mission.status,
    change,
    ...extra,
  });
}

/**
 * New work for a mission waiting to be concluded (`awaiting_close`): a
 * person's message, "Pedir ajustes", a plan item reopened, a task started.
 * It goes back to `active`; any other status is left alone. Returns the
 * fresh row.
 */
export async function reactivateMission(
  deps: Pick<MissionDeps, "db" | "pubsub">,
  mission: MissionRow,
  reason: string,
): Promise<MissionRow> {
  if (mission.status !== "awaiting_close") return mission;
  const [row] = await deps.db
    .update(missions)
    .set({ status: "active", updatedAt: new Date() })
    .where(and(eq(missions.id, mission.id), eq(missions.status, "awaiting_close")))
    .returning();
  if (!row) return (await getMissionRow(deps.db, mission.id)) ?? mission;
  await recordMissionEvent(deps.db, row, "reactivated", { reason });
  await requestFilesSync(deps.db, row);
  await publishMissionEvent(deps, row, "status", { reason });
  return row;
}

/**
 * Schedules the "is everything done?" check (`mission.check_done`, see
 * mission-delivery.ts). Delayed so an agent finishing its plan has time to
 * call `complete_mission` itself before an automatic card shows.
 */
export async function scheduleDoneCheck(
  db: Executor,
  mission: Pick<MissionRow, "id" | "orgId">,
  delayMs = DONE_CHECK_DELAY_MS,
  attempt = 0,
) {
  const at = Date.now() + delayMs;
  await enqueue(db, {
    orgId: mission.orgId,
    kind: "mission.check_done",
    payload: { missionId: mission.id, attempt },
    dedupeKey: `mission.check_done:${mission.id}:${Math.floor(at / 5000)}`,
    runAt: new Date(at),
    maxAttempts: 3,
  });
}

/** How long after the last plan change the done check runs. */
export const DONE_CHECK_DELAY_MS = 30_000;

/** A line written in the mission's thread by its agent (no run, no routing). */
export async function postMissionMessage(
  deps: Pick<MissionDeps, "db" | "pubsub">,
  mission: Pick<MissionRow, "orgId" | "agentId" | "channelId" | "threadRootId">,
  body: string,
  meta: Record<string, unknown>,
  tx?: Executor,
): Promise<Message> {
  const message = await insertMessage(tx ?? deps.db, {
    orgId: mission.orgId,
    channelId: mission.channelId,
    threadId: mission.threadRootId,
    author: { type: "agent", agentId: mission.agentId, runId: null, hop: 0 },
    body: noMentions(body).slice(0, 39_000) || "…",
    meta,
  });
  if (!tx && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
  return message;
}

/** Marks the `.agentes/` files for writing and schedules the (debounced) sync. */
export async function requestFilesSync(db: Executor, mission: Pick<MissionRow, "id" | "orgId">, delayMs = 2000) {
  await db.update(missions).set({ filesDirtyAt: new Date() }).where(eq(missions.id, mission.id));
  const at = Date.now() + delayMs;
  await enqueue(db, {
    orgId: mission.orgId,
    kind: "mission.sync_files",
    payload: { missionId: mission.id },
    dedupeKey: `mission.sync_files:${mission.id}:${Math.floor(at / 5000)}`,
    runAt: new Date(at),
    maxAttempts: 3,
  });
}

// ── Views ────────────────────────────────────────────────────────────────────

export interface MissionView {
  id: string;
  /** The home thread (root message id). */
  threadId: string;
  channelId: string;
  agentId: string;
  ownerId: string | null;
  executor: string;
  title: string;
  goal: string;
  status: MissionStatus;
  repoDir: string;
  resumeTasks: boolean;
  /** "Pedir aprovação de comandos". */
  commandApproval: CommandApproval;
  plan: {
    version: number;
    done: number;
    total: number;
    waiting: number;
    /** Items in progress now. */
    doing: number;
    /** The latest plan in order, for the strip (at most `MISSION_LIMITS.viewItems`; dropped ones included). */
    items: { id: string; title: string; status: PlanStatus }[];
  };
  pending: {
    decisions: number;
    provisional: number;
    reviews: number;
    suggestions: number;
    /** Requests to join waiting for an answer (0 for whoever can't answer them). */
    joinRequests: number;
    /** Command cards waiting for an answer (0 for whoever can't answer them). */
    commands: number;
    /** Delivery cards waiting to be concluded (0 for whoever can't answer them). */
    deliveries: number;
  };
  /** The caller asked to join and nobody answered yet. */
  joinRequested: boolean;
  runningTasks: number;
  machine: {
    id: string;
    name: string;
    online: boolean;
    lentBy: string | null;
    /** Who can do the work there (the plan card lets the owner switch before Start). */
    executors: MissionExecutor[];
    /** Codex is installed but older than `CODEX_MIN_VERSION`. */
    codexTooOld: boolean;
  } | null;
  /** The owner has no computer for it (handed over without one): work can't start until they set one. */
  needsComputer: boolean;
  /** The caller's role, and what it allows. */
  role: MissionRole;
  canAct: boolean;
  canManage: boolean;
  createdAt: string;
  startedAt: string | null;
  pausedAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  wikiPageId: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Views of several missions for one person (six queries for the whole list). */
export async function missionViews(
  db: Database,
  rows: MissionRow[],
  userId: string,
  isAdmin: boolean,
): Promise<MissionView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const machineIds = [...new Set(rows.flatMap((r) => (r.machineId ? [r.machineId] : [])))];
  const [roles, counts, machineRows, running, plans, joins, commands, deliveries] = await Promise.all([
    db
      .select({ missionId: missionParticipants.missionId, role: missionParticipants.role })
      .from(missionParticipants)
      .where(and(inArray(missionParticipants.missionId, ids), eq(missionParticipants.userId, userId))),
    db.execute(sql`select mission_id, 'decision:' || status as k, count(*)::int as n from ${missionDecisions}
        where mission_id in (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}) and status in ('pending', 'provisional') group by mission_id, status
      union all
      select mission_id, 'review' as k, count(*)::int as n from ${missionReviews}
        where mission_id in (${sql.join(
          ids.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}) and status = 'pending' group by mission_id`),
    machineIds.length
      ? db
          .select({
            id: machines.id,
            name: machines.name,
            online: machines.online,
            lastSeenAt: machines.lastSeenAt,
            pairedBy: machines.pairedByUserId,
            deletedAt: machines.deletedAt,
            protocol: machines.protocol,
            execAllowed: machines.execAllowed,
            executors: machines.executors,
          })
          .from(machines)
          .where(inArray(machines.id, machineIds))
      : Promise.resolve([]),
    db
      .select({ missionId: machineTasks.missionId, n: sql<number>`count(*)::int` })
      .from(machineTasks)
      .where(
        and(
          inArray(machineTasks.missionId, ids),
          inArray(machineTasks.status, ["queued", "running"]),
          isNull(machineTasks.endedAt),
        ),
      )
      .groupBy(machineTasks.missionId),
    db
      .selectDistinctOn([missionPlanVersions.missionId], {
        missionId: missionPlanVersions.missionId,
        items: missionPlanVersions.items,
      })
      .from(missionPlanVersions)
      .where(inArray(missionPlanVersions.missionId, ids))
      .orderBy(missionPlanVersions.missionId, desc(missionPlanVersions.version)),
    db
      .select({
        missionId: missionJoinRequests.missionId,
        n: sql<number>`count(*)::int`,
        mine: sql<boolean>`bool_or(${missionJoinRequests.userId} = ${userId})`,
      })
      .from(missionJoinRequests)
      .where(and(inArray(missionJoinRequests.missionId, ids), eq(missionJoinRequests.status, "pending")))
      .groupBy(missionJoinRequests.missionId),
    pendingCommandCounts(db, ids),
    db
      .select({ missionId: missionDeliveries.missionId, n: sql<number>`count(*)::int` })
      .from(missionDeliveries)
      .where(and(inArray(missionDeliveries.missionId, ids), eq(missionDeliveries.status, "pending")))
      .groupBy(missionDeliveries.missionId),
  ]);
  const deliveriesOf = new Map(deliveries.map((d) => [d.missionId, Number(d.n)]));
  const planOf = new Map(plans.map((p) => [p.missionId, Array.isArray(p.items) ? p.items : []]));
  const joinOf = new Map(joins.map((j) => [j.missionId, j]));
  const roleOf = new Map(roles.map((r) => [r.missionId, r.role]));
  const countRows = rowsOf<{ mission_id: string; k: string; n: number | string }>(counts);
  const count = (id: string, k: string) => Number(countRows.find((c) => c.mission_id === id && c.k === k)?.n ?? 0);
  const machineOf = new Map(machineRows.map((m) => [m.id, m]));
  const runningOf = new Map(running.map((r) => [r.missionId, Number(r.n)]));
  return rows.map((r) => {
    const role: MissionRole = r.ownerId === userId ? "owner" : ((roleOf.get(r.id) as MissionRole) ?? "none");
    const m = r.machineId ? machineOf.get(r.machineId) : undefined;
    const needsComputer = !m || Boolean(m.deletedAt) || (m.pairedBy !== r.ownerId && !r.machineLentBy);
    const items = planOf.get(r.id) ?? [];
    const join = joinOf.get(r.id);
    return {
      id: r.id,
      threadId: r.threadRootId,
      channelId: r.channelId,
      agentId: r.agentId,
      ownerId: r.ownerId,
      executor: r.executor,
      title: r.title,
      goal: r.goal,
      status: r.status,
      repoDir: r.repoDir,
      resumeTasks: r.resumeTasks,
      commandApproval: commandApprovalOf(r.commandApproval),
      plan: {
        version: r.planVersion,
        done: r.planDone,
        total: r.planTotal,
        waiting: r.planWaiting,
        doing: items.filter((i) => i.status === "doing").length,
        items: items.slice(0, MISSION_LIMITS.viewItems).map((i) => ({ id: i.id, title: i.title, status: i.status })),
      },
      pending: {
        decisions: count(r.id, "decision:pending"),
        provisional: count(r.id, "decision:provisional"),
        reviews: count(r.id, "review"),
        suggestions: 0,
        joinRequests: mayAct(role) ? Number(join?.n ?? 0) : 0,
        commands: mayAct(role) ? (commands.get(r.id) ?? 0) : 0,
        deliveries: mayAct(role) ? (deliveriesOf.get(r.id) ?? 0) : 0,
      },
      joinRequested: role === "none" && join?.mine === true,
      runningTasks: runningOf.get(r.id) ?? 0,
      machine: m
        ? {
            id: m.id,
            name: m.name,
            online: machineOnline(m),
            lentBy: r.machineLentBy,
            executors: machineExecutors(m).available,
            codexTooOld: machineExecutors(m).codexTooOld,
          }
        : null,
      needsComputer,
      role,
      canAct: mayAct(role) && OPEN.includes(r.status),
      canManage: role === "owner" || isAdmin,
      createdAt: r.createdAt.toISOString(),
      startedAt: iso(r.startedAt),
      pausedAt: iso(r.pausedAt),
      closedAt: iso(r.closedAt),
      closeReason: r.closeReason,
      wikiPageId: r.wikiPageId,
    };
  });
}

async function viewFor(deps: MissionDeps, mission: MissionRow, userId: string, isAdmin: boolean) {
  const [view] = await missionViews(deps.db, [mission], userId, isAdmin);
  const [suggestions] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, mission.orgId),
        eq(messages.threadId, mission.threadRootId),
        sql`${messages.meta}->'missionSuggestion'->>'status' = 'pending'`,
      ),
    );
  return {
    ...(view as MissionView),
    pending: { ...(view as MissionView).pending, suggestions: Number(suggestions?.n ?? 0) },
  };
}

export async function getMission(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const { mission, isAdmin } = await requireMission(deps, userId, orgId, missionId);
  return viewFor(deps, mission, userId, isAdmin);
}

export async function getMissionByThread(deps: MissionDeps, userId: string, orgId: string, threadId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new NotFoundError("Mission not found", "mission.not_found");
  const row = await missionOfThread(deps.db, orgId, threadId);
  if (!row) throw new NotFoundError("This thread has no mission", "mission.not_found");
  return getMission(deps, userId, orgId, row.id);
}

export interface ListMissionsInput {
  status?: MissionStatus | "open" | "closed" | "waiting_you";
  /** Its home conversation. */
  channelId?: string;
  agentId?: string;
  /** Words of the title or the goal. */
  q?: string;
  limit?: number;
}

/**
 * Something waits for this person in the mission (`m`): they can act and a
 * decision, a review, a plan item, a suggestion, a request to join or a
 * command card waits.
 */
const waitingYouSql = (userId: string) => sql`(m.owner_id = ${userId} or exists (select 1 from ${missionParticipants} mp
    where mp.mission_id = m.id and mp.user_id = ${userId} and mp.role = 'decide'))
  and (m.plan_waiting > 0
    or m.status = 'awaiting_close'
    or exists (select 1 from ${missionDeliveries} mdl where mdl.mission_id = m.id and mdl.status = 'pending')
    or exists (select 1 from ${missionDecisions} md where md.mission_id = m.id and md.status in ('pending', 'provisional'))
    or exists (select 1 from ${missionReviews} mr where mr.mission_id = m.id and mr.status = 'pending')
    or exists (select 1 from ${missionJoinRequests} mj where mj.mission_id = m.id and mj.status = 'pending')
    or exists (select 1 from ${messages} sm where sm.org_id = m.org_id and sm.thread_id = m.thread_root_id
      and sm.meta->'missionSuggestion'->>'status' = 'pending')
    or ${pendingCommandsSql(sql`m.id`)} > 0)`;

const OPEN_SQL = sql`m.status in ('proposed', 'active', 'paused', 'awaiting_close')`;

/** The missions (alias `m`) the person sees, with the filters but the status. */
function missionScope(userId: string, orgId: string, input: ListMissionsInput) {
  const q = input.q?.trim().slice(0, 200);
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const uuid = (v: string | undefined) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : null);
  const channelId = uuid(input.channelId);
  const agentId = uuid(input.agentId);
  if ((input.channelId && !channelId) || (input.agentId && !agentId)) return sql`false`;
  return sql`m.org_id = ${orgId}::uuid
    and m.channel_id in (select cm.channel_id from ${schema.channelMembers} cm
      where cm.org_id = ${orgId}::uuid and cm.user_id = ${userId})
    ${channelId ? sql`and m.channel_id = ${channelId}::uuid` : sql``}
    ${agentId ? sql`and m.agent_id = ${agentId}::uuid` : sql``}
    ${like ? sql`and (m.title ilike ${like} or m.goal ilike ${like})` : sql``}`;
}

/**
 * Missions the person can see (their home channels), most recently changed
 * first, filtered by status (`open`, `closed`, `waiting_you` or one status),
 * conversation, agent and words; `counts` (same filters, any status) feed
 * the tabs and the sidebar.
 */
export async function listMissions(deps: MissionDeps, userId: string, orgId: string, input: ListMissionsInput = {}) {
  const membership = await requirePermission(deps.db, userId, orgId, "read");
  const status = input.status;
  const scope = missionScope(userId, orgId, input);
  const statusSql =
    status === "open"
      ? OPEN_SQL
      : status === "closed"
        ? sql`m.status in ('done', 'canceled')`
        : status === "waiting_you"
          ? sql`${OPEN_SQL} and ${waitingYouSql(userId)}`
          : status
            ? sql`m.status = ${status}`
            : sql`true`;
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const [rows, counts] = await Promise.all([
    deps.db
      .select()
      .from(missions)
      .where(sql`${missions.id} in (select m.id from ${missions} m where ${scope} and ${statusSql})`)
      .orderBy(desc(missions.updatedAt))
      .limit(limit),
    missionCounts(deps.db, userId, orgId, input),
  ]);
  return {
    missions: await missionViews(deps.db, rows, userId, can(membership.role, "manage_members")),
    counts,
  };
}

/** `{ active, waitingYou, closed }` over the missions the person sees (one query; the sidebar's count). */
export async function missionCounts(db: Executor, userId: string, orgId: string, input: ListMissionsInput = {}) {
  const rows = rowsOf<{ active: number | string; waiting_you: number | string; closed: number | string }>(
    await db.execute(sql`select
        count(*) filter (where ${OPEN_SQL})::int as active,
        count(*) filter (where ${OPEN_SQL} and ${waitingYouSql(userId)})::int as waiting_you,
        count(*) filter (where m.status in ('done', 'canceled'))::int as closed
      from ${missions} m where ${missionScope(userId, orgId, input)}`),
  );
  const r = rows[0];
  return { active: Number(r?.active ?? 0), waitingYou: Number(r?.waiting_you ?? 0), closed: Number(r?.closed ?? 0) };
}

// ── Starting a mission ───────────────────────────────────────────────────────

function hubOf(deps: MissionDeps) {
  if (!deps.hub) throw new ConflictError("Connected computers are not available on this server", "mission.no_computer");
  return deps.hub;
}

/**
 * The agent's connected computer, usable for missions: online, commands on,
 * and able to run the chosen executor (Claude Code or Codex: runner protocol
 * 5 and the CLI there; our agent: protocol 4). No executor asked: Claude Code
 * when the computer has it, else our agent.
 */
async function usableMachine(
  deps: MissionDeps,
  orgId: string,
  machineId: string | null,
  asked?: MissionExecutor | null,
) {
  if (!machineId) {
    throw new ConflictError("Missions run on a connected computer, and this agent has none", "mission.no_computer");
  }
  const status = await hubOf(deps).status(machineId);
  if (!status || status.orgId !== orgId) {
    throw new ConflictError("The agent's computer was removed", "mission.no_computer");
  }
  if (!status.execAllowed) {
    throw new ConflictError(`Commands are turned off on ${status.name}`, "mission.exec_disabled", {
      computer: status.name,
    });
  }
  const { available, codexTooOld } = machineExecutors(status);
  if (available.length === 0 || (asked && asked !== "agent" && status.protocol < MISSION_PROTOCOL)) {
    throw new ConflictError(
      `The runner on ${status.name} is too old for missions: run agentes-runner update`,
      "mission.runner_outdated",
      { computer: status.name },
    );
  }
  if (asked && !available.includes(asked)) {
    throw new ConflictError(
      asked === "codex" && codexTooOld
        ? `Codex on ${status.name} is too old for missions (needs ${CODEX_MIN_VERSION} or later): update it there`
        : `${asked === "codex" ? "Codex" : "Claude Code"} isn't installed on ${status.name}`,
      asked === "codex" && codexTooOld ? "mission.executor_outdated" : "mission.executor_unavailable",
      { computer: status.name, executor: asked, ...(asked === "codex" ? { minVersion: CODEX_MIN_VERSION } : {}) },
    );
  }
  if (!status.online) {
    throw new ConflictError(`The computer ${status.name} is offline`, "mission.computer_offline", {
      computer: status.name,
    });
  }
  return { ...status, executor: asked ?? defaultExecutor(available) };
}

export interface ProposeInput {
  orgId: string;
  agentId: string;
  /** The person who asked (the owner). */
  ownerId: string;
  channelId: string;
  threadRootId: string;
  title: string;
  goal: string;
  /** The repository on the machine, relative to the agent's folder. */
  repoDir?: string | null;
  /** Who programs: default Claude Code when the computer has it, else our agent. */
  executor?: MissionExecutor | null;
  /** Default: the agent's (`agents.mission_command_approval`), else `low_risk_auto`. */
  commandApproval?: CommandApproval | null;
  runId?: string | null;
}

const cleanRepoDir = (dir: string | null | undefined) => {
  const d = (dir ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\/+/, "")
    .replace(/\/+$/, "");
  if (d.startsWith("/") || /^[a-zA-Z]:/.test(d) || d.split("/").includes("..")) {
    throw new ValidationError("The folder must be inside the agent's folder", "mission.bad_folder");
  }
  return d.slice(0, MISSION_LIMITS.repoDir);
};

/**
 * Proposes a mission (status `proposed`): the row, the home thread's row,
 * the main session started on the machine in plan mode, and the plan card
 * in the thread (`meta.missionPlan`; the web shows Start / Change something).
 */
export async function proposeMission(deps: MissionDeps, input: ProposeInput) {
  const { db } = deps;
  const title = oneLine(clean(input.title, MISSION_LIMITS.title), MISSION_LIMITS.title);
  const goal = clean(input.goal, MISSION_LIMITS.goal);
  if (!title || !goal) throw new ValidationError("A mission needs a title and a goal", "mission.invalid");
  const agent = await getAgentCached(db, input.orgId, input.agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  if (input.executor != null && !isMissionExecutor(input.executor)) {
    throw new ValidationError("Choose claude, codex or agent", "mission.invalid_executor");
  }
  if (input.commandApproval != null && !isCommandApproval(input.commandApproval)) {
    throw new ValidationError("Choose always, low_risk_auto or never", "mission.invalid_command_approval");
  }
  const machine = await usableMachine(deps, input.orgId, agent.machineId ?? null, input.executor ?? null);
  const existing = await missionOfThread(db, input.orgId, input.threadRootId);
  if (existing) throw new ConflictError("This thread already has a mission", "mission.exists");
  const [paired] = await db
    .select({ pairedBy: machines.pairedByUserId })
    .from(machines)
    .where(eq(machines.id, machine.id));
  const repoDir = cleanRepoDir(input.repoDir);
  const mission = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(missions)
      .values({
        orgId: input.orgId,
        threadRootId: input.threadRootId,
        channelId: input.channelId,
        agentId: input.agentId,
        ownerId: input.ownerId,
        machineId: machine.id,
        // The computer is someone else's (the agent's): they lend it to this mission.
        machineLentBy: paired?.pairedBy && paired.pairedBy !== input.ownerId ? paired.pairedBy : null,
        executor: machine.executor,
        title,
        goal,
        mainSessionId: crypto.randomUUID(),
        repoDir,
        // Asked for, else the agent's default for new missions.
        commandApproval: input.commandApproval ?? agentMissionApproval(agent),
        createdBy: input.ownerId,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new ConflictError("This thread already has a mission", "mission.exists");
    // Missions are threads with state: the row exists (lists, the run's context lookup).
    await tx
      .insert(threads)
      .values({
        orgId: input.orgId,
        channelId: input.channelId,
        rootMessageId: input.threadRootId,
        title,
        createdBy: input.ownerId,
      })
      .onConflictDoNothing({ target: [threads.orgId, threads.rootMessageId] });
    await tx
      .update(threads)
      .set({ title, updatedAt: new Date() })
      .where(and(eq(threads.orgId, input.orgId), eq(threads.rootMessageId, input.threadRootId), isNull(threads.title)));
    await recordMissionEvent(tx, row, "proposed", { by: input.ownerId, title });
    await recordAudit(tx, {
      orgId: input.orgId,
      actor: { type: "person", id: input.ownerId },
      action: "mission.proposed",
      target: { type: "mission", id: row.id },
      details: { title, agentId: input.agentId, machineId: machine.id, threadId: input.threadRootId },
    });
    return row;
  });
  const onEngine = missionsOnEngine(deps);
  if (mission.executor !== "agent" && !onEngine) {
    try {
      await startSessionTask(deps, mission, {
        title: `Plan: ${title}`,
        prompt: planPrompt(mission),
        sessionId: mission.mainSessionId,
        cwd: repoDir,
        resume: false,
        runId: input.runId ?? null,
      });
    } catch (error) {
      // Nothing started: no mission either.
      await db.delete(missions).where(eq(missions.id, mission.id));
      throw error;
    }
  }
  await postMissionMessage(deps, mission, `Plan for "${title}": ${goal}`, {
    missionPlan: { missionId: mission.id, title, goal, computer: machine.name, executor: mission.executor },
    bodyCode: "mission_plan",
    bodyParams: { title, computer: machine.name },
  });
  // Agent mode (and every brain on the engine): the agent itself explores (read only) and writes the plan, in the thread.
  if (mission.executor === "agent" || onEngine) {
    await wakeMissionAgent(
      deps,
      mission,
      mission.executor === "agent" ? agentPlanPrompt(mission) : planPrompt(mission),
      {
        from: "the mission",
        kind: "system",
        requestedBy: input.ownerId,
        freshSession: true,
      },
    );
  }
  await requestFilesSync(db, mission);
  await publishMissionEvent(deps, mission, "proposed");
  return mission;
}

/**
 * `/mission <goal>` from the web, or "Nova missão": the caller must be able
 * to talk to the agent (D31) in that conversation. In a thread, that thread
 * is the home; otherwise a new top-level message starts it.
 */
export async function createMission(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  input: {
    agentId: string;
    goal: string;
    title?: string | null;
    channelId?: string | null;
    threadId?: string | null;
    repoDir?: string | null;
    executor?: MissionExecutor | null;
    commandApproval?: CommandApproval | null;
  },
) {
  const { db } = deps;
  let channelId = input.channelId ?? null;
  let rootId = input.threadId ?? null;
  /** Someone else's thread: its author keeps a say (added as `decide`). */
  let rootAuthor: string | null = null;
  if (rootId) {
    const [found] = await db
      .select({ root: messages, createdBy: threads.createdBy })
      .from(messages)
      .leftJoin(threads, and(eq(threads.orgId, messages.orgId), eq(threads.rootMessageId, messages.id)))
      .where(and(eq(messages.id, rootId), eq(messages.orgId, orgId)));
    const root = found?.root;
    if (!root || root.threadId || root.deletedAt) throw new NotFoundError("Thread not found");
    channelId = root.channelId;
    const theirs = root.authorUserId === userId || found?.createdBy === userId;
    if (!theirs && root.authorUserId) rootAuthor = root.authorUserId;
  }
  if (!channelId) throw new ValidationError("Give the conversation (channelId) or the thread (threadId)");
  const { channel, membership } = await requireChannelAccess(db, userId, orgId, channelId);
  if (!can(membership.role, "post")) throw new ForbiddenError();
  if (channel.kind === "forum") throw new ValidationError("Forum topics have no missions", "mission.invalid");
  const allowed = await eligibleChannelAgents(db, orgId, channelId, [input.agentId], { requesterUserId: userId });
  if (allowed.length === 0) {
    throw new ForbiddenError(
      "This agent isn't in this conversation or doesn't answer you",
      "mission.agent_unavailable",
    );
  }
  const goal = clean(input.goal, MISSION_LIMITS.goal);
  const title = clean(input.title, MISSION_LIMITS.title) || autoThreadTitle(goal);
  if (!goal) throw new ValidationError("A mission needs a goal", "mission.invalid");
  if (!rootId) {
    // The home: a new top-level message by the person (written directly: it routes to no agent).
    const [root] = await db
      .insert(messages)
      .values({
        id: Bun.randomUUIDv7(),
        orgId,
        channelId,
        authorType: "person",
        authorUserId: userId,
        body: goal,
        meta: { missionStart: { title } },
      })
      .returning();
    if (!root) throw new Error("mission root insert returned nothing");
    if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(root));
    rootId = root.id;
  }
  const mission = await proposeMission(deps, {
    orgId,
    agentId: input.agentId,
    ownerId: userId,
    channelId,
    threadRootId: rootId,
    title,
    goal,
    repoDir: input.repoDir,
    executor: input.executor ?? null,
    commandApproval: input.commandApproval ?? null,
  });
  // A mission made in someone else's thread: whoever started that thread decides too (when the agent answers them).
  if (rootAuthor && (await agentAnswers(db, mission, rootAuthor))) {
    await db
      .insert(missionParticipants)
      .values({ orgId, missionId: mission.id, userId: rootAuthor, role: "decide", addedBy: userId })
      .onConflictDoNothing();
    await recordMissionEvent(db, mission, "participant_added", { by: userId, userId: rootAuthor, role: "decide" });
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: userId },
      action: "mission.participant_added",
      target: { type: "mission", id: mission.id },
      details: { userId: rootAuthor, role: "decide", reason: "thread_author" },
    });
  }
  return viewFor(deps, mission, userId, can(membership.role, "manage_members"));
}

/** A DM is flat: its mission gets a thread of its own, started from the message that asked. */
export async function homeThreadForDm(
  deps: MissionDeps,
  userId: string,
  input: { orgId: string; channelId: string; messageId: string; title: string },
) {
  const thread = await createThreadFromRange({ db: deps.db, pubsub: deps.pubsub }, userId, {
    orgId: input.orgId,
    channelId: input.channelId,
    firstMessageId: input.messageId,
    lastMessageId: input.messageId,
    title: input.title,
  });
  return thread.id;
}

// ── Sessions on the machine ──────────────────────────────────────────────────

const ACTIVE_TASK: MachineTaskRow["status"][] = ["queued", "running", "interrupted"];

/** Starts (or resumes) one executor session of the mission as a machine task. */
export async function startSessionTask(
  deps: MissionDeps,
  mission: MissionRow,
  input: {
    title: string;
    prompt: string;
    sessionId: string;
    cwd: string;
    resume: boolean;
    branch?: string | null;
    runId?: string | null;
    requestedBy?: string | null;
  },
) {
  const hub = hubOf(deps);
  if (!mission.machineId) throw new ConflictError("This mission has no computer", "mission.needs_computer");
  const status = await hub.status(mission.machineId);
  if (!status || status.orgId !== mission.orgId) {
    throw new ConflictError("The mission's computer was removed", "mission.needs_computer");
  }
  const agent = await getAgentCached(deps.db, mission.orgId, mission.agentId);
  return startMachineTask(
    { db: deps.db, pubsub: deps.pubsub, call: hub.call },
    {
      orgId: mission.orgId,
      agent: { id: mission.agentId, handle: agent?.handle ?? "agent" },
      machineId: mission.machineId,
      protocol: status.protocol,
      machineName: status.name,
      channelId: mission.channelId,
      threadRootId: mission.threadRootId,
      runId: input.runId ?? null,
      requestedByUserId: input.requestedBy ?? mission.ownerId,
      title: input.title,
      executor: mission.executor === "codex" ? "codex" : "claude",
      prompt: input.prompt,
      sessionId: input.sessionId,
      resume: input.resume,
      cwd: input.cwd || null,
      branch: input.branch ?? null,
      mission: {
        id: mission.id,
        rules: MISSION_RULES,
        // Before Start the executor only reads; after it, it works on the mission's branches (runner protocol 7).
        mode: mission.status === "proposed" ? "plan" : "work",
        branchPrefix: missionBranchPrefix(mission.id),
        // Commands a person allowed for the whole mission ("Aprovar sempre nesta missão").
        allow: await missionAllowRules(deps.db, mission.id),
      },
    },
  );
}

/** The latest task of a session (where it runs, whether it still does). */
export async function sessionTask(db: Executor, missionId: string, sessionId: string) {
  const [row] = await db
    .select()
    .from(machineTasks)
    .where(and(eq(machineTasks.missionId, missionId), eq(machineTasks.sessionId, sessionId)))
    .orderBy(desc(machineTasks.createdAt))
    .limit(1);
  return row ?? null;
}

const isLive = (t: MachineTaskRow | null) => Boolean(t && ACTIVE_TASK.includes(t.status) && !t.endedAt);
/** Whether a session's latest task still holds it (queued, running, or interrupted and may come back). */
export const isLiveTask = isLive;

export async function queueForSession(db: Executor, mission: MissionRow, entry: schema.MissionInboxEntry) {
  await db
    .update(missions)
    .set({
      inbox: sql`(case when jsonb_array_length(${missions.inbox}) >= ${MISSION_LIMITS.inbox}
        then ${missions.inbox} - 0 else ${missions.inbox} end) || ${JSON.stringify([entry])}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(missions.id, mission.id));
}

/**
 * Tells a session something: it is resumed on the machine with the text as
 * its prompt. When it can't hear now (its task runs, the mission is paused,
 * the computer is offline or full) the text waits in the inbox. Returns
 * whether it went out now.
 */
export async function tellSession(
  deps: MissionDeps,
  mission: MissionRow,
  target: { sessionId: string; cwd?: string | null },
  text: string,
  options: {
    title?: string;
    requestedBy?: string | null;
    from?: string;
    kind?: WakeKind;
    /** The answer to a blocking call (decision, review): on the engine, the paused run resumes with it. */
    resume?: TellOptions["resume"];
  } = {},
): Promise<{ delivered: boolean; taskId?: string; runId?: string }> {
  if (!OPEN.includes(mission.status)) return { delivered: false };
  // A person's word is new work: a mission waiting to be concluded goes back to active. (The
  // mission's own notices, like an item's end, still reach the session without reopening it.)
  if (mission.status === "awaiting_close" && (options.requestedBy || options.kind === "person")) {
    mission = await reactivateMission(deps, mission, "message");
  }
  // Work on someone's computer only for people the agent answers (D31).
  if (options.requestedBy && !(await agentAnswers(deps.db, mission, options.requestedBy))) {
    throw new ForbiddenError("The mission's agent doesn't answer this person", "mission.agent_unavailable");
  }
  // Agent mode, and every brain on the engine: the main session is the agent's own runs in the home thread.
  // (Item sessions stay machine tasks, resumed below.)
  if (mission.executor === "agent" || (missionsOnEngine(deps) && target.sessionId === mission.mainSessionId)) {
    return wakeMissionAgent(deps, mission, text, {
      requestedBy: options.requestedBy ?? null,
      from: options.from ?? "the mission",
      kind: options.kind ?? (options.requestedBy ? "person" : "system"),
      ...(options.resume ? { resume: options.resume } : {}),
    });
  }
  const last = await sessionTask(deps.db, mission.id, target.sessionId);
  const cwd = target.cwd ?? last?.cwd ?? mission.repoDir;
  const entry = {
    sessionId: target.sessionId,
    cwd: cwd ?? "",
    text: text.slice(0, MISSION_LIMITS.sendText),
    at: new Date().toISOString(),
  };
  // The main session may talk while the plan is only proposed; everything else waits for an active mission.
  const canTalk =
    mission.status === "active" ||
    mission.status === "awaiting_close" ||
    (mission.status === "proposed" && target.sessionId === mission.mainSessionId);
  if (!canTalk || isLive(last)) {
    await queueForSession(deps.db, mission, entry);
    return { delivered: false };
  }
  try {
    const row = await startSessionTask(deps, mission, {
      title:
        options.title ?? (target.sessionId === mission.mainSessionId ? mission.title : (last?.title ?? mission.title)),
      prompt: entry.text,
      sessionId: target.sessionId,
      cwd: entry.cwd,
      resume: true,
      requestedBy: options.requestedBy ?? null,
    });
    return { delivered: true, taskId: row.id };
  } catch (error) {
    if (
      error instanceof MachineOfflineError ||
      // Another resume of this session started at the same moment (one live task per session): wait for it.
      isUniqueViolation(error) ||
      (error instanceof MachineRequestError && ["no_slot", "timeout"].includes(error.code))
    ) {
      await queueForSession(deps.db, mission, entry);
      return { delivered: false };
    }
    throw error;
  }
}

/**
 * Why the agent wakes (agent mode): a person's message or answer (resets the
 * stuck guard), its own task's end, or anything else the mission says.
 */
export type WakeKind = "person" | "task" | "system";

/** Agent mode: whether the agent may be woken now (an active mission, or a proposed one being planned). */
const agentCanWork = (mission: Pick<MissionRow, "status" | "machineId">) =>
  Boolean(mission.machineId) &&
  (mission.status === "active" || mission.status === "awaiting_close" || mission.status === "proposed");

/**
 * Agent mode (ADR 0029, "Executor agent"): the mission's "main session" is
 * the agent's own runs in the home thread. Telling it something posts an
 * agent-facing notice there (`meta.missionInbox`, or a task's end as
 * `meta.machineTask`) and starts a run of the agent on it, or joins the run
 * already working in the thread. These wake-ups are hop 0: inside a mission
 * the agent's own tasks and inbox don't count toward the agent-to-agent
 * limit; its budget is the brake, plus the stuck-loop guard (5 wake-ups in a
 * row with no plan item changing state pause the mission). Paused, closed or
 * without a computer: the text stays in the inbox.
 */
export async function wakeMissionAgent(
  deps: MissionDeps,
  mission: MissionRow,
  text: string,
  options: {
    requestedBy?: string | null;
    from?: string;
    kind?: WakeKind;
    /** The notice's own body and meta (a task's end); default: the text as `meta.missionInbox`. */
    notice?: { body: string; meta: Record<string, unknown> };
    /** On the engine only: the answer to a paused call (missions-engine.ts). */
    resume?: TellOptions["resume"];
    /** On the engine only: the first turn of a new main session. */
    freshSession?: boolean;
  } = {},
): Promise<{ delivered: boolean; runId?: string }> {
  // On the engine every brain's main session is woken the same way (missions-engine.ts).
  if (missionsOnEngine(deps)) return tellMainOnEngine(deps, mission, text, options);
  const body = text.slice(0, MISSION_LIMITS.sendText);
  let fresh = (await getMissionRow(deps.db, mission.id)) ?? mission;
  if (!OPEN.includes(fresh.status)) return { delivered: false };
  if (fresh.status === "awaiting_close" && (options.requestedBy || options.kind === "person")) {
    fresh = await reactivateMission(deps, fresh, "message");
  }
  const entry = { sessionId: fresh.mainSessionId, cwd: fresh.repoDir, text: body, at: new Date().toISOString() };
  if (!agentCanWork(fresh)) {
    await queueForSession(deps.db, fresh, entry);
    return { delivered: false };
  }
  const kind = options.kind ?? "system";
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
    const started = answers ? await enqueueRunJob(tx, message, fresh.agentId) : { run: null, steered: null };
    return { message, ...started };
  });
  if (deps.pubsub) {
    await publishMessageCreated(deps.pubsub, messageView(out.message));
    if (out.run) {
      await publishChannelEvent(deps.pubsub, {
        type: "agent.thinking",
        channelId: fresh.channelId,
        threadId: fresh.threadRootId,
        agentId: fresh.agentId,
        runId: out.run.id,
      });
    }
  }
  await recordMissionEvent(deps.db, fresh, "agent_woken", {
    kind,
    messageId: out.message.id,
    runId: out.run?.id ?? out.steered,
  });
  const runId = out.run?.id ?? out.steered ?? undefined;
  return { delivered: Boolean(runId), ...(runId ? { runId } : {}) };
}

/**
 * The stuck-loop guard fired (agent mode): the mission pauses with a code
 * (`mission.paused_stuck`) and a notice asking the owner what to do.
 */
export async function pauseStuck(
  deps: MissionDeps,
  mission: MissionRow,
  reason: "no_progress" | "repeated_failure",
  detail: { title?: string } = {},
) {
  const [row] = await deps.db
    .update(missions)
    .set({ status: "paused", pausedAt: new Date(), idleWakeups: 0, updatedAt: new Date() })
    .where(and(eq(missions.id, mission.id), eq(missions.status, "active")))
    .returning();
  if (!row) return null;
  await recordMissionEvent(deps.db, row, "paused_stuck", { reason, ...detail });
  await recordAudit(deps.db, {
    orgId: row.orgId,
    actor: { type: "system", id: null },
    action: "mission.paused",
    target: { type: "mission", id: row.id },
    details: { code: "mission.paused_stuck", reason, ...detail },
  });
  const why =
    reason === "repeated_failure"
      ? `"${detail.title ?? "a task"}" failed ${MISSION_STUCK.failures} times in a row`
      : `I was woken ${MISSION_STUCK.idleWakeups} times without the plan moving`;
  await postMissionMessage(deps, row, `I paused the mission: ${why}. What should I do? Resume it to let me go on.`, {
    missionStuck: { missionId: row.id, reason, ...detail },
    bodyCode: reason === "repeated_failure" ? "mission_stuck_failure" : "mission_stuck_idle",
    bodyParams: {
      title: detail.title ?? "",
      count: String(reason === "repeated_failure" ? MISSION_STUCK.failures : MISSION_STUCK.idleWakeups),
    },
  });
  await publishMissionEvent(deps, row, "paused", { code: "mission.paused_stuck", reason });
  await notifyMissionEnded(deps, row, "mission_stopped", { type: "agent", id: row.agentId }, why).catch(() => {});
  if (row.ownerId) {
    await publishUserEvent(deps.pubsub, row.orgId, row.ownerId, {
      type: "mission.needs_you",
      kind: "stuck",
      missionId: row.id,
      threadId: row.threadRootId,
      code: "mission.paused_stuck",
    });
  }
  await requestFilesSync(deps.db, row);
  return row;
}

/**
 * Sends what waits in the inbox to the sessions that can hear now (one
 * resume per session, the texts together). Called when a mission task
 * ends, when the mission resumes and when its computer comes back.
 */
export async function deliverInbox(deps: MissionDeps, missionId: string) {
  if (missionsOnEngine(deps)) return deliverInboxOnEngine(deps, missionId, deliverSessionsInbox);
  const mission = await getMissionRow(deps.db, missionId);
  if (!mission || mission.inbox.length === 0) return 0;
  if (mission.executor === "agent") return deliverAgentInbox(deps, mission);
  return deliverSessionsInbox(deps, mission);
}

/**
 * The executor sessions' inbox (one machine-task resume per session, the texts
 * together). `except`: a session delivered elsewhere (on the engine, the main one).
 */
export async function deliverSessionsInbox(deps: MissionDeps, mission: MissionRow, except?: string) {
  if (!deps.hub) return 0;
  const bySession = new Map<string, schema.MissionInboxEntry[]>();
  for (const e of mission.inbox) {
    if (e.sessionId === except) continue;
    bySession.set(e.sessionId, [...(bySession.get(e.sessionId) ?? []), e]);
  }
  let sent = 0;
  for (const [sessionId, entries] of bySession) {
    const canTalk =
      mission.status === "active" ||
      mission.status === "awaiting_close" ||
      (mission.status === "proposed" && sessionId === mission.mainSessionId);
    if (!canTalk) continue;
    if (isLive(await sessionTask(deps.db, mission.id, sessionId))) continue;
    // Claim these entries first (another delivery may run at the same time).
    const ats = entries.map((e) => e.at);
    const [claimed] = await deps.db
      .update(missions)
      .set({
        inbox: sql`coalesce((select jsonb_agg(x.value) from jsonb_array_elements(${missions.inbox}) x
          where not (x.value->>'sessionId' = ${sessionId}
            and x.value->>'at' = any(${`{${ats.join(",")}}`}::text[]))), '[]'::jsonb)`,
      })
      .where(
        and(
          eq(missions.id, mission.id),
          sql`exists (select 1 from jsonb_array_elements(${missions.inbox}) x
            where x.value->>'sessionId' = ${sessionId} and x.value->>'at' = ${ats[0] as string})`,
        ),
      )
      .returning({ id: missions.id });
    if (!claimed) continue;
    const text = entries.map((e) => e.text).join("\n\n");
    const fresh = (await getMissionRow(deps.db, mission.id)) ?? mission;
    const out = await tellSession(deps, fresh, { sessionId, cwd: entries.at(-1)?.cwd ?? null }, text).catch(
      async () => {
        for (const e of entries) await queueForSession(deps.db, fresh, e);
        return { delivered: false };
      },
    );
    if (out.delivered) sent++;
  }
  return sent;
}

/** Agent mode: everything waiting goes to the agent at once (one notice, one run or steer). */
async function deliverAgentInbox(deps: MissionDeps, mission: MissionRow) {
  if (!agentCanWork(mission) || (mission.status !== "active" && mission.status !== "awaiting_close")) return 0;
  const [claimed] = await deps.db
    .update(missions)
    .set({ inbox: [] })
    .where(and(eq(missions.id, mission.id), sql`jsonb_array_length(${missions.inbox}) > 0`))
    .returning({ id: missions.id });
  if (!claimed) return 0;
  const text = mission.inbox.map((e) => e.text).join("\n\n");
  const out = await wakeMissionAgent(deps, mission, text, { from: "the mission", kind: "system" }).catch(async () => {
    for (const e of mission.inbox) await queueForSession(deps.db, mission, e);
    return { delivered: false };
  });
  return out.delivered ? 1 : 0;
}

/** What people (or the agent) send to the mission: to its main session. */
export async function sendToMainSession(
  deps: MissionDeps,
  mission: MissionRow,
  text: string,
  from: { name: string; userId?: string | null },
) {
  const body = clean(text, MISSION_LIMITS.sendText);
  if (!body) throw new ValidationError("Nothing to send", "mission.invalid");
  const out = await tellSession(
    deps,
    mission,
    { sessionId: mission.mainSessionId, cwd: mission.repoDir },
    `Message from ${from.name}: ${body}`,
    {
      requestedBy: from.userId ?? null,
      from: from.name,
      kind: from.userId ? "person" : "system",
    },
  );
  await recordMissionEvent(deps.db, mission, "sent_to_main", { by: from.userId ?? null, delivered: out.delivered });
  return out;
}

/** `POST …/missions/{id}/messages`: the owner or a decider talks to the main session ("Mudar algo"). */
export async function sendMissionMessage(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  missionId: string,
  text: string,
) {
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "send work to the computer");
  requireOpen(mission);
  const out = await sendToMainSession(deps, mission, text, { name: await nameOf(deps.db, userId), userId });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "mission.message_sent",
    target: { type: "mission", id: mission.id },
    details: { delivered: out.delivered, chars: text.length },
  });
  return out;
}

// ── Controls ─────────────────────────────────────────────────────────────────

async function setStatus(
  deps: MissionDeps,
  mission: MissionRow,
  actorId: string,
  from: MissionStatus[],
  patch: Partial<MissionRow>,
  action: string,
) {
  const [row] = await deps.db
    .update(missions)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(missions.id, mission.id), inArray(missions.status, from)))
    .returning();
  if (!row)
    throw new ConflictError(`The mission is ${mission.status}`, "mission.wrong_status", { status: mission.status });
  await recordMissionEvent(deps.db, row, action.replace("mission.", ""), { by: actorId });
  await recordAudit(deps.db, {
    orgId: row.orgId,
    actor: { type: "person", id: actorId },
    action,
    target: { type: "mission", id: row.id },
    details: { from: mission.status, to: row.status },
  });
  return row;
}

/** "Começar": only the owner starts a proposed mission; the main session proceeds. */
export async function startMission(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const { mission, role, isAdmin } = await requireMission(deps, userId, orgId, missionId);
  if (role !== "owner") throw new ForbiddenError("Only the mission's owner can start it", "mission.not_owner");
  const row = await setStatus(
    deps,
    mission,
    userId,
    ["proposed"],
    { status: "active", startedAt: new Date() },
    "mission.started",
  );
  await tellSession(
    deps,
    row,
    { sessionId: row.mainSessionId, cwd: row.repoDir },
    row.executor === "agent" ? AGENT_START_PROMPT : START_PROMPT,
    { requestedBy: userId, from: await nameOf(deps.db, userId), kind: "person" },
  );
  await requestFilesSync(deps.db, row);
  await publishMissionEvent(deps, row, "started");
  return viewFor(deps, (await getMissionRow(deps.db, row.id)) ?? row, userId, isAdmin);
}

/** Pause: no new work starts for it (running tasks go on; `/stop` stops them). */
export async function pauseMission(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const { mission, role, isAdmin } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "pause it");
  const row = await setStatus(
    deps,
    mission,
    userId,
    ["active", "awaiting_close"],
    { status: "paused", pausedAt: new Date() },
    "mission.paused",
  );
  // Agent mode: nothing of the mission keeps running on the computer while it is paused.
  if (row.executor === "agent") await cancelMissionTasks(deps, row, userId);
  await requestFilesSync(deps.db, row);
  await publishMissionEvent(deps, row, "paused");
  return viewFor(deps, row, userId, isAdmin);
}

export async function resumeMission(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const { mission, role, isAdmin } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "resume it");
  const [view] = await missionViews(deps.db, [mission], userId, isAdmin);
  if (view?.needsComputer) {
    throw new ConflictError("The mission needs a computer: its owner sets one first", "mission.needs_computer");
  }
  const row = await setStatus(
    deps,
    mission,
    userId,
    ["paused"],
    { status: "active", pausedAt: null, idleWakeups: 0 },
    "mission.resumed",
  );
  await deliverInbox(deps, row.id);
  await requestFilesSync(deps.db, row);
  await scheduleDoneCheck(deps.db, row);
  await publishMissionEvent(deps, row, "resumed");
  return viewFor(deps, (await getMissionRow(deps.db, row.id)) ?? row, userId, isAdmin);
}

/** Cancels the mission's running tasks on the machine (the person's `/stop`, or closing). */
async function cancelMissionTasks(deps: MissionDeps, mission: MissionRow, actorId: string) {
  const rows = await deps.db
    .select()
    .from(machineTasks)
    .where(
      and(
        eq(machineTasks.missionId, mission.id),
        inArray(machineTasks.status, ACTIVE_TASK),
        isNull(machineTasks.endedAt),
      ),
    );
  const agent = await getAgentCached(deps.db, mission.orgId, mission.agentId);
  let canceled = 0;
  for (const row of rows) {
    await deps.db
      .update(machineTasks)
      .set({ canceledBy: actorId, updatedAt: new Date() })
      .where(eq(machineTasks.id, row.id));
    let reply: { canceled: boolean } | null = null;
    try {
      reply = deps.hub
        ? await deps.hub.call<"task.cancel">(row.machineId, {
            agent: { id: mission.agentId, handle: agent?.handle ?? "agent" },
            op: "task.cancel",
            taskId: row.id,
          })
        : null;
    } catch (error) {
      if (!(error instanceof MachineOfflineError) && !(error instanceof MachineRequestError)) throw error;
    }
    if (!reply?.canceled) {
      // Offline, or the runner no longer has it: it won't come back.
      const [ended] = await deps.db
        .update(machineTasks)
        .set({ status: "canceled", endedAt: new Date(), wokeAt: new Date(), updatedAt: new Date() })
        .where(and(eq(machineTasks.id, row.id), isNull(machineTasks.endedAt)))
        .returning();
      if (ended) await publishTaskEvent(deps.pubsub, ended);
    }
    canceled++;
  }
  return canceled;
}

/** `/stop`: the running tasks are canceled and the mission pauses (resume to go on). */
export async function stopMission(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const { mission, role, isAdmin } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "stop it");
  requireOpen(mission);
  // On the engine the main session is a run: it stops too.
  if (missionsOnEngine(deps)) await cancelMainRuns(deps, mission, userId, "stopped");
  const canceled = await cancelMissionTasks(deps, mission, userId);
  const row =
    mission.status === "active" || mission.status === "awaiting_close"
      ? await setStatus(
          deps,
          mission,
          userId,
          ["active", "awaiting_close"],
          { status: "paused", pausedAt: new Date() },
          "mission.stopped",
        )
      : mission;
  if (row === mission) {
    await recordMissionEvent(deps.db, mission, "stopped", { by: userId });
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: userId },
      action: "mission.stopped",
      target: { type: "mission", id: mission.id },
      details: { canceled },
    });
  }
  await publishMissionEvent(deps, row, "stopped", { canceled });
  await notifyMissionEnded(deps, row, "mission_stopped", { type: "user", id: userId }).catch(() => {});
  return { ...(await viewFor(deps, row, userId, isAdmin)), canceledTasks: canceled };
}

/**
 * Closes a mission as done or canceled (its owner or an admin). Running
 * tasks are canceled. `saveToWiki`: a page "<title>: decisions and lessons"
 * from the decisions taken and the executor's last notes.
 */
export async function closeMission(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  missionId: string,
  input: { outcome: "done" | "canceled"; saveToWiki?: boolean; note?: string | null },
) {
  const { mission, role, isAdmin } = await requireMission(deps, userId, orgId, missionId);
  if (role !== "owner" && !isAdmin) {
    throw new ForbiddenError("Only the mission's owner or an admin can close it", "mission.not_owner");
  }
  requireOpen(mission);
  return concludeMission(deps, mission, userId, isAdmin, input);
}

/**
 * Closing itself, once the caller may (the owner or an admin on "Fechar
 * missão"; also a decider concluding a delivery): tasks canceled, the status,
 * the optional wiki page, the files and the event.
 */
export async function concludeMission(
  deps: MissionDeps,
  mission: MissionRow,
  userId: string,
  isAdmin: boolean,
  input: { outcome: "done" | "canceled"; saveToWiki?: boolean; note?: string | null },
) {
  const orgId = mission.orgId;
  if (missionsOnEngine(deps)) await cancelMainRuns(deps, mission, userId, "closed");
  await cancelMissionTasks(deps, mission, userId);
  const note = clean(input.note, 500);
  let row = await setStatus(
    deps,
    mission,
    userId,
    OPEN,
    {
      status: input.outcome,
      closedAt: new Date(),
      closedBy: userId,
      closeReason: note ? `${input.outcome}: ${note}` : input.outcome,
      inbox: [],
    },
    "mission.closed",
  );
  if (input.saveToWiki) {
    const page = await createWikiPage(
      { db: deps.db, pubsub: deps.pubsub },
      { type: "person", userId },
      orgId,
      {
        // Wiki titles can't hold [ ] | # (and / would make a folder).
        title: `${row.title.replace(/[[\]|#/]/g, " ")}: decisions and lessons`.slice(0, 200),
        body: await lessonsPage(deps.db, row),
        note: "From the mission",
        source: { type: "mission", id: row.id, channelId: row.channelId },
      },
      { allowDuplicate: true },
    );
    const [linked] = await deps.db
      .update(missions)
      .set({ wikiPageId: page.id })
      .where(eq(missions.id, row.id))
      .returning();
    if (linked) row = linked;
    await recordMissionEvent(deps.db, row, "saved_to_wiki", { pageId: page.id });
  }
  await requestFilesSync(deps.db, row);
  await publishMissionEvent(deps, row, "closed", { outcome: input.outcome });
  await notifyMissionEnded(
    deps,
    row,
    input.outcome === "done" ? "mission_finished" : "mission_stopped",
    { type: "user", id: userId },
    note,
  ).catch(() => {});
  return viewFor(deps, row, userId, isAdmin);
}

/** The wiki page of a closed mission: goal, what was decided and why, the executor's notes. */
async function lessonsPage(db: Database, mission: MissionRow) {
  const [decisions, notes, plan] = await Promise.all([
    db
      .select()
      .from(missionDecisions)
      .where(
        and(eq(missionDecisions.missionId, mission.id), inArray(missionDecisions.status, ["taken", "provisional"])),
      )
      .orderBy(asc(missionDecisions.createdAt)),
    db
      .select({ content: missionFiles.content })
      .from(missionFiles)
      .where(and(eq(missionFiles.missionId, mission.id), eq(missionFiles.name, "notes.md"))),
    latestPlan(db, mission.id),
  ]);
  const names = await namesOf(
    db,
    decisions.map((d) => d.chosenBy),
  );
  return [
    `Mission "${mission.title}" (${mission.status}).`,
    "",
    "## Goal",
    mission.goal,
    "",
    "## Decisions",
    ...(decisions.length
      ? decisions.map(
          (d) =>
            `- **${d.question}** → ${d.chosen ?? "?"}${d.status === "provisional" ? " (provisional)" : ""}${
              d.chosenBy ? ` (by ${names.get(d.chosenBy) ?? "someone"})` : ""
            }${d.why ? `. Why: ${d.why}` : ""}`,
        )
      : ["- None recorded."]),
    "",
    "## Plan at the end",
    ...(plan?.items.length ? plan.items.map((i) => `- ${planMark(i.status)} ${i.title}`) : ["- No plan."]),
    "",
    "## Notes and lessons",
    notes[0]?.content?.trim() || "No notes from the executor.",
  ].join("\n");
}

// ── Participants and ownership ───────────────────────────────────────────────

export async function listParticipants(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const { mission } = await requireMission(deps, userId, orgId, missionId);
  const rows = await deps.db
    .select({
      userId: missionParticipants.userId,
      role: missionParticipants.role,
      addedBy: missionParticipants.addedBy,
      createdAt: missionParticipants.createdAt,
      name: users.name,
    })
    .from(missionParticipants)
    .innerJoin(users, eq(users.id, missionParticipants.userId))
    .where(eq(missionParticipants.missionId, mission.id))
    .orderBy(asc(missionParticipants.createdAt));
  const owner = mission.ownerId ? await nameOf(deps.db, mission.ownerId) : null;
  return {
    owner: mission.ownerId ? { userId: mission.ownerId, name: owner ?? "" } : null,
    participants: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
  };
}

async function requireManage(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const found = await requireMission(deps, userId, orgId, missionId);
  if (found.role !== "owner" && !found.isAdmin) {
    throw new ForbiddenError("Only the mission's owner or an admin can change who takes part", "mission.not_owner");
  }
  requireOpen(found.mission);
  return found;
}

/** A participant must be able to read the home conversation (seeing is inherited). */
async function requireSeesHome(db: Database, orgId: string, mission: MissionRow, userId: string) {
  await requireChannelAccess(db, userId, orgId, mission.channelId).catch(() => {
    throw new ValidationError("This person can't see the mission's conversation", "mission.participant_cannot_see");
  });
}

export async function setParticipant(
  deps: MissionDeps,
  actorId: string,
  orgId: string,
  missionId: string,
  input: { userId: string; role: "decide" | "comment" },
) {
  const { mission } = await requireManage(deps, actorId, orgId, missionId);
  if (input.userId === mission.ownerId)
    throw new ValidationError("The owner already does everything", "mission.is_owner");
  await requireSeesHome(deps.db, orgId, mission, input.userId);
  // Deciding makes work run on someone's computer: only for people the agent answers (D31).
  if (input.role === "decide" && !(await agentAnswers(deps.db, mission, input.userId))) {
    throw new ValidationError("The mission's agent doesn't answer this person", "mission.agent_unavailable");
  }
  const before = await missionRole(deps.db, mission, input.userId);
  await deps.db
    .insert(missionParticipants)
    .values({ orgId, missionId: mission.id, userId: input.userId, role: input.role, addedBy: actorId })
    .onConflictDoUpdate({
      target: [missionParticipants.missionId, missionParticipants.userId],
      set: { role: input.role },
    });
  // Added by hand: a request to join from them is answered by that.
  await deps.db
    .update(missionJoinRequests)
    .set({ status: "accepted", role: input.role, decidedBy: actorId, decidedAt: new Date() })
    .where(
      and(
        eq(missionJoinRequests.missionId, mission.id),
        eq(missionJoinRequests.userId, input.userId),
        eq(missionJoinRequests.status, "pending"),
      ),
    );
  const action = before === "none" ? "mission.participant_added" : "mission.participant_role_changed";
  await recordMissionEvent(deps.db, mission, action.replace("mission.", ""), {
    by: actorId,
    userId: input.userId,
    role: input.role,
  });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action,
    target: { type: "mission", id: mission.id },
    details: { userId: input.userId, role: input.role, before },
  });
  await requestFilesSync(deps.db, mission);
  await publishMissionEvent(deps, mission, "participants");
  return listParticipants(deps, actorId, orgId, missionId);
}

export async function removeParticipant(
  deps: MissionDeps,
  actorId: string,
  orgId: string,
  missionId: string,
  userId: string,
) {
  const found = await requireMission(deps, actorId, orgId, missionId);
  // Leaving by oneself is always allowed.
  if (actorId !== userId && found.role !== "owner" && !found.isAdmin) {
    throw new ForbiddenError("Only the mission's owner or an admin can change who takes part", "mission.not_owner");
  }
  const removed = await deps.db
    .delete(missionParticipants)
    .where(and(eq(missionParticipants.missionId, found.mission.id), eq(missionParticipants.userId, userId)))
    .returning({ id: missionParticipants.id });
  if (removed.length === 0) throw new NotFoundError("Not a participant", "mission.not_participant");
  await recordMissionEvent(deps.db, found.mission, "participant_removed", { by: actorId, userId });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "mission.participant_removed",
    target: { type: "mission", id: found.mission.id },
    details: { userId },
  });
  await requestFilesSync(deps.db, found.mission);
  await publishMissionEvent(deps, found.mission, "participants");
}

// ── Requests to join ─────────────────────────────────────────────────────────

export interface JoinRequestView {
  id: string;
  missionId: string;
  userId: string;
  name: string;
  status: "pending" | "accepted" | "declined";
  role: "decide" | "comment" | null;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

/** Who answers requests to join: the owner and the deciders. */
async function answerers(db: Executor, mission: MissionRow) {
  const rows = await db
    .select({ userId: missionParticipants.userId })
    .from(missionParticipants)
    .where(and(eq(missionParticipants.missionId, mission.id), eq(missionParticipants.role, "decide")));
  return [...new Set([...(mission.ownerId ? [mission.ownerId] : []), ...rows.map((r) => r.userId)])];
}

/**
 * "Pedir para participar": someone who sees the mission and takes no part
 * asks to join. Nothing is posted in the thread; the owner and the deciders
 * get `mission.needs_you` (`kind: join_request`). Asking again while a
 * request waits returns that request.
 */
export async function requestToJoin(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  requireOpen(mission);
  if (role !== "none") throw new ConflictError("You already take part in this mission", "mission.already_participant");
  const [inserted] = await deps.db
    .insert(missionJoinRequests)
    .values({ orgId, missionId: mission.id, userId })
    .onConflictDoNothing()
    .returning();
  if (inserted) {
    await recordMissionEvent(deps.db, mission, "join_requested", { userId });
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: userId },
      action: "mission.join_requested",
      target: { type: "mission", id: mission.id },
      details: {},
    });
    for (const to of await answerers(deps.db, mission)) {
      await publishUserEvent(deps.pubsub, orgId, to, {
        type: "mission.needs_you",
        kind: "join_request",
        missionId: mission.id,
        threadId: mission.threadRootId,
        userId,
      });
    }
    await publishMissionEvent(deps, mission, "join_requests");
  }
  const [row] = await deps.db
    .select()
    .from(missionJoinRequests)
    .where(
      and(
        eq(missionJoinRequests.missionId, mission.id),
        eq(missionJoinRequests.userId, userId),
        eq(missionJoinRequests.status, "pending"),
      ),
    );
  if (!row) throw new ConflictError("The request was answered already", "mission.join_decided");
  return joinView(row, await nameOf(deps.db, userId));
}

const joinView = (r: typeof missionJoinRequests.$inferSelect, name: string): JoinRequestView => ({
  id: r.id,
  missionId: r.missionId,
  userId: r.userId,
  name,
  status: r.status,
  role: r.role,
  decidedBy: r.decidedBy,
  decidedAt: iso(r.decidedAt),
  createdAt: r.createdAt.toISOString(),
});

/** Pending requests (the owner and deciders see all; anyone else only their own). */
export async function listJoinRequests(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  const rows = await deps.db
    .select()
    .from(missionJoinRequests)
    .where(
      and(
        eq(missionJoinRequests.missionId, mission.id),
        eq(missionJoinRequests.status, "pending"),
        mayAct(role) ? undefined : eq(missionJoinRequests.userId, userId),
      ),
    )
    .orderBy(asc(missionJoinRequests.createdAt))
    .limit(100);
  const names = await namesOf(
    deps.db,
    rows.map((r) => r.userId),
  );
  return rows.map((r) => joinView(r, names.get(r.userId) ?? ""));
}

/** Accept (with a role: the person becomes a participant) or decline; the owner's and deciders'. */
export async function decideJoinRequest(
  deps: MissionDeps,
  actorId: string,
  orgId: string,
  missionId: string,
  userId: string,
  input: { outcome: "accepted" | "declined"; role?: "decide" | "comment" },
) {
  const { mission, role } = await requireMission(deps, actorId, orgId, missionId);
  requireAct(role, "answer requests to join");
  requireOpen(mission);
  const given = input.outcome === "accepted" ? (input.role ?? "comment") : null;
  if (given) await requireSeesHome(deps.db, orgId, mission, userId);
  if (given === "decide" && !(await agentAnswers(deps.db, mission, userId))) {
    throw new ValidationError("The mission's agent doesn't answer this person", "mission.agent_unavailable");
  }
  const row = await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(missionJoinRequests)
      .set({ status: input.outcome, role: given, decidedBy: actorId, decidedAt: new Date() })
      .where(
        and(
          eq(missionJoinRequests.missionId, mission.id),
          eq(missionJoinRequests.userId, userId),
          eq(missionJoinRequests.status, "pending"),
        ),
      )
      .returning();
    if (!updated) throw new NotFoundError("No request to join from this person", "mission.join_not_found");
    if (given && userId !== mission.ownerId) {
      await tx
        .insert(missionParticipants)
        .values({ orgId, missionId: mission.id, userId, role: given, addedBy: actorId })
        .onConflictDoUpdate({
          target: [missionParticipants.missionId, missionParticipants.userId],
          set: { role: given },
        });
    }
    await recordMissionEvent(tx, mission, `join_${input.outcome}`, { by: actorId, userId, role: given });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: `mission.join_${input.outcome}`,
      target: { type: "mission", id: mission.id },
      details: { userId, role: given },
    });
    return updated;
  });
  if (given) await requestFilesSync(deps.db, mission);
  await publishUserEvent(deps.pubsub, orgId, userId, {
    type: "mission.join_answered",
    missionId: mission.id,
    threadId: mission.threadRootId,
    status: input.outcome,
    role: given,
  });
  await publishMissionEvent(deps, mission, given ? "participants" : "join_requests");
  return joinView(row, await nameOf(deps.db, userId));
}

/**
 * Hands the mission to another person. The computer doesn't move: the new
 * owner's own machine keeps it going, or the previous owner keeps lending
 * theirs (`lendMachine`); otherwise the mission pauses until the new owner
 * sets a computer (`mission.needs_computer`). The previous owner stays as
 * someone who can decide.
 */
export async function transferMission(
  deps: MissionDeps,
  actorId: string,
  orgId: string,
  missionId: string,
  input: { userId: string; lendMachine?: boolean },
) {
  const { mission, isAdmin } = await requireManage(deps, actorId, orgId, missionId);
  if (input.userId === mission.ownerId) throw new ValidationError("This person already owns it", "mission.is_owner");
  await requireSeesHome(deps.db, orgId, mission, input.userId);
  if (!(await agentAnswers(deps.db, mission, input.userId))) {
    throw new ValidationError("The mission's agent doesn't answer this person", "mission.agent_unavailable");
  }
  const [machine] = mission.machineId
    ? await deps.db
        .select({ pairedBy: machines.pairedByUserId })
        .from(machines)
        .where(eq(machines.id, mission.machineId))
    : [];
  const theirs = machine?.pairedBy === input.userId;
  // Only the computer's own person (who paired it, or who lends it now) can keep lending it.
  if (!theirs && input.lendMachine) {
    const lenderNow = mission.machineLentBy ?? machine?.pairedBy ?? null;
    if (actorId !== lenderNow && actorId !== machine?.pairedBy) {
      throw new ForbiddenError("Only the computer's owner can lend it", "mission.not_your_computer");
    }
  }
  const lender = theirs
    ? null
    : input.lendMachine
      ? (mission.machineLentBy ?? machine?.pairedBy ?? mission.ownerId)
      : null;
  const needsComputer = !theirs && !lender;
  const previous = mission.ownerId;
  const row = await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(missions)
      .set({
        ownerId: input.userId,
        machineLentBy: lender,
        ...(needsComputer && mission.status === "active" ? { status: "paused" as const, pausedAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(missions.id, mission.id))
      .returning();
    await tx
      .delete(missionParticipants)
      .where(and(eq(missionParticipants.missionId, mission.id), eq(missionParticipants.userId, input.userId)));
    if (previous) {
      await tx
        .insert(missionParticipants)
        .values({ orgId, missionId: mission.id, userId: previous, role: "decide", addedBy: actorId })
        .onConflictDoUpdate({
          target: [missionParticipants.missionId, missionParticipants.userId],
          set: { role: "decide" },
        });
    }
    await recordMissionEvent(tx, mission, "owner_transferred", {
      by: actorId,
      from: previous,
      to: input.userId,
      lentBy: lender,
      needsComputer,
    });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "mission.owner_transferred",
      target: { type: "mission", id: mission.id },
      details: { from: previous, to: input.userId, machineLentBy: lender, needsComputer },
    });
    return updated as MissionRow;
  });
  await requestFilesSync(deps.db, row);
  await publishMissionEvent(deps, row, "owner", { ...(needsComputer ? { code: "mission.needs_computer" } : {}) });
  return {
    ...(await viewFor(deps, row, actorId, isAdmin)),
    ...(needsComputer ? { code: "mission.needs_computer" } : {}),
  };
}

/**
 * The owner points the mission at a computer they paired (after a hand-over,
 * or to move it). Sessions don't move with it: new ones start from the
 * `.agentes/` files. `repoDir`: where the repository is on that machine.
 */
export async function setMissionMachine(
  deps: MissionDeps,
  actorId: string,
  orgId: string,
  missionId: string,
  input: { machineId: string; repoDir?: string | null },
) {
  const { mission, role, isAdmin } = await requireMission(deps, actorId, orgId, missionId);
  if (role !== "owner")
    throw new ForbiddenError("Only the mission's owner can choose its computer", "mission.not_owner");
  requireOpen(mission);
  const [machine] = await deps.db
    .select()
    .from(machines)
    .where(and(eq(machines.id, input.machineId), eq(machines.orgId, orgId), isNull(machines.deletedAt)));
  if (!machine) throw new NotFoundError("Computer not found");
  if (machine.pairedByUserId !== actorId) {
    throw new ForbiddenError("Choose a computer you paired", "mission.not_your_computer");
  }
  if (!machineExecutors(machine).available.includes(mission.executor as MissionExecutor)) {
    throw new ConflictError(
      `The runner on ${machine.name} can't run this mission: run agentes-runner update`,
      "mission.runner_outdated",
      { computer: machine.name },
    );
  }
  const moved = machine.id !== mission.machineId;
  const [row] = await deps.db
    .update(missions)
    .set({
      machineId: machine.id,
      machineLentBy: null,
      ...(input.repoDir !== undefined ? { repoDir: cleanRepoDir(input.repoDir) } : {}),
      // Another disk: a new main session, which starts by reading the mission files.
      ...(moved ? { mainSessionId: crypto.randomUUID(), inbox: [] } : {}),
      updatedAt: new Date(),
    })
    .where(eq(missions.id, mission.id))
    .returning();
  await recordMissionEvent(deps.db, mission, "machine_changed", {
    by: actorId,
    from: mission.machineId,
    to: machine.id,
  });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "mission.machine_changed",
    target: { type: "mission", id: mission.id },
    details: { from: mission.machineId, to: machine.id },
  });
  await requestFilesSync(deps.db, row as MissionRow);
  await publishMissionEvent(deps, row as MissionRow, "machine");
  return viewFor(deps, row as MissionRow, actorId, isAdmin);
}

/**
 * "Quem programa" on the plan card, before Start: the owner switches who does
 * the work (Claude Code, Codex, our agent). The planning that runs stops and
 * starts again with the new one (a new main session).
 */
export async function setMissionExecutor(
  deps: MissionDeps,
  actorId: string,
  orgId: string,
  missionId: string,
  executor: unknown,
) {
  const { mission, role, isAdmin } = await requireMission(deps, actorId, orgId, missionId);
  if (role !== "owner") throw new ForbiddenError("Only the mission's owner can choose this", "mission.not_owner");
  if (!isMissionExecutor(executor))
    throw new ValidationError("Choose claude, codex or agent", "mission.invalid_executor");
  if (mission.status !== "proposed") {
    throw new ConflictError("Who programs is chosen before Start", "mission.wrong_status", { status: mission.status });
  }
  if (executor === mission.executor) return viewFor(deps, mission, actorId, isAdmin);
  await usableMachine(deps, orgId, mission.machineId, executor);
  if (missionsOnEngine(deps)) await cancelMainRuns(deps, mission, actorId, "executor_changed");
  await cancelMissionTasks(deps, mission, actorId);
  const [row] = await deps.db
    .update(missions)
    .set({ executor, mainSessionId: crypto.randomUUID(), inbox: [], idleWakeups: 0, updatedAt: new Date() })
    .where(and(eq(missions.id, mission.id), eq(missions.status, "proposed")))
    .returning();
  if (!row) throw new ConflictError("The mission changed meanwhile", "mission.wrong_status");
  await recordMissionEvent(deps.db, row, "executor_changed", { by: actorId, from: mission.executor, to: executor });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "mission.executor_changed",
    target: { type: "mission", id: row.id },
    details: { from: mission.executor, to: executor },
  });
  if (executor === "agent" || missionsOnEngine(deps)) {
    await wakeMissionAgent(deps, row, executor === "agent" ? agentPlanPrompt(row) : planPrompt(row), {
      requestedBy: actorId,
      from: "the mission",
      kind: "system",
      freshSession: true,
    });
  } else {
    await startSessionTask(deps, row, {
      title: `Plan: ${row.title}`,
      prompt: planPrompt(row),
      sessionId: row.mainSessionId,
      cwd: row.repoDir,
      resume: false,
      requestedBy: actorId,
    });
  }
  await requestFilesSync(deps.db, row);
  await publishMissionEvent(deps, row, "executor", { executor });
  return viewFor(deps, row, actorId, isAdmin);
}

// ── The plan ─────────────────────────────────────────────────────────────────

export function planMark(status: PlanStatus) {
  return { todo: "[ ]", doing: "[~]", waiting_you: "[!]", done: "[x]", dropped: "[-]" }[status];
}

export async function latestPlan(db: Executor, missionId: string) {
  const [row] = await db
    .select()
    .from(missionPlanVersions)
    .where(eq(missionPlanVersions.missionId, missionId))
    .orderBy(desc(missionPlanVersions.version))
    .limit(1);
  return row ?? null;
}

/**
 * Tool names people should never read in a plan (the executor's MCP tools
 * and the agent's mission tools). Names with an underscore are removed
 * anywhere; one-word names (`report`) only when written as code.
 */
export const MISSION_TOOL_NAMES = [
  "report",
  "update_plan",
  "ask_decision",
  "request_review",
  "request_approval",
  "upload_artifact",
  "get_context",
  "start_task",
  "complete_mission",
  "permission_prompt",
  "send_to_mission",
  "propose_mission",
  "run_code",
  "upload_file",
  "read_file",
  "write_file",
  "list_files",
  "list_tasks",
  "task_status",
  "cancel_task",
] as const;

const TOOL_WORDS = "(?:via|with|using|through|use|call|calling|calls|com|usando|chamar|chamando|pelo|pela|por)";
const snakeNames = MISSION_TOOL_NAMES.filter((n) => n.includes("_")).join("|");
const allNames = MISSION_TOOL_NAMES.join("|");
/** One tool name: `report` / `update_plan()` as code, or a bare snake_case name, optionally followed by "tool". */
const TOOL_CORE = `(?:\`(?:${allNames})(?:\\(\\))?\`|\\b(?:${snakeNames})\\b(?:\\(\\))?)(?:\\s+tool)?`;
/** "(via upload_artifact)" as a whole, or "via upload_artifact" / "upload_artifact" in the text. */
const TOOL_NAME_RE = new RegExp(
  `\\s*(?:\\(\\s*(?:${TOOL_WORDS}\\s+)?${TOOL_CORE}\\s*\\)|(?:\\b${TOOL_WORDS}\\s+)?${TOOL_CORE})`,
  "gi",
);

/**
 * A plan item's title without tool names (`Enviar capturas via upload_artifact`
 * → `Enviar capturas`): whitespace collapsed, dangling punctuation and a
 * trailing "e"/"and" trimmed. When nothing would be left, the original text
 * without backticks.
 */
export function stripToolNames(title: string) {
  const out = title
    .replace(TOOL_NAME_RE, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+\)/g, ")")
    .replace(/([,;])(?:\s*[,;])+/g, "$1")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;:\-–—]+|[\s,;:\-–—]+$/g, "")
    .replace(/\s+(?:e|and|ou|or)$/i, "")
    .trim();
  return out || title.replace(/`/g, "").replace(/\s+/g, " ").trim();
}

/** Items as the executor sent them, cleaned; ids kept, or matched by title, or made up. */
export function normalizePlan(input: unknown, previous: PlanItem[] = []): PlanItem[] {
  if (!Array.isArray(input) || input.length === 0)
    throw new ValidationError("The plan needs items", "mission.invalid_plan");
  const out: PlanItem[] = [];
  const used = new Set<string>();
  let n = 0;
  for (const raw of input.slice(0, MISSION_LIMITS.planItems)) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const title = stripToolNames(oneLine(clean(r.title, MISSION_LIMITS.itemTitle), MISSION_LIMITS.itemTitle));
    if (!title) continue;
    const status = (PLAN_STATUSES as string[]).includes(String(r.status)) ? (r.status as PlanStatus) : "todo";
    let id = typeof r.id === "string" ? r.id.trim().slice(0, 40) : "";
    if (!id) id = previous.find((p) => p.title === title && !used.has(p.id))?.id ?? "";
    while (!id || used.has(id)) id = `i${++n}`;
    used.add(id);
    const note = clean(r.note, MISSION_LIMITS.itemNote);
    out.push({ id, title: noMentions(title), status, ...(note ? { note: noMentions(note) } : {}) });
  }
  if (out.length === 0) throw new ValidationError("The plan needs items", "mission.invalid_plan");
  return out;
}

export interface PlanChange {
  added: { id: string; title: string }[];
  removed: { id: string; title: string }[];
  changed: { id: string; title: string; from: PlanStatus; to: PlanStatus; renamedFrom?: string }[];
}

export function diffPlan(before: PlanItem[], after: PlanItem[]): PlanChange {
  const old = new Map(before.map((i) => [i.id, i]));
  const now = new Map(after.map((i) => [i.id, i]));
  return {
    added: after.filter((i) => !old.has(i.id)).map((i) => ({ id: i.id, title: i.title })),
    removed: before.filter((i) => !now.has(i.id)).map((i) => ({ id: i.id, title: i.title })),
    changed: after.flatMap((i) => {
      const was = old.get(i.id);
      if (!was || (was.status === i.status && was.title === i.title)) return [];
      return [
        {
          id: i.id,
          title: i.title,
          from: was.status,
          to: i.status,
          ...(was.title !== i.title ? { renamedFrom: was.title } : {}),
        },
      ];
    }),
  };
}

const planCounts = (items: PlanItem[]) => ({
  planTotal: items.filter((i) => i.status !== "dropped").length,
  planDone: items.filter((i) => i.status === "done").length,
  planWaiting: items.filter((i) => i.status === "waiting_you").length,
});

/**
 * A new plan version (from the executor's `update_plan`). After the first
 * one (shown by the plan card) every change posts one line in the thread
 * (`meta.missionPlanChange`). Nothing changed: no version, no line.
 */
export async function updatePlan(
  deps: MissionDeps,
  mission: MissionRow,
  input: { items: unknown; source: "executor" | "person"; taskId?: string | null },
) {
  const before = await latestPlan(deps.db, mission.id);
  const items = normalizePlan(input.items, before?.items ?? []);
  const change = diffPlan(before?.items ?? [], items);
  const same = before && !change.added.length && !change.removed.length && !change.changed.length;
  if (same) return { version: before.version, change, items };
  const version = (before?.version ?? 0) + 1;
  const result = await deps.db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(missionPlanVersions)
      .values({
        orgId: mission.orgId,
        missionId: mission.id,
        version,
        items,
        source: input.source,
        taskId: input.taskId ?? null,
      })
      .onConflictDoNothing()
      .returning({ version: missionPlanVersions.version });
    if (!inserted) throw new ConflictError("The plan changed at the same time; send it again", "mission.plan_conflict");
    // An item changing state is progress: the stuck-loop guard starts over.
    const moved = change.added.length > 0 || change.changed.some((c) => c.from !== c.to);
    await tx
      .update(missions)
      .set({ planVersion: version, ...planCounts(items), ...(moved ? { idleWakeups: 0 } : {}), updatedAt: new Date() })
      .where(eq(missions.id, mission.id));
    await recordMissionEvent(tx, mission, "plan_updated", { version, ...change, taskId: input.taskId ?? null });
    let message: Message | null = null;
    if (before) {
      const parts = [
        ...change.added.map((i) => `+ ${i.title}`),
        ...change.removed.map((i) => `− ${i.title}`),
        ...change.changed.map((i) => `${planMark(i.to)} ${i.title}`),
      ];
      message = await postMissionMessage(
        deps,
        mission,
        `Plan updated: ${parts.join(" · ")}`.slice(0, 2000),
        {
          missionPlanChange: { missionId: mission.id, version, ...change },
          bodyCode: "mission_plan_changed",
          bodyParams: {
            added: String(change.added.length),
            removed: String(change.removed.length),
            changed: String(change.changed.length),
          },
        },
        tx,
      );
    }
    return message;
  });
  if (result && deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(result));
  await requestFilesSync(deps.db, mission);
  await publishMissionEvent(deps, mission, "plan", { planVersion: version });
  // A plan with something left to do is new work; a finished one gets the done check.
  const finished = items.length > 0 && items.every((i) => i.status === "done" || i.status === "dropped");
  if (!finished) await reactivateMission(deps, (await getMissionRow(deps.db, mission.id)) ?? mission, "plan");
  else await scheduleDoneCheck(deps.db, mission);
  return { version, change, items };
}

/** `/plan`: the latest version and the history (newest first). */
export async function getMissionPlan(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const { mission } = await requireMission(deps, userId, orgId, missionId);
  const rows = await deps.db
    .select()
    .from(missionPlanVersions)
    .where(eq(missionPlanVersions.missionId, mission.id))
    .orderBy(desc(missionPlanVersions.version))
    .limit(100);
  const versions = rows.map((r) => ({
    version: r.version,
    items: r.items,
    source: r.source,
    taskId: r.taskId,
    createdAt: r.createdAt.toISOString(),
  }));
  return { missionId: mission.id, current: versions[0] ?? null, history: versions };
}

// ── Decisions ────────────────────────────────────────────────────────────────

type DecisionRow = typeof missionDecisions.$inferSelect;

export interface DecisionView {
  id: string;
  missionId: string;
  taskId: string | null;
  messageId: string | null;
  question: string;
  options: string[];
  recommendation: string | null;
  why: string | null;
  impact: string | null;
  blocking: boolean;
  status: DecisionRow["status"];
  chosen: string | null;
  chosenBy: string | null;
  chosenAt: string | null;
  opinions: { userId: string; option: string; at: string }[];
  createdAt: string;
}

export const decisionView = (d: DecisionRow): DecisionView => ({
  id: d.id,
  missionId: d.missionId,
  taskId: d.taskId,
  messageId: d.messageId,
  question: d.question,
  options: d.options,
  recommendation: d.recommendation,
  why: d.why,
  impact: d.impact,
  blocking: d.blocking,
  status: d.status,
  chosen: d.chosen,
  chosenBy: d.chosenBy,
  chosenAt: iso(d.chosenAt),
  opinions: d.opinions,
  createdAt: d.createdAt.toISOString(),
});

/** `ask_decision`: a card in the thread. Blocking: pending (the session waits); else provisional with the recommendation. */
export async function askDecision(
  deps: MissionDeps,
  mission: MissionRow,
  task: Pick<MachineTaskRow, "id" | "sessionId"> | null,
  input: {
    question: unknown;
    options: unknown;
    recommendation?: unknown;
    why?: unknown;
    impact?: unknown;
    blocking: boolean;
  },
) {
  const question = noMentions(clean(input.question, 500));
  const options = (Array.isArray(input.options) ? input.options : [])
    .map((o) => noMentions(oneLine(clean(o, 200), 200)))
    .filter(Boolean)
    .filter((o, i, all) => all.indexOf(o) === i)
    .slice(0, 4);
  if (!question || options.length < 2) {
    throw new ValidationError("A decision needs a question and 2 to 4 different options", "mission.invalid_decision");
  }
  const rec = noMentions(oneLine(clean(input.recommendation, 200), 200));
  const recommendation = options.includes(rec)
    ? rec
    : rec
      ? (options.find((o) => o.toLowerCase() === rec.toLowerCase()) ?? null)
      : null;
  const provisional = !input.blocking;
  const row = await deps.db.transaction(async (tx) => {
    const [d] = await tx
      .insert(missionDecisions)
      .values({
        orgId: mission.orgId,
        missionId: mission.id,
        taskId: task?.id ?? null,
        sessionId: task?.sessionId ?? null,
        question,
        options,
        recommendation,
        why: noMentions(clean(input.why, 1000)) || null,
        impact: noMentions(clean(input.impact, 500)) || null,
        blocking: input.blocking,
        status: provisional ? "provisional" : "pending",
        chosen: provisional ? (recommendation ?? options[0] ?? null) : null,
      })
      .returning();
    if (!d) throw new Error("decision insert returned nothing");
    const message = await postMissionMessage(
      deps,
      mission,
      `${provisional ? "Provisional decision" : "Decision needed"}: ${question}`,
      {
        missionDecision: { id: d.id, missionId: mission.id },
        bodyCode: provisional ? "mission_decision_provisional" : "mission_decision",
        bodyParams: { question },
      },
      tx,
    );
    const [linked] = await tx
      .update(missionDecisions)
      .set({ messageId: message.id })
      .where(eq(missionDecisions.id, d.id))
      .returning();
    await recordMissionEvent(tx, mission, "decision_asked", { decisionId: d.id, blocking: input.blocking });
    return { decision: linked ?? d, message };
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(row.message));
  if (provisional) await requestFilesSync(deps.db, mission);
  await publishMissionEvent(deps, mission, "decision", { decision: decisionView(row.decision) });
  if (mission.ownerId) {
    await publishUserEvent(deps.pubsub, mission.orgId, mission.ownerId, {
      type: "mission.needs_you",
      missionId: mission.id,
      decisionId: row.decision.id,
    });
  }
  return row.decision;
}

export async function listDecisions(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const { mission } = await requireMission(deps, userId, orgId, missionId);
  const rows = await deps.db
    .select()
    .from(missionDecisions)
    .where(eq(missionDecisions.missionId, mission.id))
    .orderBy(desc(missionDecisions.createdAt))
    .limit(200);
  return rows.map(decisionView);
}

async function requireDecision(deps: MissionDeps, mission: MissionRow, decisionId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(decisionId)) throw new NotFoundError("Decision not found", "mission.decision_not_found");
  const [d] = await deps.db
    .select()
    .from(missionDecisions)
    .where(and(eq(missionDecisions.id, decisionId), eq(missionDecisions.missionId, mission.id)));
  if (!d) throw new NotFoundError("Decision not found", "mission.decision_not_found");
  return d;
}

/** The session that asked something, to resume it with the answer. */
const askerOf = (mission: MissionRow, row: { sessionId: string | null }) => ({
  sessionId: row.sessionId ?? mission.mainSessionId,
});

/**
 * The owner or a decider chooses. A blocking decision resumes the session
 * that asked (`Decision: … → … (by …)`); a provisional one only when the
 * choice differs from what the executor went with.
 */
export async function chooseDecision(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  missionId: string,
  decisionId: string,
  option: string,
) {
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "decide");
  requireOpen(mission);
  const d = await requireDecision(deps, mission, decisionId);
  if (!d.options.includes(option)) throw new ValidationError("Choose one of the options", "mission.bad_option");
  if (d.status === "taken") throw new ConflictError("This decision was already taken", "mission.decision_taken");
  const [taken] = await deps.db
    .update(missionDecisions)
    .set({ status: "taken", chosen: option, chosenBy: userId, chosenAt: new Date() })
    .where(and(eq(missionDecisions.id, d.id), inArray(missionDecisions.status, ["pending", "provisional"])))
    .returning();
  if (!taken) throw new ConflictError("This decision was already taken", "mission.decision_taken");
  const name = await nameOf(deps.db, userId);
  await recordMissionEvent(deps.db, mission, "decision_taken", { decisionId: d.id, option, by: userId });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "mission.decision_taken",
    target: { type: "mission", id: mission.id },
    details: { decisionId: d.id, option, was: d.status },
  });
  if (d.status === "pending") {
    await tellSession(deps, mission, askerOf(mission, d), `Decision: ${d.question} → ${option} (by ${name})`, {
      requestedBy: userId,
      // On the engine: the run paused on this blocking ask_decision resumes with the answer.
      resume: { kind: "input", id: d.id },
    });
  } else if (d.chosen !== option) {
    await tellSession(
      deps,
      mission,
      askerOf(mission, d),
      `Decision changed: ${d.question} → ${option} (by ${name}; you went with ${d.chosen ?? "another option"}). Adjust your work.`,
      { requestedBy: userId },
    );
  }
  await requestFilesSync(deps.db, mission);
  await publishMissionEvent(deps, mission, "decision", { decision: decisionView(taken) });
  return decisionView(taken);
}

/** Anyone taking part (comment included) says what they prefer; only shown, never deciding. */
export async function opineDecision(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  missionId: string,
  decisionId: string,
  option: string,
) {
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  if (role === "none")
    throw new ForbiddenError("Only people taking part in the mission can give an opinion", "mission.not_participant");
  const d = await requireDecision(deps, mission, decisionId);
  if (!d.options.includes(option)) throw new ValidationError("Choose one of the options", "mission.bad_option");
  const opinions = [...d.opinions.filter((o) => o.userId !== userId), { userId, option, at: new Date().toISOString() }];
  const [row] = await deps.db
    .update(missionDecisions)
    .set({ opinions })
    .where(eq(missionDecisions.id, d.id))
    .returning();
  await publishMissionEvent(deps, mission, "decision", { decision: decisionView(row as DecisionRow) });
  return decisionView(row as DecisionRow);
}

/** "Aprovar todas": every provisional decision is taken as the executor went with it. */
export async function approveProvisionalDecisions(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "decide");
  requireOpen(mission);
  const rows = await deps.db
    .update(missionDecisions)
    .set({ status: "taken", chosenBy: userId, chosenAt: new Date() })
    .where(and(eq(missionDecisions.missionId, mission.id), eq(missionDecisions.status, "provisional")))
    .returning();
  if (rows.length > 0) {
    await recordMissionEvent(deps.db, mission, "provisional_approved", { by: userId, count: rows.length });
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: userId },
      action: "mission.decision_taken",
      target: { type: "mission", id: mission.id },
      details: { provisional: rows.map((r) => r.id) },
    });
    await requestFilesSync(deps.db, mission);
    await publishMissionEvent(deps, mission, "decision");
  }
  return rows.map(decisionView);
}

// ── Reviews ──────────────────────────────────────────────────────────────────

type ReviewRow = typeof missionReviews.$inferSelect;

export const reviewView = (r: ReviewRow) => ({
  id: r.id,
  missionId: r.missionId,
  taskId: r.taskId,
  messageId: r.messageId,
  title: r.title,
  summary: r.summary,
  prUrl: r.prUrl,
  artifactIds: r.artifactIds,
  status: r.status,
  note: r.note,
  decidedBy: r.decidedBy,
  decidedAt: iso(r.decidedAt),
  createdAt: r.createdAt.toISOString(),
});
export type ReviewView = ReturnType<typeof reviewView>;

/** `request_review`: a card in the thread (`meta.missionReview`). */
export async function requestReview(
  deps: MissionDeps,
  mission: MissionRow,
  task: Pick<MachineTaskRow, "id" | "sessionId"> | null,
  input: { title: unknown; summary?: unknown; prUrl?: unknown; artifactIds?: string[] },
) {
  const title = noMentions(oneLine(clean(input.title, 200), 200));
  if (!title) throw new ValidationError("A review needs a title", "mission.invalid_review");
  const pr = clean(input.prUrl, 500);
  const prUrl = /^https?:\/\/\S+$/i.test(pr) ? pr : null;
  const row = await deps.db.transaction(async (tx) => {
    const [r] = await tx
      .insert(missionReviews)
      .values({
        orgId: mission.orgId,
        missionId: mission.id,
        taskId: task?.id ?? null,
        sessionId: task?.sessionId ?? null,
        title,
        summary: noMentions(clean(input.summary, 4000)),
        prUrl,
        artifactIds: input.artifactIds ?? [],
      })
      .returning();
    if (!r) throw new Error("review insert returned nothing");
    const message = await postMissionMessage(
      deps,
      mission,
      `Ready for you to see: ${title}`,
      {
        missionReview: { id: r.id, missionId: mission.id },
        ...(r.artifactIds.length ? { artifacts: r.artifactIds.map((id) => ({ id })) } : {}),
        bodyCode: "mission_review",
        bodyParams: { title },
      },
      tx,
    );
    const [linked] = await tx
      .update(missionReviews)
      .set({ messageId: message.id })
      .where(eq(missionReviews.id, r.id))
      .returning();
    await recordMissionEvent(tx, mission, "review_requested", { reviewId: r.id });
    return { review: linked ?? r, message };
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(row.message));
  await publishMissionEvent(deps, mission, "review", { review: reviewView(row.review) });
  if (mission.ownerId) {
    await publishUserEvent(deps.pubsub, mission.orgId, mission.ownerId, {
      type: "mission.needs_you",
      missionId: mission.id,
      reviewId: row.review.id,
    });
  }
  return row.review;
}

export async function listReviews(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const { mission } = await requireMission(deps, userId, orgId, missionId);
  const rows = await deps.db
    .select()
    .from(missionReviews)
    .where(eq(missionReviews.missionId, mission.id))
    .orderBy(desc(missionReviews.createdAt))
    .limit(200);
  return rows.map(reviewView);
}

/** Approve, or ask for changes (with a note): the session that asked is resumed with the outcome. */
export async function decideReview(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  missionId: string,
  reviewId: string,
  input: { outcome: "approved" | "changes_requested"; note?: string | null },
) {
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "review");
  requireOpen(mission);
  if (!/^[0-9a-f-]{36}$/i.test(reviewId)) throw new NotFoundError("Review not found", "mission.review_not_found");
  const note = clean(input.note, 4000);
  if (input.outcome === "changes_requested" && !note) {
    throw new ValidationError("Say what should change", "mission.review_note_required");
  }
  const [row] = await deps.db
    .update(missionReviews)
    .set({ status: input.outcome, note: note || null, decidedBy: userId, decidedAt: new Date() })
    .where(
      and(
        eq(missionReviews.id, reviewId),
        eq(missionReviews.missionId, mission.id),
        eq(missionReviews.status, "pending"),
      ),
    )
    .returning();
  if (!row) {
    const [exists] = await deps.db
      .select({ id: missionReviews.id })
      .from(missionReviews)
      .where(and(eq(missionReviews.id, reviewId), eq(missionReviews.missionId, mission.id)));
    if (!exists) throw new NotFoundError("Review not found", "mission.review_not_found");
    throw new ConflictError("This review was already answered", "mission.review_decided");
  }
  const name = await nameOf(deps.db, userId);
  await recordMissionEvent(deps.db, mission, "review_decided", { reviewId, outcome: input.outcome, by: userId });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "mission.review_decided",
    target: { type: "mission", id: mission.id },
    details: { reviewId, outcome: input.outcome },
  });
  const text =
    input.outcome === "approved"
      ? `Review approved: "${row.title}" (by ${name}).${note ? ` Note: ${note}` : ""} Go on with the plan.`
      : `Changes requested on "${row.title}" (by ${name}): ${note}`;
  await tellSession(deps, mission, askerOf(mission, row), text, {
    requestedBy: userId,
    // On the engine: the run paused on this request_review resumes with the answer.
    resume: { kind: "input", id: row.id },
  });
  await publishMissionEvent(deps, mission, "review", { review: reviewView(row) });
  return reviewView(row);
}

// ── Suggestions ──────────────────────────────────────────────────────────────

/**
 * A message from someone who can't act, addressed to the mission's agent,
 * started nothing (`meta.missionSuggestion.status = pending`, set by the
 * message insert). The owner or a decider accepts it (forwarded to the main
 * session) or declines it.
 */
export async function decideSuggestion(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  missionId: string,
  messageId: string,
  outcome: "accepted" | "declined",
) {
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "answer suggestions");
  requireOpen(mission);
  if (!/^[0-9a-f-]{36}$/i.test(messageId))
    throw new NotFoundError("Suggestion not found", "mission.suggestion_not_found");
  const [row] = await deps.db
    .update(messages)
    .set({
      meta: sql`jsonb_set(${messages.meta}, '{missionSuggestion}', (${messages.meta}->'missionSuggestion') || ${JSON.stringify(
        {
          status: outcome,
          by: userId,
          at: new Date().toISOString(),
        },
      )}::jsonb)`,
    })
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.orgId, orgId),
        eq(messages.threadId, mission.threadRootId),
        sql`${messages.meta}->'missionSuggestion'->>'status' = 'pending'`,
      ),
    )
    .returning();
  if (!row) throw new NotFoundError("Suggestion not found (or already answered)", "mission.suggestion_not_found");
  await recordMissionEvent(deps.db, mission, `suggestion_${outcome}`, { messageId, by: userId });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: `mission.suggestion_${outcome}`,
    target: { type: "mission", id: mission.id },
    details: { messageId, authorId: row.authorUserId },
  });
  if (outcome === "accepted") {
    const [author, actor] = [await nameOf(deps.db, row.authorUserId), await nameOf(deps.db, userId)];
    await tellSession(
      deps,
      mission,
      { sessionId: mission.mainSessionId, cwd: mission.repoDir },
      `Suggestion from ${author}, accepted by ${actor}: ${row.body}`,
      { requestedBy: userId },
    );
  }
  await publishMissionEvent(deps, mission, "suggestion", { messageId, suggestion: outcome });
  return { messageId, status: outcome };
}

// ── Summary (no model) ───────────────────────────────────────────────────────

export async function missionSummary(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const { mission } = await requireMission(deps, userId, orgId, missionId);
  const [plan, running, decisions, reviews, machine] = await Promise.all([
    latestPlan(deps.db, mission.id),
    deps.db
      .select()
      .from(machineTasks)
      .where(
        and(
          eq(machineTasks.missionId, mission.id),
          inArray(machineTasks.status, ACTIVE_TASK),
          isNull(machineTasks.endedAt),
        ),
      )
      .orderBy(desc(machineTasks.createdAt))
      .limit(10),
    deps.db
      .select({ question: missionDecisions.question, status: missionDecisions.status })
      .from(missionDecisions)
      .where(
        and(eq(missionDecisions.missionId, mission.id), inArray(missionDecisions.status, ["pending", "provisional"])),
      ),
    deps.db
      .select({ title: missionReviews.title })
      .from(missionReviews)
      .where(and(eq(missionReviews.missionId, mission.id), eq(missionReviews.status, "pending"))),
    mission.machineId ? deps.db.select().from(machines).where(eq(machines.id, mission.machineId)) : Promise.resolve([]),
  ]);
  const items = plan?.items ?? [];
  const doing = items.filter((i) => i.status === "doing");
  const waiting = items.filter((i) => i.status === "waiting_you");
  const pending = decisions.filter((d) => d.status === "pending");
  const provisional = decisions.filter((d) => d.status === "provisional");
  const computer = machine[0];
  const lines = [
    `"${mission.title}": ${mission.status}.`,
    items.length
      ? `Plan: ${mission.planDone} of ${mission.planTotal} done${doing.length ? `, ${doing.length} in progress` : ""}${
          waiting.length ? `, ${waiting.length} waiting for you` : ""
        }.`
      : "No plan yet.",
    ...(doing.length ? [`In progress: ${doing.map((i) => i.title).join("; ")}.`] : []),
    ...(waiting.length ? [`Waiting for you: ${waiting.map((i) => i.title).join("; ")}.`] : []),
    ...(pending.length ? [`Decisions to take: ${pending.map((d) => d.question).join("; ")}.`] : []),
    ...(provisional.length ? [`Provisional decisions to review: ${provisional.length}.`] : []),
    ...(reviews.length ? [`Ready for you to see: ${reviews.map((r) => r.title).join("; ")}.`] : []),
    ...(running.length
      ? [
          `Running: ${running
            .map(
              (t) =>
                `"${t.title}"${t.branch ? ` (${t.branch})` : ""}, ${formatDuration(taskSeconds(t))}${t.lastLine ? `: ${t.lastLine}` : ""}`,
            )
            .join("; ")}.`,
        ]
      : ["Nothing running now."]),
    ...(computer ? [`Computer: ${computer.name} (${computer.online ? "online" : "offline"}).`] : []),
  ];
  return {
    missionId: mission.id,
    text: lines.join("\n"),
    plan: { done: mission.planDone, total: mission.planTotal, doing: doing.length, waiting: waiting.length },
    running: running.length,
    pendingDecisions: pending.length,
    provisionalDecisions: provisional.length,
    pendingReviews: reviews.length,
  };
}

// ── Files (.agentes/) ────────────────────────────────────────────────────────

export const MISSION_FILE_NAMES = ["mission.md", "decisions.md", "notes.md"] as const;

export async function getMissionFiles(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const { mission } = await requireMission(deps, userId, orgId, missionId);
  const [files, edited] = await Promise.all([
    deps.db.select().from(missionFiles).where(eq(missionFiles.missionId, mission.id)),
    deps.db
      .select()
      .from(missionEvents)
      .where(and(eq(missionEvents.missionId, mission.id), eq(missionEvents.kind, "file_edited_on_machine")))
      .orderBy(desc(missionEvents.createdAt))
      .limit(20),
  ]);
  return {
    files: MISSION_FILE_NAMES.map((name) => {
      const f = files.find((x) => x.name === name);
      return {
        name,
        content: f?.content ?? null,
        source: f?.source ?? null,
        writtenAt: iso(f?.writtenAt ?? null),
        updatedAt: iso(f?.updatedAt ?? null),
      };
    }),
    editedOnMachine: edited.map((e) => ({ id: e.id, ...e.data, at: e.createdAt.toISOString() })),
  };
}

/** The machine tasks of a thread (the web's live cards), for whoever reads the thread's conversation. */
export async function listThreadMachineTasks(deps: MissionDeps, userId: string, orgId: string, threadId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(threadId)) throw new NotFoundError("Thread not found");
  const [root] = await deps.db
    .select({ channelId: messages.channelId, threadId: messages.threadId })
    .from(messages)
    .where(and(eq(messages.id, threadId), eq(messages.orgId, orgId)));
  if (!root || root.threadId) throw new NotFoundError("Thread not found");
  await requireChannelAccess(deps.db, userId, orgId, root.channelId);
  return deps.db
    .select()
    .from(machineTasks)
    .where(
      and(
        eq(machineTasks.orgId, orgId),
        eq(machineTasks.channelId, root.channelId),
        eq(machineTasks.threadRootId, threadId),
      ),
    )
    .orderBy(desc(machineTasks.createdAt))
    .limit(100);
}

/** Open missions on a machine (its reconnect delivers their queued messages and files). */
export async function missionsOnMachine(db: Executor, machineId: string) {
  return db
    .select()
    .from(missions)
    .where(
      and(
        eq(missions.machineId, machineId),
        or(inArray(missions.status, OPEN), sql`${missions.filesDirtyAt} is not null`),
      ),
    );
}

// ── Who can run a mission for the caller ─────────────────────────────────────

/** Why an agent can't run a mission for the caller ("Nova missão" shows it, translated). */
export type MissionIneligibleReason =
  | "no_computer"
  | "cloud_computer"
  | "exec_off"
  | "runner_outdated"
  | "not_in_audience";

export interface EligibleAgent {
  agentId: string;
  handle: string;
  name: string;
  /** It can run a mission for the caller now (or when its computer comes back online). */
  eligible: boolean;
  /** Set when not eligible. `cloud_computer`: missions on cloud computers come later. */
  reason: MissionIneligibleReason | null;
  /** The caller can choose its computer (an admin or the agent's owner): the web links to its settings. */
  canManage: boolean;
  /** Its connected computer; null on the cloud computer or with none. */
  machine: { id: string; name: string; online: boolean } | null;
  /** Eligible and online: a mission can start now. Offline agents are listed (their computer comes back). */
  ready: boolean;
  /** Who can do the work on that computer ("Quem programa"), and the default (null when not eligible). */
  executors: MissionExecutor[];
  defaultExecutor: MissionExecutor | null;
  /** Codex is there but too old (`CODEX_MIN_VERSION`). */
  codexTooOld: boolean;
  /** The autonomy its new missions start with ("Usar como padrão"). */
  commandApproval: CommandApproval;
}

/**
 * "Nova missão": every agent of the organization, each saying whether it can
 * run a mission for the caller: a connected computer that allows commands
 * with a runner on protocol 4 or later, and the caller in its audience (D31).
 * The others carry the reason (`cloud`: the server has cloud computers, so an
 * agent without a connected one is on the cloud computer). Eligible first. One query.
 */
export async function eligibleMissionAgents(
  deps: Pick<MissionDeps, "db">,
  userId: string,
  orgId: string,
  opts: { cloud?: boolean } = {},
) {
  const membership = await requirePermission(deps.db, userId, orgId, "read");
  const admin = can(membership.role, "manage_agents");
  const rows = rowsOf<{
    id: string;
    handle: string;
    name: string;
    owner_user_id: string | null;
    mission_command_approval: string | null;
    can_talk: boolean;
    machine_id: string | null;
    machine_name: string | null;
    online: boolean | null;
    last_seen_at: Date | string | null;
    protocol: number | null;
    exec_allowed: boolean | null;
    executors: schema.MachineExecutors | string | null;
  }>(
    await deps.db.execute(sql`select agents.id, agents.handle, agents.name, agents.owner_user_id,
        agents.mission_command_approval,
        ${audienceSql("agents", sql`${userId}::text`)} as can_talk,
        mc.id as machine_id, mc.name as machine_name, mc.online, mc.last_seen_at, mc.protocol,
        mc.exec_allowed, mc.executors
      from ${schema.agents} agents
      left join ${machines} mc on mc.id = agents.machine_id and mc.org_id = agents.org_id and mc.deleted_at is null
      where agents.org_id = ${orgId}::uuid and agents.archived_at is null
      order by agents.name`),
  );
  const list = rows.map((r): EligibleAgent => {
    const canManage = admin || (r.owner_user_id != null && r.owner_user_id === userId);
    const machine = r.machine_id
      ? {
          id: r.machine_id,
          name: r.machine_name ?? "",
          online: machineOnline({
            online: Boolean(r.online),
            lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at) : null,
            deletedAt: null,
          }),
        }
      : null;
    const protocol = Number(r.protocol ?? 0);
    const reason: MissionIneligibleReason | null = !r.can_talk
      ? "not_in_audience"
      : !machine
        ? opts.cloud
          ? "cloud_computer"
          : "no_computer"
        : !r.exec_allowed
          ? "exec_off"
          : protocol < TASKS_PROTOCOL
            ? "runner_outdated"
            : null;
    const base = {
      agentId: r.id,
      handle: r.handle,
      name: r.name,
      canManage,
      machine,
      commandApproval: agentMissionApproval({ missionCommandApproval: r.mission_command_approval }),
    };
    if (reason) {
      return {
        ...base,
        eligible: false,
        reason,
        ready: false,
        executors: [],
        defaultExecutor: null,
        codexTooOld: false,
      };
    }
    const found = typeof r.executors === "string" ? (JSON.parse(r.executors) as schema.MachineExecutors) : r.executors;
    const { available, codexTooOld } = machineExecutors({ protocol, execAllowed: true, executors: found });
    return {
      ...base,
      eligible: true,
      reason: null,
      ready: Boolean(machine?.online),
      executors: available,
      defaultExecutor: defaultExecutor(available),
      codexTooOld,
    };
  });
  // Eligible first (by name, as the query sorts): the dialog picks the first one.
  return [...list.filter((a) => a.eligible), ...list.filter((a) => !a.eligible)];
}

// ── A task's output ("Ver saída") ────────────────────────────────────────────

/**
 * The last lines of a task, for whoever reads its conversation. Online (a
 * runner on protocol 6+): asked to the computer, which reads its log and
 * answers the human lines it derives (redacted). Otherwise, or when that
 * fails: the lines we kept from its events (`recent_lines`).
 */
export async function getTaskOutput(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  taskId: string,
  input: { tail?: number } = {},
) {
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw new NotFoundError("Task not found", "task.not_found");
  const [row] = await deps.db
    .select()
    .from(machineTasks)
    .where(and(eq(machineTasks.id, taskId), eq(machineTasks.orgId, orgId)));
  if (!row) throw new NotFoundError("Task not found", "task.not_found");
  await requireChannelAccess(deps.db, userId, orgId, row.channelId).catch(() => {
    throw new NotFoundError("Task not found", "task.not_found");
  });
  const tail = Math.min(Math.max(Math.floor(input.tail ?? RECENT_LINES), 1), MISSION_LIMITS.outputLines);
  const status = deps.hub ? await deps.hub.status(row.machineId).catch(() => null) : null;
  if (deps.hub && status?.online && status.protocol >= TASK_OUTPUT_PROTOCOL) {
    try {
      const agent = await getAgentCached(deps.db, orgId, row.agentId);
      const out = await deps.hub.call<"task.output">(
        row.machineId,
        { op: "task.output", taskId: row.id, tail, agent: { id: row.agentId, handle: agent?.handle ?? "agent" } },
        { timeoutMs: 15_000 },
      );
      const lines = (Array.isArray(out?.lines) ? out.lines : []).map((l) => String(l).slice(0, 500)).slice(-tail);
      return {
        taskId: row.id,
        status: row.status,
        source: "computer" as const,
        lines,
        truncated: out?.truncated === true,
      };
    } catch {
      // Fall back to what we kept.
    }
  }
  const kept = Array.isArray(row.recentLines) ? row.recentLines : [];
  const lines = kept.length ? kept : row.lastLine ? [row.lastLine] : [];
  return {
    taskId: row.id,
    status: row.status,
    source: "saved" as const,
    lines: lines.slice(-tail),
    truncated: lines.length > tail || kept.length >= RECENT_LINES,
  };
}

export {
  answerers as missionAnswerers,
  clean as cleanMissionText,
  nameOf as missionPersonName,
  oneLine as oneLineText,
};
