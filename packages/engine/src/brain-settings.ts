import {
  ACCOUNTS_PROTOCOL,
  type AccountKind,
  BRAIN_PROTOCOL,
  type BrainEffort,
  CURSOR_PROTOCOL,
  GROK_PROTOCOL,
  isBrainEffort,
  OPENCODE_PROTOCOL,
  type OwnPlanUsage,
  PLAN_KEYS_PROTOCOL,
  type PlanUsage,
} from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNull, ne, schema, sql } from "@agenteschat/db";
import {
  AUTO_MODEL,
  type ContextLimit,
  catalogModelOf,
  contextWindowOf,
  isAutoModel,
  isContextLimit,
  MODEL_CATALOG,
} from "@agenteschat/providers";
import {
  claudeCodeModel,
  GROK_BUILD_MODELS,
  isPlanModelId,
  OPENCODE_FREE_MODELS,
  planModel,
  planOf,
} from "@agenteschat/providers/plans";
import { type Agent, getAgent, rememberAgentSetup, setupOfAgent } from "./agents";
import {
  type AgentAudience,
  answersOthers,
  audienceChanged,
  audienceOf,
  dropMailIfWidened,
  OWNER_ONLY,
  planOpened,
} from "./audience";
import { recordAudit } from "./audit";
import { BRAIN_NAMES, type BrainKind, isComputerBrain } from "./brains/types";
import { caches } from "./cache";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import {
  defaultAccountLabel,
  forgetAgents,
  getListedAccount,
  listMachineAccounts,
  type MachineAccountView,
  mayAddAccounts,
  releaseAgents,
  sharesSignIns,
} from "./machine-accounts";
import { getMachine, type MachineRow, machineOnline } from "./machines";
import {
  agentMissionApproval,
  type CommandApproval,
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
import { isRightHand } from "./right-hand";
import { closedRefusal } from "./standing";
import { wakeAgentUsageWaits } from "./usage-pause";

/*
 * "Quem pensa" (ADR 0032 §5): the brain an agent thinks with, its model and
 * the fallback to the API, stored on the agent (`agents.brain*`), and a
 * mission's override (`missions.brain*`). This module stores and validates
 * the choice and says what the agent's computer can offer; the engine
 * resolves it per run (`brainFor`).
 */

export const BRAIN_KINDS: readonly BrainKind[] = ["model", "claude_code", "codex", "cursor", "opencode", "grok"];
export const isBrainKind = (v: unknown): v is BrainKind =>
  typeof v === "string" && (BRAIN_KINDS as readonly string[]).includes(v);
/** An effort as stored: a level, or `auto` (the judge picks it per run). */
export type BrainEffortSetting = BrainEffort | typeof AUTO_MODEL;
export const isBrainEffortSetting = (v: unknown): v is BrainEffortSetting =>
  isBrainEffort(v) || isAutoModel(v as string);

/** A stored value read back (anything unknown is the model brain). */
export const brainOf = (v: unknown): BrainKind => (isBrainKind(v) ? v : "model");

export interface BrainModelOption {
  /** What is stored and passed to the CLI (`--model opus`, `-m gpt-…`). */
  value: string;
  label: string;
  /** The model id behind an alias (Claude Code's `opus` → `claude-opus-5-5`). */
  modelId?: string;
  recommended?: boolean;
  /** Its context window in tokens: which context limits are worth offering with it. */
  contextWindow?: number;
  /**
   * Cursor (ADR 0114): its CLI said the person's plan includes it. Other models Cursor bills at API prices; absent
   * when the CLI didn't say.
   */
  inPlan?: boolean;
  /** OpenCode (ADR 0132): a model of OpenCode's free tier (no key, no cost). */
  free?: boolean;
}

/**
 * OpenCode's models: what its CLI listed on the agent's computer (`opencode models`, `provider/model`), else OpenCode's
 * free tier; the free ones first, but a free variant (`opencode/glm-5.3-flash-free`) right after its paid model when
 * that is listed too, as OpenCode's console shows them. With none chosen its CLI's own default runs. Any other
 * `provider/model` is accepted as typed (a key's paid models, which the computer's own CLI may not list).
 */
export const opencodeModels = (listed: readonly { id: string; label?: string; free?: boolean }[] = []) => {
  const all = listed.length ? listed : OPENCODE_FREE_MODELS.map((m) => ({ ...m, free: true }));
  const variantOf = (m: { id: string }) => all.find((f) => f.free && f.id === `${m.id}-free`);
  const paired = new Set(all.map(variantOf));
  return all
    .filter((m) => !paired.has(m))
    .sort((a, b) => Number(b.free === true) - Number(a.free === true))
    .flatMap((m) => [m, variantOf(m)].filter((x) => x !== undefined))
    .map(
      (m): BrainModelOption => ({
        value: m.id,
        label: m.label || m.id.replace(/^opencode\//, ""),
        ...(m.free ? { free: true } : {}),
      }),
    );
};

/**
 * Cursor's models: what its CLI listed on the agent's computer (`agent models`), the plan's own first (its CLI's
 * default runs when none is chosen). Any other name is accepted as typed.
 */
export const cursorModels = (listed: readonly { id: string; label?: string; inPlan?: boolean }[] = []) =>
  [...listed]
    .sort((a, b) => Number(b.inPlan === true) - Number(a.inPlan === true))
    .map(
      (m): BrainModelOption => ({
        value: m.id,
        label: m.label || m.id,
        ...(catalogModelOf(m.id) ? { modelId: m.id } : {}),
        ...(m.inPlan ? { inPlan: true } : {}),
      }),
    );

/** Grok Build's models (ADR 0142): what its CLI listed on the agent's computer (`grok models`), else `GROK_BUILD_MODELS`. */
export const grokModels = (listed: readonly { id: string; label?: string }[] = []): BrainModelOption[] =>
  (listed.length ? listed : GROK_BUILD_MODELS).map((m) => ({
    value: m.id,
    label: m.label || m.id,
    ...(catalogModelOf(m.id) ? { modelId: m.id } : {}),
  }));

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

/**
 * The model choices of a brain (none for the model brain: it uses the agent's model). A coding plan's are in its
 * catalog (`@agenteschat/providers/plans`), which the apps read.
 */
export function brainModelOptions(
  kind: BrainKind,
  machine?: { executors?: schema.MachineExecutors | null } | null,
): BrainModelOption[] {
  return modelChoices(kind, machine).map((o) =>
    o.modelId ? { ...o, contextWindow: contextWindowOf(catalogModelOf(o.modelId) ?? o.modelId) } : o,
  );
}

function modelChoices(kind: BrainKind, machine?: { executors?: schema.MachineExecutors | null } | null) {
  if (kind === "claude_code") return [...CLAUDE_CODE_MODELS];
  if (kind === "codex") return codexModels();
  if (kind === "cursor") return cursorModels(machine?.executors?.cursor?.models);
  if (kind === "opencode") return opencodeModels(machine?.executors?.opencode?.models);
  if (kind === "grok") return grokModels(machine?.executors?.grok?.models);
  return [];
}

/** What a computer brain runs with when nobody chose a model (Cursor, OpenCode, Grok: its CLI's own default, null). */
export function defaultBrainModel(kind: BrainKind): string | null {
  if (kind === "model" || kind === "cursor" || kind === "opencode" || kind === "grok") return null;
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
 * takes its aliases, a full Claude id or a coding plan's model; Codex any
 * model name (a new one may come out before our catalog knows it); the model
 * brain none.
 */
export function normalizeBrainModel(kind: BrainKind, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new ValidationError("The model is a name", "brain.invalid_model");
  const v = value.trim();
  if (kind === "model") {
    throw new ValidationError("The API brain uses the agent's model", "brain.invalid_model");
  }
  // "Automático": each run picks the tier (`auto-model.ts`).
  if (v.toLowerCase() === AUTO_MODEL) return AUTO_MODEL;
  if (kind === "claude_code") {
    const alias = CLAUDE_CODE_MODELS.find((o) => o.value === v.toLowerCase() || o.modelId === v);
    if (alias) return alias.value;
    if (/^claude-[a-z0-9.-]{1,60}$/.test(v) || isPlanModelId(v)) return v;
    throw new ValidationError("Choose Opus, Sonnet, Haiku or one of the plan's models", "brain.invalid_model", {
      brain: kind,
    });
  }
  if (!FREE_MODEL.test(v)) throw new ValidationError("That isn't a model name", "brain.invalid_model", { brain: kind });
  // OpenCode runs `--model provider/model` (its runner refuses anything else).
  if (kind === "opencode" && !/^[\w.-]{1,40}\/[\w.:-]{1,79}$/.test(v)) {
    throw new ValidationError("OpenCode's models are provider/model, like opencode/big-pickle", "brain.invalid_model", {
      brain: kind,
    });
  }
  return v;
}

/** Why a computer brain can't be chosen right now. */
export type BrainUnavailable = "no_computer" | "exec_off" | "runner_old" | "tool_off" | "not_installed" | "outdated";

export interface BrainOption {
  kind: BrainKind;
  available: boolean;
  reason?: BrainUnavailable;
  models: BrainModelOption[];
  defaultModel: string | null;
}

type MachineLike = Parameters<typeof machineExecutors>[0] & {
  id: string;
  name: string;
  /** Protocol 10: what the machine allows (the app's Ferramentas); absent on older runners. */
  access?: {
    tools?: { claude?: boolean; codex?: boolean; cursor?: boolean; opencode?: boolean; grok?: boolean };
  } | null;
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
      models: brainModelOptions(kind),
      defaultModel: defaultBrainModel(kind),
    };
  };
  return [
    { kind: "model", available: true, models: [], defaultModel: null },
    computer("claude_code", "claude"),
    computer("codex", "codex"),
    cliOption(machine, "cursor"),
    cliOption(machine, "opencode"),
    cliOption(machine, "grok"),
  ];
}

/**
 * Cursor (ADR 0114, runner protocol 36) or OpenCode (ADR 0132, protocol 39): the runner's protocol, its switch (or
 * Codex's on a runner before it) and its CLI found there.
 */
function cliOption(machine: MachineLike | null, kind: "cursor" | "opencode" | "grok"): BrainOption {
  const tools = machine?.access?.tools;
  let reason: BrainUnavailable | undefined;
  if (!machine) reason = "no_computer";
  else if (!machine.execAllowed) reason = "exec_off";
  else if (machine.protocol < { cursor: CURSOR_PROTOCOL, opencode: OPENCODE_PROTOCOL, grok: GROK_PROTOCOL }[kind])
    reason = "runner_old";
  else if (tools && (tools[kind] ?? tools.codex) === false) reason = "tool_off";
  else if (!machine.executors?.[kind]) reason = "not_installed";
  return {
    kind,
    available: !reason,
    ...(reason ? { reason } : {}),
    models: brainModelOptions(kind, machine),
    defaultModel: null,
  };
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
  /** Long work may go on into the plan's paid extra usage where the provider reports it on (ADR 0118). */
  extraUsage: boolean;
  computer: BrainComputer | null;
  options: BrainOption[];
  /** Every computer the caller may give the agent (admins: all; its owner: the ones they connected), with its options. */
  machines: BrainMachineOptions[];
  /** The caller may change it (an admin or the agent's owner). */
  canEdit: boolean;
  /** The account its computer brain runs with (ADR 0041); null = the computer's own sign-in. */
  account: string | null;
  /** How hard its computer brain thinks; `auto` = picked per run; null = the CLI's default. */
  effort: BrainEffortSetting | null;
  /** The most context it reads, in tokens (`CONTEXT_LIMITS`, any brain); null = its model's window. */
  contextTokens: ContextLimit | null;
  /**
   * The agent's owner's accounts on its computer, both kinds ([] without a computer), and the one it thinks
   * with; emails only of the caller's own. A plan thinks only for its owner's agents (ADR 0059 §3).
   */
  accounts: MachineAccountView[];
  /** The caller may add an account there for this agent: its owner, on a computer where they add accounts. */
  canManageAccounts: boolean;
  /** The computer's runner knows accounts (protocol 13). */
  accountsSupported: boolean;
  /** Nobody but its owner talks to it ("Atende outras pessoas" off, ADR 0059 §5). */
  onlyOwner: boolean;
  /**
   * The caller owns the agent, so its plans are the caller's own: they sign one in for it. Admins choose among its
   * owner's accounts and whom it answers too.
   */
  canUsePlans: boolean;
  /** The computer's own sign-in can think for it: the person who connected the computer owns the agent. */
  ownSignIn: boolean;
  /** The computer's own sign-ins' plan usage, by brain (protocol 19; empty: not known). */
  ownUsage: OwnPlanUsage;
  /** Its Autonomia (the autonomy its missions start with): "Usar em outros agentes" takes it along (ADR 0094). */
  autonomy: CommandApproval;
}

/** The account part of the brain view. */
interface BrainAccounts {
  accounts: MachineAccountView[];
  canManageAccounts: boolean;
  accountsSupported: boolean;
}

const NO_ACCOUNTS: BrainAccounts = { accounts: [], canManageAccounts: false, accountsSupported: false };

/** The agent's owner's accounts on its computer (and the one it uses), and whether the caller adds one there for it. */
async function brainAccounts(
  db: Database,
  userId: string,
  orgId: string,
  agent: Pick<Agent, "ownerUserId" | "brainAccountId" | "builtin">,
  machine: Pick<MachineRow, "id" | "protocol" | "pairedByUserId"> | null,
): Promise<BrainAccounts> {
  if (!machine) return NO_ACCOUNTS;
  const supported = machine.protocol >= ACCOUNTS_PROTOCOL;
  const accounts = await listMachineAccounts({ db }, orgId, machine.id, userId);
  return {
    accounts: accounts.filter(
      (a) => (agent.ownerUserId !== null && a.ownerId === agent.ownerUserId) || a.id === agent.brainAccountId,
    ),
    canManageAccounts: supported && agent.ownerUserId === userId && mayAddAccounts(machine, userId),
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
  const admin = can(membership, "manage_agents");
  if (!admin && agent.ownerUserId !== userId) {
    throw new ForbiddenError("Only an admin or the agent's owner can see who thinks for it", "agent.not_owner");
  }
  return { agent, admin, membership };
}

/**
 * The team's right hand as its AI settings see it (ADR 0137 §1, amended 2026-11-04): it is on no computer and its owner
 * is the workspace's, so on a plan (`account`, the one asked for else its own) the computer is that account's and the
 * plan is its owner's. With none yet, the computer a plan would sign in on for the caller: the workspace's own, else
 * the first one the caller connected, and the plan would be the caller's. Every other agent is itself.
 */
async function settingsAgent(db: Database, agent: Agent, userId: string, account?: unknown): Promise<Agent> {
  if (!isRightHand(agent)) return agent;
  const id = typeof account === "string" && account ? account : account === undefined ? agent.brainAccountId : null;
  if (id) {
    const [row] = await db
      .select({ machineId: schema.machineAccounts.machineId, ownerId: schema.machineAccounts.createdBy })
      .from(schema.machineAccounts)
      .where(and(eq(schema.machineAccounts.orgId, agent.orgId), eq(schema.machineAccounts.id, id)));
    return { ...agent, machineId: row?.machineId ?? null, ownerUserId: row?.ownerId ?? null };
  }
  const [machine] = await db
    .select({ id: schema.machines.id })
    .from(schema.machines)
    .where(
      and(
        eq(schema.machines.orgId, agent.orgId),
        isNull(schema.machines.deletedAt),
        sql`(${schema.machines.kind} = 'managed' or ${schema.machines.pairedByUserId} = ${userId})`,
      ),
    )
    .orderBy(sql`${schema.machines.kind} = 'managed' desc`, schema.machines.createdAt)
    .limit(1);
  return { ...agent, machineId: machine?.id ?? null, ownerUserId: userId };
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
  agent: Agent,
  machine: MachineRow | null,
  machines: BrainMachineOptions[],
  accounts: BrainAccounts,
  userId: string,
): AgentBrainView {
  const brain = brainOf(agent.brain);
  return {
    agentId: agent.id,
    brain,
    model: brain === "model" ? null : agent.brainModel,
    effectiveModel: brain === "model" ? null : (agent.brainModel ?? defaultBrainModel(brain)),
    fallback: agent.brainFallback,
    extraUsage: agent.brainExtraUsage,
    computer: machine ? { machineId: machine.id, name: machine.name, online: machineOnline(machine) } : null,
    options: brainOptions(machine),
    machines,
    canEdit: true,
    account: agent.brainAccountId,
    effort: isBrainEffortSetting(agent.brainEffort) ? agent.brainEffort : null,
    contextTokens: isContextLimit(agent.contextTokens) ? agent.contextTokens : null,
    ...accounts,
    // The right hand keeps its audience: the switch says whether other people's DMs think with the plan.
    onlyOwner: isRightHand(agent) ? !agent.planForOthers : !answersOthers(audienceOf(agent), agent.ownerUserId),
    canUsePlans: agent.ownerUserId === userId,
    ownSignIn: Boolean(machine?.pairedByUserId) && machine?.pairedByUserId === agent.ownerUserId,
    ownUsage: machine?.executors?.ownUsage ?? {},
    autonomy: agentMissionApproval(agent),
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
  const access = await agentBrainAccess(deps.db, userId, orgId, agentId);
  const { admin } = access;
  const agent = await settingsAgent(deps.db, access.agent, userId);
  const machineLook = agentMachine(deps.db, orgId, agent.machineId);
  const [machine, machines, accounts] = await Promise.all([
    machineLook,
    candidateMachines(deps.db, userId, orgId, admin, agent.machineId),
    machineLook.then((m) => brainAccounts(deps.db, userId, orgId, agent, m)),
  ]);
  return view(agent, machine, machines, accounts, userId);
}

/**
 * `GET …/brain-machines`: what a new agent could think with ("Criar agente"), before it exists: every computer of
 * the workspace (only admins create agents) with what each offers. The choice is saved on the agent once created.
 */
export async function newAgentBrainMachines(
  deps: BrainDeps,
  userId: string,
  orgId: string,
): Promise<BrainMachineOptions[]> {
  await requirePermission(deps.db, userId, orgId, "create_agents");
  return candidateMachines(deps.db, userId, orgId, true, null);
}

export interface AgentBrainInput {
  brain?: unknown;
  /** Omitted = keep it (or the default when the brain changes); null = the brain's default. */
  model?: unknown;
  fallback?: unknown;
  extraUsage?: unknown;
  /**
   * "Atende outras pessoas" turned off (ADR 0059 §5): true, only its owner talks
   * to it; false, whoever its "who can talk" list lets in (everyone with no
   * list). Omitted = keep it; a switch onto a plan makes it its owner's only,
   * until its owner or an admin lets more people in.
   */
  onlyOwner?: unknown;
  /**
   * The account its computer brain runs with (ADR 0041): an account on the
   * agent's computer of the brain's kind, or null for the computer's own
   * sign-in. One of the agent's owner's accounts, chosen by its owner or an admin.
   * Omitted = keep it (cleared when the brain kind changes).
   */
  account?: unknown;
  /** The account thinks for another agent: take it from that one, which loses it (`releaseAgents`). */
  moveAccount?: unknown;
  /** `low`…`max`, `auto` (picked per run), or null for the CLI's default. Omitted = keep it. */
  effort?: unknown;
  /** One of `CONTEXT_LIMITS`, or null for the model's window; kept through brain switches. Omitted = keep it. */
  contextTokens?: unknown;
}

const EVERYONE: AgentAudience = { mode: "everyone", userIds: [], roleIds: [] };

/** Who it answers after this change: a switch onto a plan makes it its owner's only (ADR 0059 §5). */
function nextAudience(agent: Agent, brain: BrainKind, changed: boolean, onlyOwner: boolean | undefined): AgentAudience {
  const current = audienceOf(agent);
  // One that already answers its owner alone keeps its mode: "Só algumas pessoas" with nobody picked stays that.
  const narrow = (a: AgentAudience) => (answersOthers(a, agent.ownerUserId) ? OWNER_ONLY : a);
  const base = changed && isComputerBrain(brain) ? narrow(current) : current;
  if (onlyOwner === undefined) return base;
  if (onlyOwner) return narrow(base);
  if (answersOthers(base, agent.ownerUserId)) return base;
  // Its "who can talk" list decides who comes back: it stays while the agent is its owner's only. One a person
  // restricted ("Só algumas pessoas ou papéis", even with nobody picked yet) stays restricted: never everyone.
  const kept = agent.audienceUserIds.length > 0 || agent.audienceRoleIds.length > 0 || agent.audienceMode === "people";
  return kept ? { mode: "people", userIds: agent.audienceUserIds, roleIds: agent.audienceRoleIds } : EVERYONE;
}

/**
 * `PUT …/agents/{id}/brain` (an admin or the agent's owner). Audited, with `options.audit` added to the entry. What it
 * thinks with becomes what new agents start with, unless `options.remember` is false.
 */
export async function setAgentBrain(
  deps: BrainDeps,
  userId: string,
  orgId: string,
  agentId: string,
  input: AgentBrainInput,
  options: {
    remember?: boolean;
    audit?: Record<string, unknown>;
    /** Called in its transaction when the save lets more people talk to it on its owner's plan (`planOpened`). */
    onPlanOpened?: () => void;
  } = {},
): Promise<AgentBrainView> {
  const access = await agentBrainAccess(deps.db, userId, orgId, agentId);
  const { admin, membership } = access;
  const rightHand = isRightHand(access.agent);
  const agent = await settingsAgent(deps.db, access.agent, userId, input.account);
  const from = brainOf(agent.brain);
  if (input.brain !== undefined && !isBrainKind(input.brain)) {
    throw new ValidationError("Choose model, claude_code, codex or cursor", "brain.invalid");
  }
  if (input.fallback !== undefined && typeof input.fallback !== "boolean") {
    throw new ValidationError("fallback is on or off", "brain.invalid");
  }
  if (input.extraUsage !== undefined && typeof input.extraUsage !== "boolean") {
    throw new ValidationError("extraUsage is on or off", "brain.invalid");
  }
  if (input.onlyOwner !== undefined && typeof input.onlyOwner !== "boolean") {
    throw new ValidationError("onlyOwner is on or off", "brain.invalid");
  }
  const brain = (input.brain as BrainKind | undefined) ?? from;
  const changed = brain !== from;
  const [machine, machines] = await Promise.all([
    agentMachine(deps.db, orgId, agent.machineId),
    candidateMachines(deps.db, userId, orgId, admin, agent.machineId),
  ]);
  if (changed && isComputerBrain(brain)) {
    const option = brainOptions(machine).find((o) => o.kind === brain);
    if (!option?.available) {
      throw new ConflictError(
        machine
          ? `${BRAIN_NAMES[brain]} isn't available on ${machine.name}`
          : "The agent needs a connected computer first",
        machine ? "brain.unavailable" : "brain.no_computer",
        { brain, reason: option?.reason ?? "no_computer", computer: machine?.name ?? null },
      );
    }
  }
  // "Automático" is one choice for every brain: it stays through a switch (and while on the API brain, for
  // the next one), so an agent born automatic is automatic on Claude Code or Codex too. A fixed model belongs to
  // its brain: another brain starts on its default.
  const carried = isAutoModel(agent.brainModel) ? AUTO_MODEL : null;
  const model =
    input.model !== undefined
      ? normalizeBrainModel(brain, input.model)
      : brain === "model" || changed
        ? carried
        : agent.brainModel;
  const fallback = (input.fallback as boolean | undefined) ?? agent.brainFallback;
  // The right hand put on a plan starts with that plan's switches off: neither paid extra usage nor "Atende outras
  // pessoas" is carried over from whoever set them before (an admin while it was on a key, or another plan's owner).
  const newPlan = rightHand && typeof input.account === "string" && input.account !== access.agent.brainAccountId;
  const extraUsage = (input.extraUsage as boolean | undefined) ?? (newPlan ? false : agent.brainExtraUsage);
  // Paid extra usage bills the plan's owner, who is the agent's owner: an admin picks the account, not this.
  if (extraUsage !== agent.brainExtraUsage && agent.ownerUserId !== userId) {
    throw new ForbiddenError(
      "Only the agent's owner turns its plan's paid extra usage on or off",
      "brain.extra_owner_only",
    );
  }
  if (input.effort !== undefined && input.effort !== null && !isBrainEffortSetting(input.effort)) {
    throw new ValidationError("Choose auto, low, medium, high, xhigh or max", "brain.invalid_effort");
  }
  const effort = input.effort === undefined ? agent.brainEffort : (input.effort as BrainEffortSetting | null);
  if (input.contextTokens !== undefined && input.contextTokens !== null && !isContextLimit(input.contextTokens)) {
    throw new ValidationError("Choose 200000, 400000 or 1000000 tokens", "brain.invalid_context");
  }
  const contextTokens =
    input.contextTokens === undefined ? agent.contextTokens : (input.contextTokens as number | null);
  // The right hand keeps its audience: "Atende outras pessoas" is its own switch, off when it moves onto a plan.
  const to = rightHand
    ? audienceOf(agent)
    : nextAudience(agent, brain, changed, input.onlyOwner as boolean | undefined);
  const audience = to.mode === agent.audienceMode ? null : to;
  const planForOthers = !rightHand
    ? agent.planForOthers
    : input.onlyOwner !== undefined
      ? !input.onlyOwner
      : (changed && isComputerBrain(brain)) || newPlan
        ? false
        : agent.planForOthers;
  const next = await nextBrainAccount(deps.db, userId, orgId, agent, brain, changed, machine, input.account, {
    move: input.moveAccount === true,
    admin,
  });
  const account = next.id;
  // On a plan the right hand thinks with an account, never a computer's own sign-in: that names its computer.
  if (rightHand && brain !== "model" && !account) {
    throw new ValidationError(
      "The team's right hand thinks with a plan signed in as an account",
      "brain.right_hand_account",
    );
  }
  // Its plan is whoever signed it in: only they give it to the right hand. "Atende outras pessoas" is as for any agent
  // on its owner's plan (ADR 0059 §5): the plan's owner chooses, an admin may override, and the plan's owner hears it
  // by email (`planOpened` below).
  if (rightHand && agent.ownerUserId !== userId && account !== null && account !== access.agent.brainAccountId) {
    throw new ForbiddenError("Only the plan's owner gives it to the team's right hand", "account.not_owner");
  }
  const accounts = await brainAccounts(deps.db, userId, orgId, agent, machine);
  const thinks =
    changed ||
    model !== agent.brainModel ||
    fallback !== agent.brainFallback ||
    extraUsage !== agent.brainExtraUsage ||
    account !== agent.brainAccountId ||
    effort !== agent.brainEffort ||
    contextTokens !== agent.contextTokens ||
    planForOthers !== agent.planForOthers;
  if (!thinks && !audience) return view(agent, machine, machines, accounts, userId);
  const { row, released } = await deps.db.transaction(async (tx) => {
    // A login made for one agent thinks for one: the check is taken again under its row's lock, so two agents
    // picking it at once can't both have it.
    if (account && account !== agent.brainAccountId) {
      const [locked] = await tx
        .select({ shared: schema.machineAccounts.shared })
        .from(schema.machineAccounts)
        .where(and(eq(schema.machineAccounts.orgId, orgId), eq(schema.machineAccounts.id, account)))
        .for("update");
      if (locked && !locked.shared) {
        const [other] = await tx
          .select({ id: schema.agents.id })
          .from(schema.agents)
          .where(
            and(
              eq(schema.agents.orgId, orgId),
              eq(schema.agents.brainAccountId, account),
              ne(schema.agents.id, agentId),
              isNull(schema.agents.archivedAt),
            ),
          );
        if (other && other.id !== next.from?.agentId) {
          throw new ConflictError("That account already thinks for another agent", "account.in_use");
        }
      }
    }
    const released = next.from ? await releaseAgents(tx, orgId, [next.from.accountId]) : [];
    const [row] = await tx
      .update(schema.agents)
      .set({
        brain,
        brainModel: model,
        brainFallback: fallback,
        brainExtraUsage: extraUsage,
        brainAccountId: account,
        brainEffort: effort,
        contextTokens,
        planForOthers,
        // The people and roles lists stay while it is its owner's only, for when it is let out again.
        ...(audience
          ? {
              audienceMode: audience.mode,
              ...(audience.mode === "everyone" ? { audienceUserIds: [], audienceRoleIds: [] } : {}),
            }
          : {}),
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
    // Onto a plan it answered nobody on it before: one that keeps answering others opens that plan to them.
    const planFrom = changed && isComputerBrain(brain) ? OWNER_ONLY : audienceOf(agent);
    let opened = false;
    if (row && audience) {
      await dropMailIfWidened(tx, orgId, agentId, agent.ownerUserId, audienceOf(agent), audienceOf(row), userId);
      const to = { ...audience, consultable: agent.consultable };
      opened = await audienceChanged(tx, orgId, userId, row, audienceOf(agent), to, planFrom);
    } else if (row && rightHand) {
      if (planForOthers && !agent.planForOthers) {
        const plan = { id: row.id, brain: row.brain, ownerUserId: agent.ownerUserId };
        opened = await planOpened(tx, orgId, userId, plan, OWNER_ONLY, audienceOf(row));
      }
    } else if (row && changed) opened = await planOpened(tx, orgId, userId, row, planFrom, audienceOf(row));
    if (opened) options.onPlanOpened?.();
    return { row, released };
  });
  caches.agents.delete(`${orgId}:${agentId}`);
  if (audience) caches.agents.delete(`${orgId}:team`);
  forgetAgents(orgId, released);
  if (thinks) {
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
          extraUsage: agent.brainExtraUsage,
          account: agent.brainAccountId,
          effort: agent.brainEffort,
          contextTokens: agent.contextTokens,
        },
        to: { brain, model, fallback, extraUsage, account, effort, contextTokens },
        ...(rightHand ? { planForOthers: { from: agent.planForOthers, to: planForOthers } } : {}),
        ...options.audit,
      },
    });
  }
  if (next.from) {
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: userId },
      action: "account.moved",
      target: { type: "machine_account", id: next.from.accountId },
      details: { from: next.from.agentId, to: agentId },
    });
  }
  const saved = row ?? {
    ...agent,
    brain,
    brainModel: model,
    brainFallback: fallback,
    brainExtraUsage: extraUsage,
    brainAccountId: account,
    brainEffort: effort,
    contextTokens,
    planForOthers,
    ...(audience ? { audienceMode: audience.mode } : {}),
  };
  // Never what new agents start with: its plan and its switch are its own.
  if (thinks && options.remember !== false && !rightHand) {
    await rememberAgentSetup(deps.db, membership, setupOfAgent(saved));
  }
  // Another AI, account or model, or extra usage on: what waited on the old one's plan or budget goes on now, in its
  // line's order.
  if (
    changed ||
    model !== agent.brainModel ||
    account !== agent.brainAccountId ||
    fallback !== agent.brainFallback ||
    (extraUsage && !agent.brainExtraUsage)
  )
    await wakeAgentUsageWaits(deps.db, orgId, agentId).catch(() => null);
  // The account's `usedBy` changed with it.
  // The right hand's row is on no computer: shown as its settings see it again.
  const shown = rightHand ? await settingsAgent(deps.db, saved, userId) : saved;
  const shownMachine = shown.machineId === machine?.id ? machine : await agentMachine(deps.db, orgId, shown.machineId);
  const fresh =
    account !== agent.brainAccountId || shownMachine !== machine
      ? await brainAccounts(deps.db, userId, orgId, shown, shownMachine)
      : accounts;
  return view(shown, shownMachine, machines, fresh, userId);
}

