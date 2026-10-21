import { ACCOUNTS_PROTOCOL, BRAIN_PROTOCOL, type BrainEffort, isBrainEffort } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { MODEL_CATALOG } from "@agenteschat/providers";
import { getAgent } from "./agents";
import { recordAudit } from "./audit";
import type { BrainKind } from "./brains/types";
import { caches } from "./cache";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { getMachineAccount, listMachineAccounts, type MachineAccountView } from "./machine-accounts";
import { getMachine, type MachineRow, machineOnline } from "./machines";
import {
  type MissionDeps,
  type MissionRow,
  machineExecutors,
  OPEN_MISSION_STATUSES,
  publishMissionEvent,
  recordMissionEvent,
  requireAct,
  requireMission,
  requireOpen,
} from "./missions";
import { can, getMembership, requirePermission } from "./organizations";

/*
 * "Quem pensa" (ADR 0032 §5): the brain an agent thinks with, its model and
 * the fallback to the API, stored on the agent (`agents.brain*`), and a
 * mission's override (`missions.brain*`). This module stores and validates
 * the choice and says what the agent's computer can offer; the engine
 * resolves it per run (`brainFor`).
 */

export const BRAIN_KINDS: readonly BrainKind[] = ["model", "claude_code", "codex"];
export const isBrainKind = (v: unknown): v is BrainKind =>
  typeof v === "string" && (BRAIN_KINDS as readonly string[]).includes(v);
/** Brains that run on the agent's computer with a person's plan. */
export const isComputerBrain = (v: unknown): v is "claude_code" | "codex" => v === "claude_code" || v === "codex";
/** A stored value read back (anything unknown is the model brain). */
export const brainOf = (v: unknown): BrainKind => (isBrainKind(v) ? v : "model");

export interface BrainModelOption {
  /** What is stored and passed to the CLI (`--model opus`, `-m gpt-…`). */
  value: string;
  label: string;
  /** The model id behind an alias (Claude Code's `opus` → `claude-opus-5-5`). */
  modelId?: string;
  recommended?: boolean;
}

/** Claude Code's aliases (`--model opus|sonnet|haiku`), mapped to today's ids in the catalog. */
export const CLAUDE_CODE_MODELS: readonly BrainModelOption[] = [
  { value: "opus", label: "Opus", modelId: "claude-opus-5-5" },
  { value: "sonnet", label: "Sonnet", modelId: "claude-sonnet-5-5", recommended: true },
  { value: "haiku", label: "Haiku", modelId: "claude-haiku-5-5" },
];

/** Codex's models: the OpenAI rows of the catalog (any other name is accepted as typed). */
export const codexModels = (): BrainModelOption[] =>
  Object.entries(MODEL_CATALOG)
    .filter(([, m]) => m.provider === "openai")
    .map(([id, m]) => ({ value: id, label: m.label, modelId: id, ...(m.recommended ? { recommended: true } : {}) }));

/** The model choices of a brain (none for the model brain: it uses the agent's model). */
export function brainModelOptions(kind: BrainKind): BrainModelOption[] {
  if (kind === "claude_code") return [...CLAUDE_CODE_MODELS];
  if (kind === "codex") return codexModels();
  return [];
}

/** What a computer brain runs with when nobody chose a model. */
export function defaultBrainModel(kind: BrainKind): string | null {
  if (kind === "model") return null;
  const options = brainModelOptions(kind);
  return (options.find((o) => o.recommended) ?? options[0])?.value ?? (kind === "codex" ? "gpt-6.1-sol" : "sonnet");
}

/** The model id behind a stored value (an alias resolved; anything else as is). */
export function brainModelId(kind: BrainKind, model: string | null | undefined): string | undefined {
  const value = model ?? defaultBrainModel(kind);
  if (!value) return undefined;
  return brainModelOptions(kind).find((o) => o.value === value)?.modelId ?? value;
}

