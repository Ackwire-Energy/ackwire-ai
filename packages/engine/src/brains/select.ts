import { BRAIN_PROTOCOL, type BrainEffort, isBrainEffort } from "@agenteschat/adapters";
import { and, desc, type Executor, eq, isNotNull, ne, schema, sql } from "@agenteschat/db";
import type { Agent } from "../agents";
import type { MachineStatus } from "../machine-hub";
import { pausedMessage } from "../machines";
import { missionTurnFor } from "../missions-engine";
import type { AgentRun } from "../runs";
import { accountUnavailable, brainSessionId, claudeCodeAvailability, toolOff } from "./claude-code";
import { codexVersionOk } from "./codex";
import type { BrainAccount, BrainKind, BrainSession } from "./types";

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

/**
 * The brain a run thinks with (ADR 0053 §10): its own (`agent_runs.brain`, stored when the engine resolves
 * it and when a conversation run falls back), else the agent's until its first turn. Shared code (steering,
 * the talker, "Continuar", the forum budget) reads this, never the agent's stored brain alone.
 */
export const runBrainOf = (run: { brain?: string | null }, agent?: { brain?: string | null } | null): BrainKind =>
  kindOf(run.brain ?? agent?.brain);

/** Stores the brain a run thinks with now (`agent_runs.brain`). */
export async function recordRunBrain(db: Executor, runId: string, kind: BrainKind) {
  await db.update(schema.agentRuns).set({ brain: kind }).where(eq(schema.agentRuns.id, runId));
}

/**
 * Whether a run whose computer brain can't answer may hand the turn to the model brain (ADR 0032 §5).
 * Never a background run (ADR 0053 §6.4): a routine thinks with its agent's own brain and waits quietly
 * for its computer instead; the agent's owner may also turn the fallback off.
 */
export const mayFallBack = (agent: Pick<Agent, "brainFallback">, run: Pick<AgentRun, "background">) =>
  !run.background && agent.brainFallback !== false;

/** Plan limits seen on this process (`limit` events), by machine, brain and account: until when they hold. */
const planLimits = new Map<string, number>();
/** No account: the computer's own sign-in. Each account (ADR 0041) has its own plan, so its own limit. */
const limitKey = (machineId: string, kind: BrainKind, accountId?: string) =>
  `${machineId}:${kind}:${accountId ?? "own"}`;

/** A computer brain hit its plan limit (until `resetsAt`, or an hour when unknown). */
export function notePlanLimit(
  machineId: string,
  kind: BrainKind,
  resetsAt?: string,
  now = Date.now(),
  accountId?: string,
) {
  const until = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  planLimits.set(limitKey(machineId, kind, accountId), Number.isFinite(until) && until > now ? until : now + 3600_000);
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
 * someone else's plan, offline, paused by its owner, commands off, a runner older than protocol 8,
 * the CLI missing or not logged in (`hello.executors`), or over the plan limit.
 */
export function computerBrainUnavailable(
  kind: BrainKind,
  machineId: string | null,
  status: MachineStatus | null,
  now = Date.now(),
  /** The agent's account (ADR 0041): it decides the sign-in instead of the computer's own. */
  account?: BrainAccount,
  /** The plan it would think with is the agent's owner's (`planIsOwners`). */
  ownersPlan = true,
): BrainUnavailability | null {
  if (kind === "model") return null;
  const name = kind === "codex" ? "Codex" : "Claude Code";
  if (!machineId) return { code: "no_computer", message: `The agent has no computer for ${name}.` };
  if (!ownersPlan) {
    return {
      code: "plan_not_owner",
      message: `${name}${status ? ` on ${status.name}` : ""} would think with a plan that isn't the agent's owner's.`,
    };
  }
  const limited = planLimits.get(limitKey(machineId, kind, account?.id));
  if (limited && limited > now) {
    return {
      code: "plan_limit",
      message: account
        ? `The ${name} account "${account.label}"${status ? ` on ${status.name}` : ""} reached its plan limit.`
        : `${name}${status ? ` on ${status.name}` : ""} reached its plan limit.`,
      resetsAt: new Date(limited).toISOString(),
    };
  }
  // Paused by its owner (ADR 0036 §6): like offline, until the pause ends (a known end: try again then).
  const pausedUntil = status?.online && status.paused?.until ? { resetsAt: status.paused.until } : {};
  if (kind === "claude_code") {
    const e = claudeCodeAvailability(status, account);
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
  const off = toolOff(status, "codex");
  if (off) return off;
  if (status.protocol < BRAIN_PROTOCOL) {
    return { code: "runner_outdated", message: `The runner on ${status.name} is too old for Codex agents. Update it.` };
  }
  const codex = status.executors?.codex;
  if (status.executors?.detectedAt && !codex) {
    return { code: "codex_missing", message: `Codex is not installed on ${status.name}.` };
  }
  if (codex && !codexVersionOk(codex.version)) {
    return { code: "codex_too_old", message: `Codex on ${status.name} is too old. Update it there.` };
  }
  return accountUnavailable(status, account, "codex");
}

/**
 * Brain errors that mean "not now on this computer": they fall back, or the message waits. `busy`: the
 * computer had no room for the turn, and the run looks again on a timer (`COMPUTER_BUSY_RETRY_MS`).
 */
export const UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  "busy",
  "no_session",
  "no_computer",
  "machine_offline",
  "machine_paused",
  "exec_disabled",
  "tool_off",
  "runner_outdated",
  "cli_missing",
  "not_logged_in",
  "codex_missing",
  "codex_too_old",
  "plan_limit",
  "plan_not_owner",
]);