/**
 * The account the agent will run with (ADR 0041 §4, ADR 0059 §1–3): kept
 * when nothing asks otherwise, cleared when the brain kind changes. A plan
 * thinks only for its owner's agents, so the choice is among the agent's
 * owner's accounts (on the agent's computer, of the brain's kind; one made for
 * one agent that another uses only with `move`), or the computer's own sign-in
 * when they connected it. The agent's owner or an admin chooses.
 */
async function nextBrainAccount(
  db: Database,
  userId: string,
  orgId: string,
  agent: Pick<Agent, "id" | "brainAccountId" | "ownerUserId">,
  brain: BrainKind,
  changed: boolean,
  machine: MachineRow | null,
  input: unknown,
  options: { move: boolean; admin: boolean },
): Promise<{ id: string | null; from?: { accountId: string; agentId: string } }> {
  const kept = changed ? null : agent.brainAccountId;
  if (input === undefined) return { id: kept };
  if (input !== null && typeof input !== "string") {
    throw new ValidationError("Choose an account on the agent's computer", "account.invalid");
  }
  const wanted = input || null;
  if (wanted === kept) return { id: kept };
  const owner = agent.ownerUserId;
  const chooses = options.admin || owner === userId;
  if (wanted === null) {
    if (machine && !(chooses && owner !== null && machine.pairedByUserId === owner)) {
      throw new ForbiddenError(
        "The computer's own sign-in thinks only for the agents of whoever connected that computer",
        "account.not_owner",
      );
    }
    return { id: null };
  }
  const row = machine && isComputerBrain(brain) ? await getListedAccount(db, orgId, machine.id, wanted) : null;
  if (!row || row.kind !== brain) {
    throw new ValidationError("Choose an account of this brain on the agent's computer", "account.invalid", {
      brain,
    });
  }
  if (!chooses || owner === null || row.createdBy !== owner) {
    throw new ForbiddenError("A plan thinks only for its owner's agents", "account.not_owner");
  }
  // Made for all of its owner's agents there (protocol 29): it thinks for this one too.
  if (row.shared) return { id: row.id };
  const [other] = await db
    .select({ id: schema.agents.id, name: schema.agents.name })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.orgId, orgId),
        eq(schema.agents.brainAccountId, row.id),
        ne(schema.agents.id, agent.id),
        isNull(schema.agents.archivedAt),
      ),
    );
  if (other && !options.move) {
    throw new ConflictError(`That account already thinks for ${other.name}`, "account.in_use", {
      agent: other.name,
      agentId: other.id,
    });
  }
  return { id: row.id, ...(other ? { from: { accountId: row.id, agentId: other.id } } : {}) };
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
  // A mission names its model; "Automático" is the agent's own setting, which a mission without one follows.
  if (isAutoModel(model) && model !== mission.brainModel) {
    throw new ValidationError("Choose a model for the mission", "brain.invalid_model", { brain: effective });
  }
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
 * On a plan, the account it thinks with and that plan's limits, for everyone
 * (ADR 0063 §4, §5).
 */
