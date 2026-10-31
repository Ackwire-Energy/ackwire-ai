import { and, type Database, eq, inArray, isNull, schema } from "@agenteschat/db";
import { type ContextLimit, isAutoModel, isContextLimit } from "@agenteschat/providers";
import { type CodingPlan, PLAN_ALIASES, planOf } from "@agenteschat/providers/plans";
import { type Agent, type AgentInput, rememberAgentSetup, updateAgent, validateAgentFields } from "./agents";
import { answersOthers, audienceOf } from "./audience";
import {
  type AgentBrainInput,
  type BrainEffortSetting,
  brainModelLabel,
  brainOf,
  brainOptions,
  defaultBrainModel,
  isBrainEffortSetting,
  isBrainKind,
  normalizeBrainModel,
  setAgentBrain,
} from "./brain-settings";
import type { BrainKind } from "./brains/types";
import { caches } from "./cache";
import { ValidationError } from "./errors";
import { defaultAccountLabel, listMachineAccounts, type MachineAccountView } from "./machine-accounts";
import { getMachine } from "./machines";
import { can, requirePermission } from "./organizations";

/*
 * One agent's "Quem pensa" on others (ADR 0089): "Usar em outros agentes" applies it to each agent picked, by that
 * agent's own rules (who may change it, whose plan thinks for it), and says why the others can't take it. The last one
 * saved or used on others is what new agents start with (`rememberAgentSetup`).
 */

/** At most this many agents in one call. */
export const SETUP_AGENTS_MAX = 200;

/** A setup as "Quem pensa" chose it; `onlyOwner` ("Atende outras pessoas" off) only where it moves onto the plan. */
export interface AgentSetupInput {
  brain?: unknown;
  model?: unknown;
  key?: unknown;
  machineId?: unknown;
  account?: unknown;
  effort?: unknown;
  contextTokens?: unknown;
  fallback?: unknown;
  onlyOwner?: unknown;
}

type Setup = schema.AgentSetup & { onlyOwner?: boolean };

/** Why an agent can't take the setup. */
export type SetupReason =
  /** Neither an admin nor its owner. */
  | "not_allowed"
  /** Its API model or key: only admins change them. */
  | "admins_only"
  /** The plan thinks only for its owner's agents, chosen by that owner (`params.owner`: whose, when not the caller's). */
  | "account_owner"
  /** That account's sign-in thinks for one agent, another one (`params.agent`). */
  | "account_single"
  /** It works on another computer (`params.computer`), or on none. */
  | "other_computer"
  /** It keeps its own plan, which lacks the model (`params.plan`, `params.model`). */
  | "model_missing"
  | "failed";

export interface SetupResult {
  agentId: string;
  /** `applied` (in a preview, would be); `same`: it already thinks this way; `skipped`: it can't take it. */
  status: "applied" | "same" | "skipped";
  /** It takes the rest with the account it already has (another person's plan): that account's name, null for its computer's own sign-in. */
  keeps?: { account: string | null };
  reason?: SetupReason;
  params?: Record<string, string>;
}

const nullableId = (v: unknown, what: string): string | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") throw new ValidationError(`${what} is an id`, "setup.invalid");
  return v;
};

