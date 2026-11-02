import { type Database, rowsOf, schema, sql } from "@agenteschat/db";
import { replyExcerpt } from "./messages";
import { NotFoundError } from "./errors";
import { can, requireActiveMembership } from "./organizations";
import { pendingIds } from "./recovery";

/**
 * The task manager (ADR 0127): every task the caller may see, what each one uses right now, each agent's activity
 * over the last hour and what ended since `since`. Who sees what is the "Trabalhando agora" rule (the conversations
 * the caller is in, `listWorkingRuns`), plus the routines' background runs for admins (`manage_agents`) and for the
 * agent's owner. No cost: people stop work here, they don't audit spend.
 */

const {
  agentRuns,
  agentRunSteps,
  agents,
  channels,
  channelMembers,
  machines,
  messages,
  routineRuns,
  routines,
  threads,
  users,
} = schema;

/** Tasks listed at most, and ended ones. */
export const TASK_MANAGER_MAX = 100;
export const TASK_MANAGER_ENDED_MAX = 50;
/** Minutes in an agent's activity line (one point per minute, oldest first). */
export const ACTIVITY_MINUTES = 60;

/** What a task uses right now: its latest tool call (the same fields as the chat's live chip, `agent.tool`). */
export interface TaskNow {
  /** The tool's name (`browser_do`, `run_code`, `github_create_pull_request`…). */
  tool: string;
  /** A short label: the command, the issue, the file (built-in tools only). */
  detail: string | null;
  /** The app, for a connector's tool. */
  connector: string | null;
  /** The service it works in, for its logo (`ToolDefinition.service`), and a custom server's own icon. */
  service: string | null;
  serviceIcon: string | null;
  at: string;
}

export type TaskStatus = "queued" | "running" | "waiting_approval" | "waiting_input";

export interface ManagedTask {
  runId: string;
  agentId: string;
  channelId: string;
  channelKind: "channel" | "dm";
  /** Null for a DM (and a routine's room). */
  channelName: string | null;
  /** Null: the main timeline. */
  threadId: string | null;
  status: TaskStatus;
  startedAt: string | null;
  createdAt: string;
  /** What it works on: the long work's title, the thread's title, else its first message (≤ 80, plain text). */
  label: string | null;
  /** A routine's background run. */
  background: boolean;
  /** The routine behind it, for a background run. */
  routine: { id: string; name: string } | null;
  /** Long work (ADR 0121): its plan's progress. */
  plan: { done: number; total: number } | null;
  /** Who asked: a person's name, or null (another agent, a routine, an event). */
  requester: { userId: string; name: string } | null;
  /** The brain it thinks with (`model`, `claude_code`, `codex`, `cursor`); null before its first turn. */
  brain: string | null;
  /** The agent's computer, for a computer brain or computer tools. */
  machine: { id: string; name: string } | null;
  now: TaskNow | null;
  /** Tool calls so far. */
  steps: number;
  /** Messages sent to it while it works that it hasn't read yet. */
  pendingMessageIds: string[];
  /** The caller may stop it (`mayStopRun`: who asked, the agent's owner, an admin; the server checks again). */
  canStop: boolean;
  /**
   * What a `waiting_input` run waits on when it isn't a person: its computer with no room for the turn
   * (`computer_busy`), its computer away (`computer_offline`), its plan's limit (`plan`) or the agent's budget
   * (`budget`). Null: it waits on a person's answer, or it isn't waiting.
   */
  held: "computer_busy" | "computer_offline" | "plan" | "budget" | null;
}

export interface EndedTask {
  runId: string;
  agentId: string;
  channelId: string;
  channelKind: "channel" | "dm";
  channelName: string | null;
  threadId: string | null;
  status: "done" | "failed" | "canceled";
  label: string | null;
  background: boolean;
  routine: { id: string; name: string } | null;
  startedAt: string | null;
  finishedAt: string;
  /** Stopped by a person: who. */
  stoppedBy: { userId: string; name: string } | null;
}

export interface TaskManagerView {
  tasks: ManagedTask[];
  ended: EndedTask[];
  /** Per agent with work in the last hour: tool calls per minute, `ACTIVITY_MINUTES` points, oldest first. */
  activity: Record<string, number[]>;
}