const FREE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;

/**
 * A model for a brain, as stored: null = the brain's default. Claude Code
 * takes its aliases or a full Claude id; Codex any model name (a new one
 * may come out before our catalog knows it); the model brain none.
 */
export function normalizeBrainModel(kind: BrainKind, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new ValidationError("The model is a name", "brain.invalid_model");
  const v = value.trim();
  if (kind === "model") {
    throw new ValidationError("The API brain uses the agent's model", "brain.invalid_model");
  }
  if (kind === "claude_code") {
    const alias = CLAUDE_CODE_MODELS.find((o) => o.value === v.toLowerCase() || o.modelId === v);
    if (alias) return alias.value;
    if (/^claude-[a-z0-9.-]{1,60}$/.test(v)) return v;
    throw new ValidationError("Choose Opus, Sonnet or Haiku", "brain.invalid_model", { brain: kind });
  }
  if (!FREE_MODEL.test(v)) throw new ValidationError("That isn't a model name", "brain.invalid_model", { brain: kind });
  return v;
}

/** Why a computer brain can't be chosen right now. */
export type BrainUnavailable = "no_computer" | "exec_off" | "runner_old" | "tool_off" | "not_installed" | "outdated";

export interface BrainOption {
  kind: BrainKind;
  available: boolean;
  reason?: BrainUnavailable;
  /** Codex is still being tested ("Em teste"). */
  experimental: boolean;
  models: BrainModelOption[];
  defaultModel: string | null;
}

type MachineLike = Parameters<typeof machineExecutors>[0] & {
  id: string;
  name: string;
  /** Protocol 10: what the machine allows (the app's Ferramentas); absent on older runners. */
  access?: { tools?: { claude?: boolean; codex?: boolean } } | null;
} & Parameters<typeof machineOnline>[0];

/**
 * What the agent's computer can think with; the model brain always. A
 * computer brain needs the runner's `brain.turn` (`BRAIN_PROTOCOL`, the same
 * check the engine makes per run): an older runner is `runner_old`.
 * (Missions' legacy executor tasks keep their own check, `machineExecutors`.)
 */
export function brainOptions(machine: MachineLike | null): BrainOption[] {
  const found = machine ? machineExecutors(machine) : null;
  const computer = (kind: "claude_code" | "codex", executor: "claude" | "codex"): BrainOption => {
    let reason: BrainUnavailable | undefined;
    if (!machine) reason = "no_computer";
    else if (!machine.execAllowed) reason = "exec_off";
    else if (machine.protocol < BRAIN_PROTOCOL) reason = "runner_old";
    else if (machine.access?.tools && machine.access.tools[executor] === false) reason = "tool_off";
    else if (!found?.available.includes(executor))
      reason = executor === "codex" && found?.codexTooOld ? "outdated" : "not_installed";
    return {
      kind,
      available: !reason,
      ...(reason ? { reason } : {}),
      experimental: kind === "codex",
      models: brainModelOptions(kind),
      defaultModel: defaultBrainModel(kind),
    };
  };
  return [
    { kind: "model", available: true, experimental: false, models: [], defaultModel: null },
    computer("claude_code", "claude"),
    computer("codex", "codex"),
  ];
}

/** "Usar um computador": the agent's machine as the brain section shows it. */
export interface BrainComputer {
  machineId: string;
  name: string;
  online: boolean;
}

/** A computer the caller may give the agent, with what it offers (the page moves the agent to one that has a brain). */
export interface BrainMachineOptions extends BrainComputer {
  options: BrainOption[];
}