export interface AgentBrainSummary {
  kind: BrainKind;
  model: string | null;
  computer?: string;
  /** A key account's coding plan (`zai`…): its maker's model thinks, through Claude Code. */
  provider?: string;
  /** The account's name ("Claude 2"); a computer's own sign-in by its maker and plan ("Claude Max"). */
  account?: string;
  /** That account's limits as the runner last reported them; absent: not known yet. */
  usage?: PlanUsage;
}

/**
 * The label of a computer brain's model ("opus" → "Opus", "GLM-5.3" on a plan; a typed Codex model as is): what it
 * runs, so a plan's model kept while Claude thinks reads as Sonnet.
 */
export function brainModelLabel(
  kind: BrainKind,
  model: string | null | undefined,
  provider?: string | null,
): string | null {
  if (kind === "model") return null;
  const plan = kind === "claude_code" ? planOf(provider) : undefined;
  if (plan) return planModel(plan, isAutoModel(model) ? null : model).label;
  const stored = model ?? defaultBrainModel(kind);
  if (!stored) return null;
  const value = kind === "claude_code" && !isAutoModel(stored) ? claudeCodeModel(undefined, stored) : stored;
  return brainModelOptions(kind).find((o) => o.value === value)?.label ?? value;
}

/** Each agent's brain summary for this viewer (one query for the computers, one for the accounts). */
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
    brainAccountId?: string | null;
  }[],
): Promise<Map<string, AgentBrainSummary>> {
  const out = new Map<string, AgentBrainSummary>();
  const computerIds = [
    ...new Set(agents.filter((a) => brainOf(a.brain) !== "model" && a.machineId).map((a) => a.machineId as string)),
  ];
  const accountIds = [
    ...new Set(
      agents.filter((a) => brainOf(a.brain) !== "model" && a.brainAccountId).map((a) => a.brainAccountId as string),
    ),
  ];
  const [membership, machines, accounts] = await Promise.all([
    computerIds.length ? getMembership(db, viewerId, orgId) : Promise.resolve(null),
    computerIds.length
      ? db
          .select({
            id: schema.machines.id,
            name: schema.machines.name,
            deletedAt: schema.machines.deletedAt,
            pairer: schema.machines.pairedByUserId,
            executors: schema.machines.executors,
          })
          .from(schema.machines)
          .where(and(eq(schema.machines.orgId, orgId), inArray(schema.machines.id, computerIds)))
      : Promise.resolve([]),
    accountIds.length
      ? db
          .select({
            id: schema.machineAccounts.id,
            label: schema.machineAccounts.label,
            provider: schema.machineAccounts.provider,
            usage: schema.machineAccounts.usage,
          })
          .from(schema.machineAccounts)
          .where(and(eq(schema.machineAccounts.orgId, orgId), inArray(schema.machineAccounts.id, accountIds)))
      : Promise.resolve([]),
  ]);
  const live = new Map(machines.filter((m) => !m.deletedAt).map((m) => [m.id, m]));
  const accountById = new Map(accounts.map((r) => [r.id, r]));
  const manages = membership !== null && !closedRefusal(membership.standing) && can(membership, "manage_agents");
  for (const a of agents) {
    const kind = brainOf(a.brain);
    const machine = a.machineId ? live.get(a.machineId) : undefined;
    const computer = machine && (manages || a.ownerUserId === viewerId) ? machine.name : undefined;
    const row = kind !== "model" && a.brainAccountId ? accountById.get(a.brainAccountId) : undefined;
    const provider = kind === "claude_code" ? (row?.provider ?? undefined) : undefined;
    const ownPlan = kind === "claude_code" ? machine?.executors?.claude?.plan : undefined;
    // With no account, the computer's own sign-in thinks only for its pairer's agents (ADR 0059 §3).
    const own =
      kind !== "model" && !a.brainAccountId && machine?.pairer && machine.pairer === a.ownerUserId
        ? {
            account: ownPlan
              ? `${defaultAccountLabel(kind)} ${ownPlan[0]?.toUpperCase()}${ownPlan.slice(1)}`
              : defaultAccountLabel(kind),
            usage: machine.executors?.ownUsage?.[kind],
          }
        : null;
    const plan = row ? { account: row.label, usage: row.usage ?? undefined } : own;
    out.set(a.id, {
      kind,
      model: brainModelLabel(kind, a.brainModel, provider),
      ...(kind !== "model" && computer ? { computer } : {}),
      ...(provider ? { provider } : {}),
      ...(plan ? { account: plan.account } : {}),
      ...(plan?.usage ? { usage: plan.usage } : {}),
    });
  }
  return out;
}