/** The setup as stored and applied: each field checked like `PUT …/agents/{id}/brain` checks it. */
function readSetup(input: AgentSetupInput): Setup {
  if (!isBrainKind(input.brain)) throw new ValidationError("Choose model, claude_code or codex", "brain.invalid");
  const contextTokens = input.contextTokens ?? null;
  if (contextTokens !== null && !isContextLimit(contextTokens)) {
    throw new ValidationError("Choose 200000, 400000 or 1000000 tokens", "brain.invalid_context");
  }
  if (input.brain === "model") {
    if (typeof input.model !== "string" || !input.model) {
      throw new ValidationError("The API brain needs a model", "brain.invalid_model");
    }
    return {
      brain: "model",
      model: input.model,
      ...(input.key !== undefined ? { key: nullableId(input.key, "key") } : {}),
      contextTokens,
    };
  }
  const machineId = nullableId(input.machineId, "machineId");
  if (!machineId) throw new ValidationError("A computer brain thinks on a computer", "setup.invalid");
  const effort = input.effort ?? null;
  if (effort !== null && !isBrainEffortSetting(effort)) {
    throw new ValidationError("Choose auto, low, medium, high, xhigh or max", "brain.invalid_effort");
  }
  for (const flag of [input.fallback, input.onlyOwner]) {
    if (flag !== undefined && typeof flag !== "boolean")
      throw new ValidationError("A switch is on or off", "setup.invalid");
  }
  return {
    brain: input.brain,
    model: normalizeBrainModel(input.brain, input.model),
    machineId,
    account: nullableId(input.account, "account"),
    effort,
    contextTokens,
    fallback: (input.fallback as boolean | undefined) ?? true,
    ...(input.onlyOwner !== undefined ? { onlyOwner: input.onlyOwner as boolean } : {}),
  };
}

/** Whether a model runs on an account: a coding plan runs its own models (and its aliases), Claude's sign-in Claude's. */
function modelFits(kind: BrainKind, model: string | null, plan: CodingPlan | undefined) {
  if (kind !== "claude_code" || model === null || isAutoModel(model)) return true;
  if (plan) return plan.claudeCode.models.some((m) => m.id === model || m.alias === model);
  return PLAN_ALIASES.some((a) => a === model) || model.startsWith("claude-");
}

const sameModel = (kind: BrainKind, a: string | null, b: string | null) =>
  (a ?? defaultBrainModel(kind)) === (b ?? defaultBrainModel(kind));

type Plan =
  | { status: "same" }
  | { status: "skipped"; reason: SetupReason; params?: Record<string, string> }
  | { status: "applied"; brain: AgentBrainInput; patch?: Partial<AgentInput>; keeps?: { account: string | null } };

const skip = (reason: SetupReason, params?: Record<string, string>): Plan => ({
  status: "skipped",
  reason,
  ...(params ? { params } : {}),
});

/** A refusal of `setAgentBrain` or `updateAgent`, as the reason an agent can't take the setup. */
function refusal(error: unknown): Pick<SetupResult, "reason" | "params"> {
  const { code, params } = (error ?? {}) as { code?: unknown; params?: Record<string, unknown> };
  if (code === "agent.not_owner") return { reason: "not_allowed" };
  if (code === "account.not_owner" || code === "audience.plan_owner_only") return { reason: "account_owner" };
  if (code === "account.in_use") {
    return {
      reason: "account_single",
      ...(typeof params?.agent === "string" ? { params: { agent: params.agent } } : {}),
    };
  }
  if (code === "account.invalid" || code === "brain.unavailable" || code === "brain.no_computer") {
    return { reason: "other_computer" };
  }
  if (code === "forbidden") return { reason: "admins_only" };
  return { reason: "failed" };
}

/** Thrown to roll a preview back: it ran every agent's change as it would, and keeps none. */
class PreviewOnly extends Error {}

/**
 * `POST …/agents/brain-setup`: the setup on each agent picked, each by its own rules and in its own savepoint, audited
 * as its own change (`agent.brain` with `via: "setup"`). With `preview`, the same run rolled back: what each would
 * do, nothing kept. Applied, it is what new agents start with.
 */