export interface AgentBrainView {
  agentId: string;
  brain: BrainKind;
  /** As stored (null = the brain's default). */
  model: string | null;
  /** What it runs with (`model ?? defaultModel`), null for the model brain. */
  effectiveModel: string | null;
  fallback: boolean;
  computer: BrainComputer | null;
  options: BrainOption[];
  /** Every computer the caller may give the agent (admins: all; its owner: the ones they connected), with its options. */
  machines: BrainMachineOptions[];
  /** The caller may change it (an admin or the agent's owner). */
  canEdit: boolean;
  /** The account its computer brain runs with (ADR 0041); null = the computer's own sign-in. */
  account: string | null;
  /** How hard its computer brain thinks; null = the CLI's default. */
  effort: BrainEffort | null;
  /** The accounts on the agent's computer, both kinds ([] without a computer). */
  accounts: MachineAccountView[];
  /** Who connected the agent's computer: only they add accounts or pick one. */
  accountsOwner: { id: string; name: string } | null;
  /** The caller is that person and the computer's runner knows accounts. */
  canManageAccounts: boolean;
  /** The computer's runner knows accounts (protocol 13). */
  accountsSupported: boolean;
}

/** The account part of the brain view. */
interface BrainAccounts {
  accounts: MachineAccountView[];
  accountsOwner: { id: string; name: string } | null;
  canManageAccounts: boolean;
  accountsSupported: boolean;
}

const NO_ACCOUNTS: BrainAccounts = {
  accounts: [],
  accountsOwner: null,
  canManageAccounts: false,
  accountsSupported: false,
};

/** The accounts on the agent's computer, its owner, and whether the caller may manage them. */
async function brainAccounts(
  db: Database,
  userId: string,
  orgId: string,
  machine: Pick<MachineRow, "id" | "protocol" | "pairedByUserId"> | null,
): Promise<BrainAccounts> {
  if (!machine) return NO_ACCOUNTS;
  const supported = machine.protocol >= ACCOUNTS_PROTOCOL;
  const [accounts, owner] = await Promise.all([
    listMachineAccounts({ db }, orgId, machine.id),
    machine.pairedByUserId
      ? db
          .select({ id: schema.users.id, name: schema.users.name })
          .from(schema.users)
          .where(eq(schema.users.id, machine.pairedByUserId))
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
  ]);
  const mine = machine.pairedByUserId === userId;
  return {
    // The emails are the computer owner's: everyone else sees the account names only.
    accounts: mine ? accounts : accounts.map((a) => ({ ...a, email: null })),
    accountsOwner: owner,
    canManageAccounts: supported && mine,
    accountsSupported: supported,
  };
}

interface BrainDeps {
  db: Database;
}

