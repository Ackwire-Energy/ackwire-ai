import { BRAIN_PROTOCOL } from "@agenteschat/adapters";
import { and, type Executor, eq, schema } from "@agenteschat/db";
import type { Agent } from "../agents";
import type { MachineStatus } from "../machine-hub";
import { pausedMessage } from "../machines";
import { missionTurnFor } from "../missions-engine";
import type { AgentRun } from "../runs";
import { brainSessionId, claudeCodeAvailability } from "./claude-code";
import { codexVersionOk } from "./codex";
import type { BrainKind, BrainSession } from "./types";

const KINDS: readonly BrainKind[] = ["model", "claude_code", "codex"];
const kindOf = (v: unknown): BrainKind => (KINDS.includes(v as BrainKind) ? (v as BrainKind) : "model");

/** A mission's choice for a run in its thread (`missionTurnFor`). */
export interface MissionTurn {
  missionId: string;
  brain: BrainKind;
  model?: string;
  session?: BrainSession;
}

/**
 * Which brain thinks for this run (ADR 0032 §5), by priority: the mission's
 * brain when the run is its main session (`missionTurnFor`), else the
 * agent's stored brain (`agents.brain`, block 3a). Availability is checked
 * separately (`computerBrainUnavailable`); the engine falls back from there.
 */
export function brainFor(
  agent: Pick<Agent, "brain">,
  _run: Pick<AgentRun, "id">,
  mission?: Pick<MissionTurn, "brain"> | null,
): BrainKind {
  return mission?.brain ?? kindOf(agent.brain);
}

/** Plan limits seen on this process (`limit` events), by machine and brain: until when they hold. */
const planLimits = new Map<string, number>();
const limitKey = (machineId: string, kind: BrainKind) => `${machineId}:${kind}`;

/** A computer brain hit its plan limit (until `resetsAt`, or an hour when unknown). */
export function notePlanLimit(machineId: string, kind: BrainKind, resetsAt?: string, now = Date.now()) {
  const until = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  planLimits.set(limitKey(machineId, kind), Number.isFinite(until) && until > now ? until : now + 3600_000);
}

/** Tests: forget the plan limits seen. */
export function clearPlanLimits() {
  planLimits.clear();
}

export interface BrainUnavailability {
  code: string;
  message: string;
  resetsAt?: string;
}

/**
 * Why a computer brain can't take the turn now (null: it can): no computer,
 * offline, paused by its owner, commands off, a runner older than protocol 8, the CLI missing or
 * not logged in (`hello.executors`), or over the plan limit.
 */
export function computerBrainUnavailable(
  kind: BrainKind,
  machineId: string | null,
  status: MachineStatus | null,
  now = Date.now(),
): BrainUnavailability | null {
  if (kind === "model") return null;
  const name = kind === "codex" ? "Codex" : "Claude Code";
  if (!machineId) return { code: "no_computer", message: `The agent has no computer for ${name}.` };
  const limited = planLimits.get(limitKey(machineId, kind));
  if (limited && limited > now) {
    return {
      code: "plan_limit",
      message: `${name}${status ? ` on ${status.name}` : ""} reached its plan limit.`,
      resetsAt: new Date(limited).toISOString(),
    };
  }
  // Paused by its owner (ADR 0036 §6): like offline, until the pause ends (a known end: try again then).
  const pausedUntil = status?.online && status.paused?.until ? { resetsAt: status.paused.until } : {};
  if (kind === "claude_code") {
    const e = claudeCodeAvailability(status);
    if (e?.type !== "error") return null;
    return { code: e.code, message: e.message, ...(e.code === "machine_paused" ? pausedUntil : {}) };
  }
  if (!status?.online) {
    return { code: "machine_offline", message: `Codex${status ? ` on ${status.name}` : ""} is offline.` };
  }
  if (status.paused) {
    return {
      code: "machine_paused",
      message: pausedMessage(status.name, status.paused.until, status.paused.timezone),
      ...pausedUntil,
    };
  }
  if (!status.execAllowed) return { code: "exec_disabled", message: `Commands are turned off on ${status.name}.` };
  if (status.protocol < BRAIN_PROTOCOL) {
    return { code: "runner_outdated", message: `The runner on ${status.name} is too old for Codex agents; update it.` };
  }
  const codex = status.executors?.codex;
  if (status.executors?.detectedAt && !codex) {
    return { code: "codex_missing", message: `Codex is not installed on ${status.name}.` };
  }
  if (codex && !codexVersionOk(codex.version)) {
    return { code: "codex_too_old", message: `Codex on ${status.name} is too old; update it there.` };
  }
  return null;
}