export async function applyAgentSetup(
  deps: { db: Database },
  userId: string,
  orgId: string,
  input: { setup: AgentSetupInput; agentIds: readonly string[]; preview?: boolean },
): Promise<SetupResult[]> {
  const membership = await requirePermission(deps.db, userId, orgId, "read");
  const admin = can(membership, "manage_agents");
  const setup = readSetup(input.setup);
  const ids = [...new Set(input.agentIds)];
  if (ids.length > SETUP_AGENTS_MAX) throw new ValidationError(`At most ${SETUP_AGENTS_MAX} agents`, "setup.invalid");
  if (setup.brain === "model") {
    await validateAgentFields(deps.db, orgId, { model: setup.model ?? undefined, credentialId: setup.key ?? null });
  }
  const targets = ids.length
    ? await deps.db
        .select()
        .from(schema.agents)
        .where(and(eq(schema.agents.orgId, orgId), inArray(schema.agents.id, ids), isNull(schema.agents.archivedAt)))
    : [];
  const machine = setup.machineId ? await getMachine(deps.db, orgId, setup.machineId) : null;
  const theirs = machine ? await listMachineAccounts(deps, orgId, machine.id, userId) : [];
  const account = setup.account ? theirs.find((a) => a.id === setup.account) : undefined;
  // The computer's own sign-in is its pairer's plan: who else may pick it says whose it is.
  const pairer = machine?.pairedByUserId && machine.pairedByUserId !== userId ? machine.pairedByUserId : null;
  const [paired] = pairer
    ? await deps.db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, pairer))
    : [];
  // What the agents that keep their own accounts think with now, and the computers the others work on.
  const ownIds = targets.map((t) => t.brainAccountId).filter((id): id is string => id !== null);
  const [owns, computers] = await Promise.all([
    ownIds.length
      ? deps.db
          .select({
            id: schema.machineAccounts.id,
            label: schema.machineAccounts.label,
            provider: schema.machineAccounts.provider,
          })
          .from(schema.machineAccounts)
          .where(and(eq(schema.machineAccounts.orgId, orgId), inArray(schema.machineAccounts.id, ownIds)))
      : Promise.resolve([]),
    deps.db
      .select({ id: schema.machines.id, name: schema.machines.name })
      .from(schema.machines)
      .where(and(eq(schema.machines.orgId, orgId), isNull(schema.machines.deletedAt))),
  ]);
  const ownById = new Map(owns.map((o) => [o.id, o]));
  const computerName = new Map(computers.map((c) => [c.id, c.name]));
  const plan = (t: Agent) =>
    planFor(t, {
      setup,
      admin,
      userId,
      machine,
      account,
      ownById,
      computerName,
      sourcePlan: account?.provider ?? null,
      pairerName: paired?.name ?? null,
    });

  const results = new Map<string, SetupResult>();
  const applied: string[] = [];
  try {
    await deps.db.transaction(async (tx) => {
      for (const t of targets) {
        const p = plan(t);
        if (p.status !== "applied") {
          results.set(t.id, { agentId: t.id, ...p });
          continue;
        }
        try {
          await tx.transaction(async (sp) => {
            if (p.patch) await updateAgent(sp, userId, orgId, t.id, p.patch, { remember: false });
            await setAgentBrain({ db: sp }, userId, orgId, t.id, p.brain, { remember: false, audit: { via: "setup" } });
          });
          applied.push(t.id);
          results.set(t.id, { agentId: t.id, status: "applied", ...(p.keeps ? { keeps: p.keeps } : {}) });
        } catch (error) {
          results.set(t.id, { agentId: t.id, status: "skipped", ...refusal(error) });
        }
      }
      if (input.preview) throw new PreviewOnly();
      const { onlyOwner: _, ...stored } = setup;
      await rememberAgentSetup(tx, orgId, stored);
    });
  } catch (error) {
    if (!(error instanceof PreviewOnly)) throw error;
  }
  // The rows changed in the transaction: what was read meanwhile goes too.
  for (const id of applied) caches.agents.delete(`${orgId}:${id}`);
  if (applied.length) caches.agents.delete(`${orgId}:team`);
  return ids.flatMap((id) => results.get(id) ?? []);
}