/** Admins (`manage_agents`) and the agent's owner see and change it; anyone else gets a 403. */
async function agentBrainAccess(db: Database, userId: string, orgId: string, agentId: string) {
  const membership = await requirePermission(db, userId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  const admin = can(membership.role, "manage_agents");
  if (!admin && agent.ownerUserId !== userId) {
    throw new ForbiddenError("Only an admin or the agent's owner can see who thinks for it", "agent.not_owner");
  }
  return { agent, admin };
}

/** The computers the caller may give the agent (the same rule as `setAgentComputerTarget`), with their options. */
async function candidateMachines(
  db: Database,
  userId: string,
  orgId: string,
  admin: boolean,
  current: string | null,
): Promise<BrainMachineOptions[]> {
  const rows = await db
    .select()
    .from(schema.machines)
    .where(and(eq(schema.machines.orgId, orgId), isNull(schema.machines.deletedAt)));
  return rows
    .filter((m) => admin || m.pairedByUserId === userId || m.id === current)
    .map((m) => ({ machineId: m.id, name: m.name, online: machineOnline(m), options: brainOptions(m) }));
}

async function agentMachine(db: Database, orgId: string, machineId: string | null) {
  if (!machineId) return null;
  const machine = await getMachine(db, orgId, machineId);
  return machine && !machine.deletedAt ? machine : null;
}

function view(
  agent: {
    id: string;
    brain: string;
    brainModel: string | null;
    brainFallback: boolean;
    brainAccountId: string | null;
    brainEffort: string | null;
  },
  machine: MachineLike | null,
  machines: BrainMachineOptions[],
  accounts: BrainAccounts,
): AgentBrainView {
  const brain = brainOf(agent.brain);
  return {
    agentId: agent.id,
    brain,
    model: brain === "model" ? null : agent.brainModel,
    effectiveModel: brain === "model" ? null : (agent.brainModel ?? defaultBrainModel(brain)),
    fallback: agent.brainFallback,
    computer: machine ? { machineId: machine.id, name: machine.name, online: machineOnline(machine) } : null,
    options: brainOptions(machine),
    machines,
    canEdit: true,
    account: agent.brainAccountId,
    effort: isBrainEffort(agent.brainEffort) ? agent.brainEffort : null,
    ...accounts,
  };
}

/** Postgres `foreign_key_violation`, as the driver raises it or wrapped by Drizzle (`cause`). */
function isForeignKeyViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 3; depth++) {
    if ((e as { code?: unknown }).code === "23503") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** `GET …/agents/{id}/brain`: the choice, the computer and what it can offer. */
export async function getAgentBrain(
  deps: BrainDeps,
  userId: string,
  orgId: string,
  agentId: string,
): Promise<AgentBrainView> {
  const { agent, admin } = await agentBrainAccess(deps.db, userId, orgId, agentId);
  const machineLook = agentMachine(deps.db, orgId, agent.machineId);
  const [machine, machines, accounts] = await Promise.all([
    machineLook,
    candidateMachines(deps.db, userId, orgId, admin, agent.machineId),
    machineLook.then((m) => brainAccounts(deps.db, userId, orgId, m)),
  ]);
  return view(agent, machine, machines, accounts);
}

export interface AgentBrainInput {
  brain?: unknown;
  /** Omitted = keep it (or the default when the brain changes); null = the brain's default. */
  model?: unknown;
  fallback?: unknown;
  /**
   * The person read the warning (the subscription is personal; answering
   * other people with it may go against the provider's terms) and takes the
   * risk. Required when switching to a computer brain; we never block it.
   */
  acceptPlanTerms?: unknown;
  /**
   * The account its computer brain runs with (ADR 0041): an account on the
   * agent's computer of the brain's kind, or null for the computer's own
   * sign-in. Only the person who connected the computer changes it. Omitted =
   * keep it (cleared when the brain kind changes).
   */
  account?: unknown;
  /** `low`…`max`, or null for the CLI's default. Omitted = keep it. */
  effort?: unknown;
}

/** `PUT …/agents/{id}/brain` (an admin or the agent's owner). Audited. */
export async function setAgentBrain(
  deps: BrainDeps,
  userId: string,
  orgId: string,
  agentId: string,
  input: AgentBrainInput,
): Promise<AgentBrainView> {
  const { agent, admin } = await agentBrainAccess(deps.db, userId, orgId, agentId);
  const from = brainOf(agent.brain);
  if (input.brain !== undefined && !isBrainKind(input.brain)) {
    throw new ValidationError("Choose model, claude_code or codex", "brain.invalid");
  }
  if (input.fallback !== undefined && typeof input.fallback !== "boolean") {
    throw new ValidationError("fallback is on or off", "brain.invalid");
  }
  const brain = (input.brain as BrainKind | undefined) ?? from;
  const changed = brain !== from;
  const [machine, machines] = await Promise.all([
    agentMachine(deps.db, orgId, agent.machineId),
    candidateMachines(deps.db, userId, orgId, admin, agent.machineId),
  ]);
  if (changed && isComputerBrain(brain)) {
    if (input.acceptPlanTerms !== true) {
      throw new ValidationError(
        "Using a personal subscription for the agent needs your confirmation",
        "brain.terms_required",
        { brain },
      );
    }
    const option = brainOptions(machine).find((o) => o.kind === brain);
    if (!option?.available) {
      throw new ConflictError(
        machine
          ? `${brain === "codex" ? "Codex" : "Claude Code"} isn't available on ${machine.name}`
          : "The agent needs a connected computer first",
        machine ? "brain.unavailable" : "brain.no_computer",
        { brain, reason: option?.reason ?? "no_computer", computer: machine?.name ?? null },
      );
    }
  }
  const model =
    brain === "model"
      ? input.model === undefined || input.model === null || input.model === ""
        ? null
        : normalizeBrainModel(brain, input.model)
      : input.model !== undefined
        ? normalizeBrainModel(brain, input.model)
        : changed
          ? null
          : agent.brainModel;
  const fallback = (input.fallback as boolean | undefined) ?? agent.brainFallback;
  if (input.effort !== undefined && input.effort !== null && !isBrainEffort(input.effort)) {
    throw new ValidationError("Choose low, medium, high, xhigh or max", "brain.invalid_effort");
  }
  const effort = input.effort === undefined ? agent.brainEffort : (input.effort as BrainEffort | null);
  const account = await nextBrainAccount(deps.db, userId, orgId, agent, brain, changed, machine, input.account);
  const accounts = await brainAccounts(deps.db, userId, orgId, machine);
  if (
    !changed &&
    model === agent.brainModel &&
    fallback === agent.brainFallback &&
    account === agent.brainAccountId &&
    effort === agent.brainEffort
  ) {
    return view(agent, machine, machines, accounts);
  }
  const [row] = await deps.db
    .update(schema.agents)
    .set({
      brain,
      brainModel: model,
      brainFallback: fallback,
      brainAccountId: account,
      brainEffort: effort,
      updatedAt: new Date(),
    })
    .where(and(eq(schema.agents.id, agentId), eq(schema.agents.orgId, orgId)))
    .returning()
    .catch((error: unknown) => {
      // The account was removed meanwhile (the computer, its owner): the same answer as a stale choice.
      if (account && isForeignKeyViolation(error)) {
        throw new ValidationError("That account is no longer on this computer", "account.invalid");
      }
      throw error;
    });
  caches.agents.delete(`${orgId}:${agentId}`);
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "agent.brain",
    target: { type: "agent", id: agentId },
    details: {
      from: {
        brain: from,
        model: agent.brainModel,
        fallback: agent.brainFallback,
        account: agent.brainAccountId,
        effort: agent.brainEffort,
      },
      to: { brain, model, fallback, account, effort },
      ...(changed && isComputerBrain(brain) ? { acceptedPlanTerms: true } : {}),
    },
  });
  const next = row ?? {
    ...agent,
    brain,
    brainModel: model,
    brainFallback: fallback,
    brainAccountId: account,
    brainEffort: effort,
  };
  // The account's `usedBy` changed with it.
  const fresh = account !== agent.brainAccountId ? await brainAccounts(deps.db, userId, orgId, machine) : accounts;
  return view(next, machine, machines, fresh);
}