/**
 * Unavailable codes that mean the computer brain has nothing to think with (no computer, its command-line
 * tool missing or signed out), not "later": nothing signals a sign-in, so a wait for them would never end.
 */
export const NO_AI_CODES: ReadonlySet<string> = new Set([
  "no_computer",
  "cli_missing",
  "not_logged_in",
  "codex_missing",
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
  /** The agent's account for this brain on this computer (ADR 0041); absent: the computer's own sign-in. */
  account?: BrainAccount;
  /** How hard the computer brain thinks; absent: the CLI's default. */
  effort?: BrainEffort;
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
 * The agent's account and effort apply to its own brain on its own computer:
 * not to a mission that thinks with another brain, nor on the mission's
 * computer when it is another one. A removed account is no account.
 */
export async function brainAccountFor(
  db: Executor,
  agent: Pick<Agent, "orgId" | "brain" | "brainAccountId" | "machineId">,
  kind: BrainKind,
  machineId: string | null,
): Promise<BrainAccount | undefined> {
  if (!agent.brainAccountId || !machineId || machineId !== agent.machineId || kindOf(agent.brain) !== kind) {
    return undefined;
  }
  const { machineAccounts } = schema;
  const [row] = await db
    .select({
      id: machineAccounts.id,
      label: machineAccounts.label,
      status: machineAccounts.status,
      kind: machineAccounts.kind,
    })
    .from(machineAccounts)
    .where(
      and(
        eq(machineAccounts.orgId, agent.orgId),
        eq(machineAccounts.id, agent.brainAccountId),
        eq(machineAccounts.machineId, machineId),
      ),
    );
  if (!row || row.kind !== kind) return undefined;
  // A sign-in still in progress or an account being removed can't think: as good as signed out.
  return { id: row.id, label: row.label, status: row.status === "active" ? "active" : "signed_out" };
}

/**
 * A plan thinks only for its owner's agents (ADR 0059 §3): the account's
 * owner, or with the computer's own sign-in the person who connected that
 * computer, must be the agent's owner, still in the organization.
 */
async function planIsOwners(
  db: Executor,
  agent: Pick<Agent, "orgId" | "ownerUserId">,
  machineId: string,
  account: BrainAccount | undefined,
): Promise<boolean> {
  const owner = agent.ownerUserId;
  if (!owner) return false;
  const { machineAccounts, machines, organizationMembers: members } = schema;
  const rows = account
    ? await db
        .select({ id: machineAccounts.id })
        .from(machineAccounts)
        .innerJoin(
          members,
          and(eq(members.orgId, machineAccounts.orgId), eq(members.userId, machineAccounts.createdBy)),
        )
        .where(
          and(
            eq(machineAccounts.orgId, agent.orgId),
            eq(machineAccounts.id, account.id),
            eq(machineAccounts.createdBy, owner),
          ),
        )
    : await db
        .select({ id: machines.id })
        .from(machines)
        .innerJoin(members, and(eq(members.orgId, machines.orgId), eq(members.userId, machines.pairedByUserId)))
        .where(and(eq(machines.orgId, agent.orgId), eq(machines.id, machineId), eq(machines.pairedByUserId, owner)));
  return rows.length > 0;
}

/** The agent's effort when it thinks with its own brain (a mission's other brain: the CLI's default). */
export function brainEffortFor(agent: Pick<Agent, "brain" | "brainEffort">, kind: BrainKind): BrainEffort | undefined {
  if (kind === "model" || kindOf(agent.brain) !== kind) return undefined;
  return isBrainEffort(agent.brainEffort) ? agent.brainEffort : undefined;
}

/** A conversation's session is picked up again only this soon after its last turn (its prompt cache is gone after). */
export const SESSION_IDLE_MS = 60 * 60_000;
/**
 * …and only while its last turn read less than this (input + cache, summed
 * over the turn's model calls): past it every turn re-reads a huge history,
 * so a fresh session starts with the recent messages instead.
 */
export const SESSION_MAX_INPUT_TOKENS = 150_000;

/** Whether a session already ran on the machine (plan usage recorded for one of its runs): resume it. A hint: the runner checks its own disk. */
async function sessionUsed(db: Executor, run: AgentRun, kind: BrainKind, sessionId: string) {
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
        eq(agentRuns.brainSessionId, sessionId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * The computer brain's session for a run (stored on the run, so a pause
 * resumes the same one): the conversation's previous session while it is
 * recent and small, else a fresh one. A routine or background run always starts fresh
 * (each firing is its own task; resuming made one routine re-read 700k tokens), and its
 * session is never carried to a conversation run.
 */
async function sessionFor(
  db: Executor,
  agent: Agent,
  run: AgentRun,
  kind: BrainKind,
  conversation: string,
  options: { fresh?: boolean },
  now: Date,
): Promise<{ id: string; resume: boolean }> {
  if (run.brainSessionId) {
    return { id: run.brainSessionId, resume: await sessionUsed(db, run, kind, run.brainSessionId) };
  }
  let id: string | null = null;
  if (!options.fresh && !run.background) {
    const { agentRuns, usageRecords, messages } = schema;
    const [last] = await db
      .select({
        id: agentRuns.id,
        sessionId: agentRuns.brainSessionId,
        at: sql<Date>`coalesce(${agentRuns.finishedAt}, ${agentRuns.updatedAt})`.mapWith(
          (v: string | Date) => new Date(v),
        ),
        // Qualified by hand: inside the subquery a bare "id" would be usage_records.id.
        input: sql<number>`coalesce((select max(u.input_tokens) from ${usageRecords} u
          where u.run_id = "agent_runs"."id" and u.provider = ${kind}), 0)`.mapWith(Number),
      })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.orgId, run.orgId),
          eq(agentRuns.agentId, run.agentId),
          eq(agentRuns.channelId, run.channelId),
          // A flat conversation (a DM) is the channel itself; a thread is its root.
          ...(conversation === run.channelId ? [] : [eq(agentRuns.threadRootId, conversation)]),
          isNotNull(agentRuns.brainSessionId),
          ne(agentRuns.id, run.id),
          // Never a session background work thought in (a routine's: it was told to answer NO_REPLY, and a
          // conversation that picked it up answered that). Any run that shared it counts, older rows too.
          sql`not exists (select 1 from ${agentRuns} r2
            where r2.org_id = "agent_runs"."org_id" and r2.agent_id = "agent_runs"."agent_id"
              and r2.brain_session_id = "agent_runs"."brain_session_id"
              and (r2.background or exists (select 1 from ${messages} m
                where m.org_id = r2.org_id and m.id = r2.trigger_message_id and m.meta->'routine' is not null)))`,
        ),
      )
      .orderBy(desc(agentRuns.createdAt))
      .limit(1);
    if (
      last?.sessionId &&
      now.getTime() - last.at.getTime() < SESSION_IDLE_MS &&
      last.input < SESSION_MAX_INPUT_TOKENS
    ) {
      id = last.sessionId;
    }
  }
  const sessionId = id ?? brainSessionId(agent.id, `${conversation}:${run.id}`, kind);
  await db.update(schema.agentRuns).set({ brainSessionId: sessionId }).where(eq(schema.agentRuns.id, run.id));
  return { id: sessionId, resume: id ? await sessionUsed(db, run, kind, sessionId) : false };
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
  /** `fresh`: a new computer session whatever the conversation had (routine runs). */
  options: { fresh?: boolean; now?: Date } = {},
): Promise<BrainPlan> {
  const mission: MissionTurn | null = await missionTurnFor(deps.db, run).catch(() => null);
  const kind = brainFor(agent, run, mission);
  const base = mission ? { missionId: mission.missionId } : {};
  if (kind === "model") return { kind, ...base };
  const model = brainModelFor(kind, agent, mission);
  const machineId = mission?.session?.machineId ?? agent.machineId ?? null;
  const [status, account] = await Promise.all([
    machineId && deps.machines ? deps.machines.status(machineId).catch(() => null) : null,
    brainAccountFor(deps.db, agent, kind, machineId),
  ]);
  const effort = brainEffortFor(agent, kind);
  const unavailable =
    machineId && !deps.machines
      ? null
      : computerBrainUnavailable(
          kind,
          machineId,
          status,
          Date.now(),
          account,
          machineId ? await planIsOwners(deps.db, agent, machineId, account) : true,
        );
  const session: BrainSession | undefined =
    mission?.session ??
    (machineId
      ? {
          ...(await sessionFor(deps.db, agent, run, kind, conversation, options, options.now ?? new Date())),
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
    ...(account ? { account } : {}),
    ...(effort ? { effort } : {}),
  };
}