/** What the setup does to one agent, from what is known before any change; `setAgentBrain` decides again. */
function planFor(
  t: Agent,
  c: {
    setup: Setup;
    admin: boolean;
    userId: string;
    machine: Awaited<ReturnType<typeof getMachine>>;
    account: MachineAccountView | undefined;
    ownById: Map<string, { label: string; provider: string | null }>;
    computerName: Map<string, string>;
    sourcePlan: string | null;
    /** Whoever connected the setup's computer, when not the caller. */
    pairerName: string | null;
  },
): Plan {
  const { setup, admin, userId } = c;
  if (!admin && t.ownerUserId !== userId) return skip("not_allowed");
  if (setup.brain === "model") {
    const patch: Partial<AgentInput> = {
      ...(t.model !== setup.model && setup.model ? { model: setup.model } : {}),
      ...("key" in setup && (t.credentialId ?? null) !== (setup.key ?? null)
        ? { credentialId: setup.key ?? null }
        : {}),
    };
    const changes = Object.keys(patch).length > 0;
    if (brainOf(t.brain) === "model" && !changes && t.contextTokens === setup.contextTokens) return { status: "same" };
    if (changes && !admin) return skip("admins_only");
    return {
      status: "applied",
      brain: { brain: "model", contextTokens: setup.contextTokens ?? null },
      ...(changes ? { patch } : {}),
    };
  }
  const kind = setup.brain;
  const how = {
    model: setup.model,
    effort: setup.effort ?? null,
    contextTokens: setup.contextTokens ?? null,
    fallback: setup.fallback ?? true,
  };
  const thinksSo = (account: string | null, onlyOwner?: boolean) =>
    brainOf(t.brain) === kind &&
    t.brainAccountId === account &&
    sameModel(kind, t.brainModel, how.model) &&
    t.brainEffort === how.effort &&
    t.contextTokens === how.contextTokens &&
    t.brainFallback === how.fallback &&
    (onlyOwner === undefined || !answersOthers(audienceOf(t), t.ownerUserId) === onlyOwner);
  const takes = takesAccount(t, c);
  if (takes === true) {
    if (thinksSo(setup.account ?? null, setup.onlyOwner)) return { status: "same" };
    return {
      status: "applied",
      brain: {
        brain: kind,
        account: setup.account ?? null,
        ...how,
        ...(setup.onlyOwner !== undefined ? { onlyOwner: setup.onlyOwner } : {}),
      },
    };
  }
  // Already on this brain with an account of its own (another person's plan): it keeps that and takes the rest.
  if (brainOf(t.brain) === kind) {
    const own = t.brainAccountId ? c.ownById.get(t.brainAccountId) : undefined;
    const ownPlan = kind === "claude_code" ? planOf(own?.provider) : undefined;
    if (!modelFits(kind, how.model, ownPlan)) {
      return skip("model_missing", {
        plan: ownPlan?.label ?? defaultAccountLabel(kind),
        model: brainModelLabel(kind, how.model, c.sourcePlan) ?? "",
      });
    }
    if (thinksSo(t.brainAccountId)) return { status: "same" };
    return { status: "applied", brain: how, keeps: { account: own?.label ?? null } };
  }
  return takes;
}