/**
 * The account the agent will run with (ADR 0041 §4): kept when nothing asks
 * otherwise, cleared when the brain kind changes; picking or clearing one is
 * for the person who connected the computer only, and the account must be on
 * the agent's computer and of the brain's kind.
 */
async function nextBrainAccount(
  db: Database,
  userId: string,
  orgId: string,
  agent: { brainAccountId: string | null },
  brain: BrainKind,
  changed: boolean,
  machine: MachineRow | null,
  input: unknown,
): Promise<string | null> {
  const kept = changed ? null : agent.brainAccountId;
  if (input === undefined) return kept;
  if (input !== null && typeof input !== "string") {
    throw new ValidationError("Choose an account on the agent's computer", "account.invalid");
  }
  const wanted = input || null;
  if (wanted === kept) return kept;
  if (!machine || machine.pairedByUserId !== userId) {
    throw new ForbiddenError(
      "Only the person who connected the agent's computer can choose its account",
      "account.not_owner",
    );
  }
  if (wanted === null) return null;
  const row = isComputerBrain(brain) ? await getMachineAccount(db, orgId, machine.id, wanted) : null;
  if (!row || row.kind !== brain) {
    throw new ValidationError("Choose an account of this brain on the agent's computer", "account.invalid", {
      brain,
    });
  }
  return row.id;
}