// ── Contas de IA ────────────────────────────────────────────────────────────

/** A computer of the organization as the AI accounts page needs it. */
export interface AiComputer {
  machineId: string;
  name: string;
  online: boolean;
  /** The caller connected it. */
  mine: boolean;
  /** The caller adds accounts there (they connected it, or nobody did), on a runner that knows accounts. */
  canAdd: boolean;
  /** Its runner takes coding plans' keys (protocol 20). */
  keys: boolean;
  /**
   * A new sign-in there thinks for all of the caller's agents on it (protocol 29): Claude's, ChatGPT's and a
   * coding plan's key.
   */
  shares: { claude_code: boolean; codex: boolean; cursor: boolean; opencode: boolean; grok: boolean; key: boolean };
  /** What it can think with now: Claude Code (Claude and the coding plans), Codex (ChatGPT), Cursor, OpenCode, Grok. */
  brains: { claude_code: boolean; codex: boolean; cursor: boolean; opencode: boolean; grok: boolean };
  /**
   * "Conta deste computador": each CLI's own sign-in there, on a computer the caller connected (it is theirs, and
   * the agents on it think with it when no account is picked). Claude Code when `claude auth status` said it is
   * signed in (or its plan's usage is known); Codex once its usage is known. Its plan and usage when known.
   */
  own: Partial<Record<AccountKind, OwnSignIn>>;
}

