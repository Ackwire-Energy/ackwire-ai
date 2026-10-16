import {
  allowedBy,
  commandOf,
  PERMISSION_TIMEOUT_MESSAGE,
  PERMISSION_WAIT_MS,
  rulesFor,
  TASK_LIMITS,
} from "@agenteschat/adapters";
import { type Executor, rowsOf, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { publishMessageCreated } from "./events";
import type { MachineTaskRow } from "./machine-tasks";
import { messageView } from "./messages";
import { addMissionAllowRules, blockedOfTask, missionAllowRules } from "./mission-command-rules";
import {
  type MissionDeps,
  type MissionRow,
  noMentions,
  postMissionMessage,
  publishMissionEvent,
  recordMissionEvent,
  requireAct,
  requireMission,
  requireOpen,
  tellSession,
} from "./missions";

const { missionEvents, machineTasks } = schema;

/**
 * Command approvals (ADR 0029): Claude Code asks our MCP tool
 * (`--permission-prompt-tool`) when a work turn wants to run a command off
 * its allow list. A mission rule ("Aprovar sempre nesta missão") allows it
 * at once; otherwise the command card goes to the thread and the runner asks
 * again every few seconds until the owner or someone who decides answers
 * (Aprovar / Recusar / Aprovar sempre), or `PERMISSION_WAIT_MS` passes.
 * Deny-list commands (merges, pushes to the default branch, deploys) never
 * get here: Claude Code and the runner refuse them first. Everything is in
 * the mission's feed: `command_prompt`, `command_decided`, `command_rule`.
 */

export type CommandDecision = "allow" | "deny" | "always";
export type CommandState = "pending" | "allowed" | "denied" | "expired";

/** Prompts per task in 10 minutes: a loop can't flood the thread. */
export const COMMAND_PROMPTS_PER_TASK = 10;

export interface MissionCommandView {
  id: string;
  missionId: string;
  taskId: string;
  tool: string;
  command: string;
  state: CommandState;
  /** "Aprovar sempre": the rules it would add. */
  rules: string[];
  decidedBy: string | null;
  decidedAt: string | null;
  /** The person chose "Aprovar sempre". */
  always: boolean;
  createdAt: string;
  expiresAt: string;
}

interface PromptRow {
  kind: string;
  data: Record<string, unknown> | string;
  created_at: Date | string;
}

const iso = (v: Date | string) => (v instanceof Date ? v : new Date(v)).toISOString();
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** The mission's prompts with their state, newest first (or one, by id). */
async function readPrompts(db: Executor, missionId: string, promptId?: string): Promise<MissionCommandView[]> {
  const rows = rowsOf<PromptRow>(
    await db.execute(sql`select kind, data, created_at from ${missionEvents}
      where mission_id = ${missionId}::uuid and kind in ('command_prompt', 'command_decided')
        ${promptId ? sql`and data->>'promptId' = ${promptId}` : sql``}
      order by created_at
      limit 2000`),
  );
  const byId = new Map<string, MissionCommandView>();
  for (const r of rows) {
    const d = (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as Record<string, unknown>;
    const id = str(d.promptId);
    if (!id) continue;
    if (r.kind === "command_prompt") {
      const created = iso(r.created_at);
      byId.set(id, {
        id,
        missionId,
        taskId: str(d.taskId),
        tool: str(d.tool),
        command: str(d.command),
        state: "pending",
        rules: Array.isArray(d.rules) ? d.rules.map(String) : [],
        decidedBy: null,
        decidedAt: null,
        always: false,
        createdAt: created,
        expiresAt: new Date(Date.parse(created) + PERMISSION_WAIT_MS).toISOString(),
      });
      continue;
    }
    const p = byId.get(id);
    if (!p || p.state !== "pending") continue;
    const decision = str(d.decision);
    p.state = decision === "expired" ? "expired" : decision === "deny" ? "denied" : "allowed";
    p.always = decision === "always";
    p.decidedBy = str(d.by) || null;
    p.decidedAt = iso(r.created_at);
  }
  const now = Date.now();
  // Past its wait with nobody answering: expired (the runner stopped asking).
  for (const p of byId.values()) if (p.state === "pending" && Date.parse(p.expiresAt) <= now) p.state = "expired";
  return [...byId.values()].reverse();
}

const allow = () => JSON.stringify({ behavior: "allow" });
const deny = (message: string) => JSON.stringify({ behavior: "deny", message });

/**
 * `permission_prompt` from the runner: a new prompt (`tool_name`, `input`),
 * or the state of one it made (`request_id`). Answers JSON: `{behavior}`
 * when decided, `{status: "pending", request_id}` while it waits.
 */
export async function handlePermissionPrompt(
  deps: MissionDeps,
  mission: MissionRow,
  task: MachineTaskRow,
  args: Record<string, unknown>,
): Promise<string> {
  const requestId = str(args.request_id);
  if (requestId) {
    const [p] = await readPrompts(deps.db, mission.id, requestId);
    if (!p || p.taskId !== task.id) return deny("That request is unknown.");
    if (p.state === "allowed") return allow();
    if (p.state === "denied")
      return deny("A person said no. Don't try this command again; continue another way or report.");
    if (p.state === "expired") return deny(PERMISSION_TIMEOUT_MESSAGE);
    return JSON.stringify({ status: "pending", request_id: p.id });
  }
  const tool = str(args.tool_name).slice(0, 64);
  const input =
    typeof args.input === "object" && args.input !== null && !Array.isArray(args.input)
      ? (args.input as Record<string, unknown>)
      : {};
  const command = commandOf(tool, input);
  if (!tool || !command) return deny("Unknown tool.");
  if (mission.status !== "active") return deny("The plan isn't approved yet: only read for now.");
  // "Aprovar sempre nesta missão" covers it.
  if (allowedBy(await missionAllowRules(deps.db, mission.id), tool, input)) return allow();
  const recent = (await readPrompts(deps.db, mission.id)).filter((p) => p.taskId === task.id);
  // Asked again while the card is open (Claude Code retries): the same card.
  const open = recent.find((p) => p.state === "pending" && p.command === command && p.tool === tool);
  if (open) return JSON.stringify({ status: "pending", request_id: open.id });
  const lately = recent.filter((p) => Date.now() - Date.parse(p.createdAt) < 10 * 60_000);
  if (lately.length >= COMMAND_PROMPTS_PER_TASK) {
    return deny(
      `Too many commands to approve in a row (at most ${COMMAND_PROMPTS_PER_TASK} in 10 minutes). Continue with what is allowed, or report what you need and stop.`,
    );
  }
  const promptId = crypto.randomUUID();
  const rules = rulesFor(tool, input);
  const shown = noMentions(command).slice(0, TASK_LIMITS.denial * 2);
  const message = await deps.db.transaction(async (tx) => {
    await recordMissionEvent(tx, mission, "command_prompt", {
      promptId,
      taskId: task.id,
      sessionId: task.sessionId,
      tool,
      command: shown,
      rules,
    });
    return postMissionMessage(
      deps,
      mission,
      `${executorName(task.executor)} wants to run: \`${shown}\``,
      {
        missionCommand: { id: promptId, missionId: mission.id, taskId: task.id, tool, command: shown },
        bodyCode: "mission_command",
        bodyParams: { command: shown, executor: executorName(task.executor) },
      },
      tx,
    );
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(message));
  await publishMissionEvent(deps, mission, "command", { promptId });
  return JSON.stringify({ status: "pending", request_id: promptId });
}

const executorName = (e: string | null | undefined) => (e === "codex" ? "Codex" : "Claude Code");

/** The command cards of a mission (who reads its conversation). */
export async function listMissionCommands(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const { mission } = await requireMission(deps, userId, orgId, missionId);
  return {
    commands: await readPrompts(deps.db, mission.id),
    rules: await missionAllowRules(deps.db, mission.id),
  };
}

/** Aprovar / Recusar / Aprovar sempre nesta missão: the owner or someone who decides. */
export async function decideCommand(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  missionId: string,
  promptId: string,
  decision: CommandDecision,
) {
  if (!["allow", "deny", "always"].includes(decision)) throw new ValidationError("Unknown decision");
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "answer the executor's commands");
  requireOpen(mission);
  const [p] = await readPrompts(deps.db, mission.id, promptId);
  if (!p) throw new NotFoundError("Command not found", "mission.command_not_found");
  if (p.state !== "pending") {
    throw new ConflictError(
      p.state === "expired" ? "Nobody answered in time; the command was denied" : "Already answered",
      p.state === "expired" ? "mission.command_expired" : "mission.command_decided",
    );
  }
  await deps.db.transaction(async (tx) => {
    await recordMissionEvent(tx, mission, "command_decided", { promptId, decision, by: userId });
    if (decision === "always") await addMissionAllowRules(tx, mission, p.rules, { userId, promptId });
  });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: `mission.command_${decision}`,
    target: { type: "mission", id: mission.id },
    details: { promptId, command: p.command.slice(0, 300), ...(decision === "always" ? { rules: p.rules } : {}) },
  });
  await publishMissionEvent(deps, mission, "command", { promptId });
  const [after] = await readPrompts(deps.db, mission.id, promptId);
  return after as MissionCommandView;
}