// ── Missions ────────────────────────────────────────────────────────────────

/** The brain a mission's executor means (`claude` → Claude Code, `codex` → Codex, `agent` → the model). */
export const executorBrain = (executor: string): BrainKind =>
  executor === "codex" ? "codex" : executor === "agent" ? "model" : "claude_code";

export interface MissionBrainView {
  missionId: string;
  /** The override as stored (null = from the executor). */
  brain: BrainKind | null;
  model: string | null;
  effectiveBrain: BrainKind;
  /** What it runs with: the override, the agent's model for that brain, or the brain's default. */
  effectiveModel: string | null;
  options: BrainOption[];
  /** Before Start, the owner or someone who decides. */
  canSetBrain: boolean;
  /** Any time while it is open, the owner or someone who decides. */
  canSetModel: boolean;
}

async function missionBrainView(
  deps: Pick<MissionDeps, "db">,
  mission: MissionRow,
  role: string,
): Promise<MissionBrainView> {
  const [machine, agent] = await Promise.all([
    agentMachine(deps.db, mission.orgId, mission.machineId),
    getAgent(deps.db, mission.orgId, mission.agentId),
  ]);
  const effectiveBrain = isBrainKind(mission.brain) ? mission.brain : executorBrain(mission.executor);
  const agentModel = agent && brainOf(agent.brain) === effectiveBrain ? agent.brainModel : null;
  const actor = role === "owner" || role === "decide";
  const open = OPEN_MISSION_STATUSES.includes(mission.status);
  return {
    missionId: mission.id,
    brain: isBrainKind(mission.brain) ? mission.brain : null,
    model: mission.brainModel,
    effectiveBrain,
    effectiveModel:
      effectiveBrain === "model" ? null : (mission.brainModel ?? agentModel ?? defaultBrainModel(effectiveBrain)),
    options: brainOptions(machine),
    canSetBrain: actor && mission.status === "proposed",
    canSetModel: actor && open,
  };
}

/** `GET …/missions/{id}/brain`, for whoever reads the mission's conversation. */
export async function getMissionBrain(deps: MissionDeps, userId: string, orgId: string, missionId: string) {
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  return missionBrainView(deps, mission, role);
}

/**
 * `PUT …/missions/{id}/brain` (the owner or someone who decides): the brain
 * only before Start; its model any time while the mission is open (the next
 * session or task picks it up). Audited.
 */