/** A computer's own sign-in as the AI accounts page lists it. */
export interface OwnSignIn {
  /** The plan the CLI reported (`max`, `pro`…); absent when it didn't say. */
  plan?: string;
  usage?: PlanUsage;
}

export interface AiAccountsView {
  /** The caller's own accounts, on every computer, each with where it is. */
  accounts: (MachineAccountView & { machineId: string; computer: string })[];
  computers: AiComputer[];
}

/** `GET …/ai-accounts` (any member): the caller's plans and keys on the computers, and where they can add one. */
export async function listAiAccounts(deps: BrainDeps, userId: string, orgId: string): Promise<AiAccountsView> {
  await requirePermission(deps.db, userId, orgId, "read");
  const rows = await deps.db
    .select()
    .from(schema.machines)
    .where(and(eq(schema.machines.orgId, orgId), isNull(schema.machines.deletedAt)))
    .orderBy(schema.machines.createdAt);
  const accounts = await Promise.all(
    rows.map(async (m) =>
      (await listMachineAccounts(deps, orgId, m.id, userId))
        .filter((a) => a.mine)
        .map((a) => ({ ...a, machineId: m.id, computer: m.name })),
    ),
  );
  return {
    accounts: accounts.flat(),
    computers: rows.map((m) => {
      const options = brainOptions(m);
      const can = (kind: BrainKind) => options.some((o) => o.kind === kind && o.available);
      return {
        machineId: m.id,
        name: m.name,
        online: machineOnline(m),
        mine: m.pairedByUserId === userId,
        canAdd: mayAddAccounts(m, userId) && m.protocol >= ACCOUNTS_PROTOCOL,
        keys: m.protocol >= PLAN_KEYS_PROTOCOL,
        shares: {
          claude_code: sharesSignIns(m, "claude_code"),
          codex: sharesSignIns(m, "codex"),
          cursor: sharesSignIns(m, "cursor"),
          opencode: sharesSignIns(m, "opencode"),
          grok: sharesSignIns(m, "grok"),
          key: sharesSignIns(m, "key"),
        },
        brains: {
          claude_code: can("claude_code"),
          codex: can("codex"),
          cursor: can("cursor"),
          opencode: can("opencode"),
          grok: can("grok"),
        },
        own:
          m.pairedByUserId === userId
            ? ownSignIns(m.executors, can)
            : // OpenCode's free tier there thinks for anyone's agents (ADR 0132): nobody signs in on it.
              m.pairedByUserId === null && can("opencode")
              ? { opencode: {} }
              : {},
      };
    }),
  };
}

/** The CLIs' own sign-ins a computer reported (see `AiComputer.own`). */
function ownSignIns(
  executors: schema.MachineExecutors | null | undefined,
  can: (kind: BrainKind) => boolean,
): Partial<Record<AccountKind, OwnSignIn>> {
  const usage: OwnPlanUsage = executors?.ownUsage ?? {};
  const out: Partial<Record<AccountKind, OwnSignIn>> = {};
  const claude = executors?.claude;
  // A usage read stays after a sign-out (`ownUsage` is never cleared): `claude auth status` saying signed out wins,
  // as it does for the turns (`claudeCodeAvailability`).
  if (can("claude_code") && (claude?.loggedIn === true || (claude?.loggedIn !== false && usage.claude_code)))
    out.claude_code = {
      ...(claude?.plan ? { plan: claude.plan } : {}),
      ...(usage.claude_code ? { usage: usage.claude_code } : {}),
    };
  if (can("codex") && usage.codex) out.codex = { usage: usage.codex };
  // Its own OpenCode always thinks: its own sign-ins, or the free tier with none.
  if (can("opencode")) out.opencode = {};
  return out;
}