type Row = {
  id: string;
  agent_id: string;
  channel_id: string;
  status: string;
  thread_root_id: string;
  trigger_message_id: string;
  started_at: string | Date | null;
  created_at: string | Date;
  finished_at: string | Date | null;
  error: string | null;
  kind: "channel" | "dm";
  name: string;
  title: string | null;
  root_body: string | null;
  pending: string[] | string | null;
  background: boolean | string;
  brain: string | null;
  owner_user_id: string | null;
  machine_id: string | null;
  machine_name: string | null;
  requester_id: string | null;
  requester_name: string | null;
  routine_id: string | null;
  routine_name: string | null;
  work_title: string | null;
  work_plan: { state: string }[] | string | null;
  last_data: Record<string, unknown> | string | null;
  last_at: string | Date | null;
  steps: number | string | null;
  stopper_name: string | null;
  wait_code: string | null;
  wait_source: string | null;
};

const iso = (v: string | Date | null) => (v === null ? null : new Date(v).toISOString());
const truthy = (v: boolean | string) => v === true || v === "t";
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** The runs the caller sees, by status (`active`: still on; else ended since `since`). */
async function visibleRuns(
  db: Database,
  userId: string,
  orgId: string,
  manages: boolean,
  which: { active: true } | { active: false; since: Date },
): Promise<Row[]> {
  const status = which.active
    ? sql`r.status in ('queued', 'running', 'waiting_approval', 'waiting_input')`
    : sql`r.status in ('done', 'failed', 'canceled') and r.finished_at >= ${which.since.toISOString()}::timestamptz`;
  const limit = which.active ? TASK_MANAGER_MAX : TASK_MANAGER_ENDED_MAX;
  return rowsOf<Row>(
    await db.execute(sql`select r.id, r.agent_id, r.channel_id, r.status, r.thread_root_id, r.trigger_message_id,
        r.started_at, r.created_at, r.finished_at, r.error, c.kind, c.name, t.title, root.body as root_body,
        array_to_json(r.pending_message_ids) as pending, r.background, r.brain,
        a.owner_user_id, a.machine_id, mc.name as machine_name,
        trig.author_user_id as requester_id, ru.name as requester_name,
        rt.id as routine_id, rt.name as routine_name, w.title as work_title, w.plan as work_plan,
        last.data as last_data, last.created_at as last_at,
        (select count(*) from ${agentRunSteps} s where s.run_id = r.id and s.kind = 'tool_call') as steps,
        su.name as stopper_name,
        r.transcript->'waitingForBrain'->>'code' as wait_code, r.transcript->'waitingForBrain'->>'source' as wait_source
      from ${agentRuns} r
      join ${channels} c on c.id = r.channel_id and c.org_id = ${orgId}::uuid
        and c.archived_at is null and c.kind in ('channel', 'dm')
      join ${agents} a on a.id = r.agent_id and a.org_id = ${orgId}::uuid
      left join ${machines} mc on mc.org_id = ${orgId}::uuid and mc.id = a.machine_id
      left join ${schema.agentWorks} w on w.id = r.work_id
      left join ${threads} t on t.org_id = ${orgId}::uuid and t.root_message_id = r.thread_root_id
      left join lateral (
        select m.body from ${messages} m
        where m.org_id = ${orgId}::uuid and m.id = r.thread_root_id and m.deleted_at is null
        limit 1
      ) root on true
      left join lateral (
        select m.author_user_id from ${messages} m
        where m.org_id = ${orgId}::uuid and m.id = r.trigger_message_id
        limit 1
      ) trig on true
      left join ${users} ru on ru.id = trig.author_user_id
      left join ${users} su on r.error like 'canceled_by:%' and su.id = substring(r.error from 13)
      left join ${routineRuns} rr on rr.org_id = ${orgId}::uuid and rr.agent_run_id = r.id
      left join ${routines} rt on rt.id = rr.routine_id
      left join lateral (
        select s.data, s.created_at from ${agentRunSteps} s
        where s.run_id = r.id and s.kind = 'tool_call'
        order by s.seq desc limit 1
      ) last on ${which.active ? sql`true` : sql`false`}
      where r.org_id = ${orgId}::uuid and ${status}
        and (
          exists (select 1 from ${channelMembers} cm
            where cm.org_id = ${orgId}::uuid and cm.channel_id = c.id and cm.user_id = ${userId})
          or (r.background and (${manages} or a.owner_user_id = ${userId}))
        )
      order by ${which.active ? sql`r.created_at desc` : sql`r.finished_at desc`}, r.id desc
      limit ${limit}`),
  );
}