export async function setMissionBrain(
  deps: MissionDeps,
  userId: string,
  orgId: string,
  missionId: string,
  input: { brain?: unknown; model?: unknown },
): Promise<MissionBrainView> {
  const { mission, role } = await requireMission(deps, userId, orgId, missionId);
  requireAct(role, "change who does the work");
  requireOpen(mission);
  if (input.brain !== undefined && input.brain !== null && !isBrainKind(input.brain)) {
    throw new ValidationError("Choose model, claude_code or codex", "brain.invalid");
  }
  const brain = input.brain === undefined ? mission.brain : (input.brain as BrainKind | null);
  const brainChanged = (brain ?? null) !== (mission.brain ?? null);
  if (brainChanged && mission.status !== "proposed") {
    throw new ConflictError("Who does the work is chosen before Start", "mission.wrong_status", {
      status: mission.status,
    });
  }
  const effective = isBrainKind(brain) ? brain : executorBrain(mission.executor);
  if (brainChanged && isComputerBrain(effective)) {
    const machine = await agentMachine(deps.db, orgId, mission.machineId);
    const option = brainOptions(machine).find((o) => o.kind === effective);
    if (!option?.available) {
      throw new ConflictError(
        `${effective === "codex" ? "Codex" : "Claude Code"} isn't available on the mission's computer`,
        machine ? "brain.unavailable" : "brain.no_computer",
        { brain: effective, reason: option?.reason ?? "no_computer", computer: machine?.name ?? null },
      );
    }
  }
  const model =
    input.model !== undefined
      ? effective === "model" && (input.model === null || input.model === "")
        ? null
        : normalizeBrainModel(effective, input.model)
      : brainChanged
        ? null
        : mission.brainModel;
  if (!brainChanged && model === mission.brainModel) return missionBrainView(deps, mission, role);
  const row = await deps.db.transaction(async (tx) => {
    const [next] = await tx
      .update(schema.missions)
      .set({ brain: brain ?? null, brainModel: model, updatedAt: new Date() })
      .where(sql`${schema.missions.id} = ${mission.id}::uuid`)
      .returning();
    const details = {
      from: { brain: mission.brain, model: mission.brainModel },
      to: { brain: brain ?? null, model },
    };
    await recordMissionEvent(tx, mission, "brain_changed", { by: userId, ...details });
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "mission.brain_changed",
      target: { type: "mission", id: mission.id },
      details,
    });
    return next;
  });
  const current = row ?? { ...mission, brain: brain ?? null, brainModel: model };
  await publishMissionEvent(deps, current, "settings", { brain: brain ?? null, brainModel: model });
  return missionBrainView(deps, current, role);
}

/**
 * What thinks for an agent, for wherever the agent is shown (DM header,
 * profile, cards): the brain, its model's label ("Sonnet"; null for the
 * model brain, which shows the agent's model) and the computer's name, only
 * for those who may see it (admins and the agent's owner, like Quem pensa).
 */
export interface AgentBrainSummary {
  kind: BrainKind;
  model: string | null;
  computer?: string;
}

/** The label of a computer brain's model ("opus" → "Opus"; a typed Codex model as is). */
export function brainModelLabel(kind: BrainKind, model: string | null | undefined): string | null {
  if (kind === "model") return null;
  const value = model ?? defaultBrainModel(kind);
  if (!value) return null;
  return brainModelOptions(kind).find((o) => o.value === value)?.label ?? value;
}

/** Each agent's brain summary for this viewer (one query for the computers' names). */
export async function agentBrainSummaries(
  db: Database,
  viewerId: string,
  orgId: string,
  agents: readonly {
    id: string;
    brain: string;
    brainModel: string | null;
    machineId: string | null;
    ownerUserId: string | null;
  }[],
): Promise<Map<string, AgentBrainSummary>> {
  const out = new Map<string, AgentBrainSummary>();
  const computerIds = [
    ...new Set(agents.filter((a) => brainOf(a.brain) !== "model" && a.machineId).map((a) => a.machineId as string)),
  ];
  const [membership, machines] = await Promise.all([
    computerIds.length ? getMembership(db, viewerId, orgId) : Promise.resolve(null),
    computerIds.length
      ? db
          .select({ id: schema.machines.id, name: schema.machines.name, deletedAt: schema.machines.deletedAt })
          .from(schema.machines)
          .where(and(eq(schema.machines.orgId, orgId), inArray(schema.machines.id, computerIds)))
      : Promise.resolve([]),
  ]);
  const names = new Map(machines.filter((m) => !m.deletedAt).map((m) => [m.id, m.name]));
  const manages = membership !== null && can(membership.role, "manage_agents");
  for (const a of agents) {
    const kind = brainOf(a.brain);
    const computer = a.machineId && (manages || a.ownerUserId === viewerId) ? names.get(a.machineId) : undefined;
    out.set(a.id, {
      kind,
      model: brainModelLabel(kind, a.brainModel),
      ...(kind !== "model" && computer ? { computer } : {}),
    });
  }
  return out;
}