/** Brain errors that mean "not now on this computer": they fall back, or the message waits. */
export const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "no_session",
  "no_computer",
  "machine_offline",
  "machine_paused",
  "exec_disabled",
  "runner_outdated",
  "cli_missing",
  "not_logged_in",
  "codex_missing",
  "codex_too_old",
  "plan_limit",
]);

/** What the engine runs a turn with. */
export interface BrainPlan {
  kind: BrainKind;
  /** The brain's model (`opus`, `sonnet`, a Codex model); undefined = the brain's default (model brain: the agent's). */
  model?: string;
  session?: BrainSession;
  missionId?: string;
  /** Set when the computer brain can't take the turn now. */
  unavailable?: BrainUnavailability;
}

/** What a Claude Code brain's model is when nobody chose one (Codex: its own default). */
const DEFAULT_MODELS: Partial<Record<BrainKind, string>> = { claude_code: "sonnet" };

/**
 * The model a computer brain thinks with: the mission's choice, else the
 * agent's own model when the agent thinks with this same brain (an Opus
 * chosen for Claude Code means nothing to Codex), else the brain's default.
 */
export function brainModelFor(
  kind: BrainKind,
  agent: Pick<Agent, "brain" | "brainModel">,
  mission?: Pick<MissionTurn, "model"> | null,
): string | undefined {
  if (kind === "model") return undefined;
  const agentModel = kindOf(agent.brain) === kind ? (agent.brainModel ?? undefined) : undefined;
  return mission?.model ?? agentModel ?? DEFAULT_MODELS[kind];
}

/**
 * Whether this agent already thought with this brain in this conversation
 * (plan usage is recorded per run): then the session exists on the machine
 * and the turn resumes it. A hint: the runner checks its own disk.
 */
async function sessionUsed(db: Executor, run: AgentRun, kind: BrainKind, conversation: string) {
  const { agentRuns, usageRecords } = schema;
  const [row] = await db
    .select({ id: usageRecords.id })
    .from(usageRecords)
    .innerJoin(agentRuns, eq(agentRuns.id, usageRecords.runId))
    .where(
      and(
        eq(usageRecords.orgId, run.orgId),
        eq(usageRecords.agentId, run.agentId),
        eq(usageRecords.provider, kind),
        eq(agentRuns.channelId, run.channelId),
        // A flat conversation (a DM) is the channel itself; a thread is its root.
        ...(conversation === run.channelId ? [] : [eq(agentRuns.threadRootId, conversation)]),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * The brain, model and session of a run: the mission's when the run is its
 * main session, else the agent's; for a
 * computer brain, its availability on the agent's computer (checked when
 * `machines` is given; the brains check again). `conversation`: the thread
 * the run answers in, or the channel for a flat DM.
 */
export async function resolveBrain(
  deps: {
    db: Executor;
    machines?: { status(machineId: string): Promise<MachineStatus | null> };
  },
  agent: Agent,
  run: AgentRun,
  conversation: string,
): Promise<BrainPlan> {
  const mission: MissionTurn | null = await missionTurnFor(deps.db, run).catch(() => null);
  const kind = brainFor(agent, run, mission);
  const base = mission ? { missionId: mission.missionId } : {};
  if (kind === "model") return { kind, ...base };
  const model = brainModelFor(kind, agent, mission);
  const machineId = mission?.session?.machineId ?? agent.machineId ?? null;
  const status = machineId && deps.machines ? await deps.machines.status(machineId).catch(() => null) : null;
  const unavailable = machineId && !deps.machines ? null : computerBrainUnavailable(kind, machineId, status);
  const session: BrainSession | undefined =
    mission?.session ??
    (machineId
      ? {
          id: brainSessionId(agent.id, conversation, kind),
          resume: await sessionUsed(deps.db, run, kind, conversation).catch(() => false),
          machineId,
          cwd: "",
        }
      : undefined);
  return {
    kind,
    ...base,
    ...(model ? { model } : {}),
    ...(session ? { session } : {}),
    ...(unavailable ? { unavailable } : {}),
  };
}