/**
 * "Liberar e repetir" on a task's end notice: the command it was refused
 * becomes a mission rule and its session is resumed to try again.
 */
export async function retryBlockedCommand(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  missionId: string,
  input: { taskId: string; command: string },
) {
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "allow the executor's commands");
  requireOpen(mission);
  if (!/^[0-9a-f-]{36}$/i.test(input.taskId)) throw new NotFoundError("Task not found", "task.not_found");
  const blocked = await blockedOfTask(deps.db, mission.id, input.taskId);
  const denial = blocked.find((d) => d.command === input.command);
  if (!denial) throw new NotFoundError("That command wasn't blocked", "mission.command_not_found");
  const rows = rowsOf<{ session_id: string | null; cwd: string | null }>(
    await deps.db.execute(sql`select session_id, cwd from ${machineTasks}
      where id = ${input.taskId}::uuid and mission_id = ${mission.id}::uuid`),
  );
  const task = rows[0];
  if (!task?.session_id) throw new NotFoundError("Task not found", "task.not_found");
  // A non-shell tool's line is "<Tool> <what>" (`WebFetch https://…`).
  const what = denial.command.slice(denial.tool.length).trim();
  const rules = rulesFor(denial.tool, denial.tool === "Bash" ? { command: denial.command } : { url: what });
  const added = await addMissionAllowRules(deps.db, mission, rules, { userId });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "mission.command_retry",
    target: { type: "mission", id: mission.id },
    details: { taskId: input.taskId, command: denial.command.slice(0, 300), rules },
  });
  const sent = await tellSession(
    deps,
    mission,
    { sessionId: task.session_id, cwd: task.cwd },
    `The command was allowed; retry it: ${denial.command}`,
    { requestedBy: userId, from: "a person", kind: "person" },
  );
  await publishMissionEvent(deps, mission, "command", { taskId: input.taskId });
  return { rules: added.length ? added : rules, delivered: sent.delivered };
}