/** Whether the setup's account (or its computer's own sign-in) can think for the agent, else why not. */
function takesAccount(
  t: Agent,
  c: Pick<Parameters<typeof planFor>[1], "setup" | "userId" | "machine" | "account" | "computerName" | "pairerName">,
): true | Plan {
  const { setup, userId, machine } = c;
  if (!machine || !brainOptions(machine).some((o) => o.kind === setup.brain && o.available)) return skip("failed");
  if (t.machineId !== machine.id) {
    const where = t.machineId ? c.computerName.get(t.machineId) : undefined;
    return skip("other_computer", where ? { computer: where } : undefined);
  }
  if (setup.account) {
    const a = c.account;
    if (!a || a.kind !== setup.brain) return skip("failed");
    // Only the owner of both the account and the agent chooses it (ADR 0059 §3).
    if (a.ownerId !== userId) return skip("account_owner", a.ownerName ? { owner: a.ownerName } : undefined);
    if (t.ownerUserId !== userId) return skip("account_owner");
    const other = a.shared ? -1 : a.usedByIds.findIndex((id) => id !== t.id);
    if (other >= 0) return skip("account_single", { agent: a.usedBy[other] ?? "" });
    return true;
  }
  // The computer's own sign-in thinks only for the agents of whoever connected it; on one nobody did, for none.
  if (!machine.pairedByUserId) return skip("failed");
  if (machine.pairedByUserId !== userId)
    return skip("account_owner", c.pairerName ? { owner: c.pairerName } : undefined);
  if (t.ownerUserId !== userId) return skip("account_owner");
  return true;
}

/** "Criar agente": the setup new agents start with, as it stands now; null when there is none to start with. */
export interface NewAgentSetup {
  brain: BrainKind;
  model: string | null;
  /** The API brain's key, still the workspace's; null: the workspace's default. */
  key: string | null;
  contextTokens: ContextLimit | null;
  /** A computer brain: where it thinks. */
  computer?: { machineId: string; name: string };
  /** Its account there; null: that computer's own sign-in. */
  account?: {
    id: string;
    label: string;
    provider: string | null;
    /** The caller's own: a plan thinks only for its owner's agents. */
    mine: boolean;
    /** It can think for one more agent: made for all of its owner's agents there, or thinking for none. */
    free: boolean;
  } | null;
  /** The computer's own sign-in thinks for the caller's agents there (they connected it). */
  ownSignIn?: boolean;
  effort?: BrainEffortSetting | null;
  fallback?: boolean;
}

/** `GET …/agent-setup` (whoever creates agents): what a new agent starts thinking with. */
export async function getNewAgentSetup(
  deps: { db: Database },
  userId: string,
  orgId: string,
): Promise<NewAgentSetup | null> {
  await requirePermission(deps.db, userId, orgId, "create_agents");
  const [row] = await deps.db
    .select({ setup: schema.organizationSettings.agentSetup })
    .from(schema.organizationSettings)
    .where(eq(schema.organizationSettings.orgId, orgId));
  const s = row?.setup;
  if (!s || !isBrainKind(s.brain)) return null;
  const contextTokens = isContextLimit(s.contextTokens) ? s.contextTokens : null;
  if (s.brain === "model") {
    const [key] = s.key
      ? await deps.db
          .select({ id: schema.providerCredentials.id })
          .from(schema.providerCredentials)
          .where(
            and(
              eq(schema.providerCredentials.orgId, orgId),
              eq(schema.providerCredentials.id, s.key),
              isNull(schema.providerCredentials.revokedAt),
            ),
          )
      : [];
    return { brain: "model", model: s.model, key: key?.id ?? null, contextTokens };
  }
  const machine = s.machineId ? await getMachine(deps.db, orgId, s.machineId) : null;
  if (!machine || !brainOptions(machine).some((o) => o.kind === s.brain && o.available)) return null;
  const listed = s.account
    ? (await listMachineAccounts(deps, orgId, machine.id, userId)).find((a) => a.id === s.account)
    : undefined;
  if (s.account && (!listed || listed.kind !== s.brain)) return null;
  return {
    brain: s.brain,
    model: s.model,
    key: null,
    contextTokens,
    computer: { machineId: machine.id, name: machine.name },
    account: listed
      ? {
          id: listed.id,
          label: listed.label,
          provider: listed.provider,
          mine: listed.mine,
          free: listed.shared || listed.usedByIds.length === 0,
        }
      : null,
    ownSignIn: machine.pairedByUserId === userId,
    effort: isBrainEffortSetting(s.effort) ? s.effort : null,
    fallback: s.fallback ?? true,
  };
}