/** What a run waiting on no person waits on (`waitingForBrain`: the executor's wait for its computer or plan). */
function heldOf(r: Row): ManagedTask["held"] {
  if (r.status !== "waiting_input" || !r.wait_code) return null;
  if (r.wait_code === "busy") return "computer_busy";
  if (r.wait_code === "plan_limit") return "plan";
  if (r.wait_code === "budget") return "budget";
  if (r.wait_code === "usage_pause") return r.wait_source === "budget" ? "budget" : "plan";
  return "computer_offline";
}

const planOf = (raw: { state: string }[] | string | null) => {
  const plan = typeof raw === "string" ? (JSON.parse(raw) as { state: string }[]) : (raw ?? []);
  return plan.length ? { done: plan.filter((p) => p.state === "done").length, total: plan.length } : null;
};

const labelOf = (r: Row) =>
  replyExcerpt(r.work_title?.trim() || r.title?.trim() || r.root_body || "", 80) || null;

function nowOf(r: Row): TaskNow | null {
  const data = typeof r.last_data === "string" ? (JSON.parse(r.last_data) as Record<string, unknown>) : r.last_data;
  const tool = str(data?.name);
  if (!data || !tool || !r.last_at) return null;
  return {
    tool,
    detail: str(data.detail),
    connector: str(data.connector),
    service: str(data.service),
    serviceIcon: str(data.serviceIcon),
    at: iso(r.last_at) as string,
  };
}

/** The caller's task manager. */
export async function taskManager(
  db: Database,
  userId: string,
  orgId: string,
  options: { since?: Date; now?: Date } = {},
): Promise<TaskManagerView> {
  const membership = await requireActiveMembership(db, userId, orgId);
  const manages = can(membership, "manage_agents");
  const now = options.now ?? new Date();
  const since = options.since ?? new Date(now.getTime() - 24 * 3600_000);
  const [active, ended] = await Promise.all([
    visibleRuns(db, userId, orgId, manages, { active: true }),
    visibleRuns(db, userId, orgId, manages, { active: false, since }),
  ]);
  const where = (r: Row) => ({
    channelId: r.channel_id,
    channelKind: r.kind,
    channelName: r.kind === "dm" ? null : r.name,
    threadId: r.thread_root_id === r.trigger_message_id ? null : r.thread_root_id,
  });
  const routineOf = (r: Row) => (r.routine_id ? { id: r.routine_id, name: r.routine_name ?? "" } : null);
  const tasks: ManagedTask[] = active.map((r) => ({
    runId: r.id,
    agentId: r.agent_id,
    ...where(r),
    status: r.status as TaskStatus,
    startedAt: iso(r.started_at),
    createdAt: iso(r.created_at) as string,
    label: labelOf(r),
    background: truthy(r.background),
    routine: routineOf(r),
    plan: planOf(r.work_plan),
    requester: r.requester_id ? { userId: r.requester_id, name: r.requester_name ?? "" } : null,
    brain: r.brain,
    machine: r.machine_id ? { id: r.machine_id, name: r.machine_name ?? "" } : null,
    now: nowOf(r),
    steps: Number(r.steps ?? 0),
    pendingMessageIds: pendingIds(r.pending),
    canStop: manages || r.requester_id === userId || r.owner_user_id === userId,
    held: heldOf(r),
  }));
  const endedTasks: EndedTask[] = ended.map((r) => {
    const by = r.error?.startsWith("canceled_by:") ? r.error.slice("canceled_by:".length) : null;
    return {
      runId: r.id,
      agentId: r.agent_id,
      ...where(r),
      status: r.status as EndedTask["status"],
      label: labelOf(r),
      background: truthy(r.background),
      routine: routineOf(r),
      startedAt: iso(r.started_at),
      finishedAt: iso(r.finished_at) as string,
      stoppedBy: by ? { userId: by, name: r.stopper_name ?? "" } : null,
    };
  });
  return { tasks, ended: endedTasks, activity: await agentActivity(db, orgId, now) };
}

/**
 * Tool calls per minute, per agent, over the last `ACTIVITY_MINUTES`: the line on each agent's card. Counts only (no
 * content), from runs that were on in the last hour.
 */
export async function agentActivity(db: Database, orgId: string, now = new Date()): Promise<Record<string, number[]>> {
  const from = new Date(now.getTime() - ACTIVITY_MINUTES * 60_000);
  const rows = rowsOf<{ agent_id: string; ago: number | string; n: number | string }>(
    await db.execute(sql`select r.agent_id,
        floor(extract(epoch from (${now.toISOString()}::timestamptz - s.created_at)) / 60)::int as ago, count(*) as n
      from ${agentRuns} r
      join ${agentRunSteps} s on s.run_id = r.id and s.kind = 'tool_call'
        and s.created_at > ${from.toISOString()}::timestamptz
      where r.org_id = ${orgId}::uuid
        and r.created_at > ${new Date(now.getTime() - 24 * 3600_000).toISOString()}::timestamptz
        and (r.finished_at is null or r.finished_at > ${from.toISOString()}::timestamptz)
      group by 1, 2`),
  );
  const out: Record<string, number[]> = {};
  for (const r of rows) {
    const ago = Number(r.ago);
    if (ago < 0 || ago >= ACTIVITY_MINUTES) continue;
    const line = (out[r.agent_id] ??= Array.from({ length: ACTIVITY_MINUTES }, () => 0));
    line[ACTIVITY_MINUTES - 1 - ago] = Number(r.n);
  }
  return out;
}

/** A task's steps at most (its calls and their ends). */
export const TASK_STEPS_MAX = 400;

export interface TaskStep {
  seq: number;
  kind: "tool_call" | "tool_result" | "model_call";
  data: Record<string, unknown>;
  createdAt: string;
}

/** The computer's own permission check before a command (`PERMISSION_TOOL` in `@agenteschat/adapters`). */
const PERMISSION_TOOL = "permission_prompt";

/**
 * A task's steps for the task manager's "Ver passos" (ADR 0127), to whoever sees the task there: what each call was
 * (the chat chip's fields) and how it ended, never a connector's input or a tool's output (only a permission check's
 * answer, which says whether it ran). The full trail (`getRun`) stays with usage access.
 */
export async function taskSteps(
  db: Database,
  userId: string,
  orgId: string,
  runId: string,
): Promise<{ run: { createdAt: string; finishedAt: string | null }; steps: TaskStep[] }> {
  const membership = await requireActiveMembership(db, userId, orgId);
  const manages = can(membership, "manage_agents");
  const [run] = rowsOf<{ created_at: string | Date; finished_at: string | Date | null }>(
    await db.execute(sql`select r.created_at, r.finished_at
      from ${agentRuns} r
      join ${channels} c on c.id = r.channel_id and c.org_id = ${orgId}::uuid and c.kind in ('channel', 'dm')
      join ${agents} a on a.id = r.agent_id and a.org_id = ${orgId}::uuid
      where r.org_id = ${orgId}::uuid and r.id = ${runId}::uuid
        and (
          exists (select 1 from ${channelMembers} cm
            where cm.org_id = ${orgId}::uuid and cm.channel_id = c.id and cm.user_id = ${userId})
          or (r.background and (${manages} or a.owner_user_id = ${userId}))
        )`),
  );
  if (!run) throw new NotFoundError("Task not found");
  type StepRow = {
    seq: number;
    kind: TaskStep["kind"];
    data: Record<string, unknown> | string;
    created_at: string | Date;
  };
  const rows = rowsOf<StepRow>(
    await db.execute(sql`select s.seq, s.kind, s.data, s.created_at from ${agentRunSteps} s
      where s.run_id = ${runId}::uuid and s.kind in ('tool_call', 'tool_result', 'model_call')
      order by s.seq limit ${TASK_STEPS_MAX}`),
  );
  const steps = rows.map((r): TaskStep => {
    const data = typeof r.data === "string" ? (JSON.parse(r.data) as Record<string, unknown>) : r.data;
    const pick = (keys: string[]) =>
      Object.fromEntries(keys.filter((k) => data[k] !== undefined).map((k) => [k, data[k]]));
    const input = data.input as Record<string, unknown> | undefined;
    const shown =
      r.kind === "tool_call"
        ? {
            ...pick(["toolUseId", "name", "detail", "command", "connector", "service", "serviceIcon"]),
            ...(data.name === PERMISSION_TOOL && typeof input?.request_id === "string"
              ? { input: { request_id: input.request_id } }
              : {}),
          }
        : r.kind === "tool_result"
          ? { ...pick(["toolUseId", "name", "isError"]), ...(data.name === PERMISSION_TOOL ? pick(["content"]) : {}) }
          : pick(["narration", "turn"]);
    return { seq: Number(r.seq), kind: r.kind, data: shown, createdAt: iso(r.created_at) as string };
  });
  return { run: { createdAt: iso(run.created_at) as string, finishedAt: iso(run.finished_at) }, steps };
}
