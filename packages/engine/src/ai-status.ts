import { and, asc, type Executor, eq, isNull, schema } from "@agenteschat/db";
import { ensureOpenRouterModels, isAutoModel, modelForTier, routerModelOf } from "@agenteschat/providers";
import type { Agent } from "./agents";
import { autoProvider } from "./auto-model";
import { brainOf } from "./brain-settings";
import { brainAccountFor, computerBrainUnavailable, mayFallBack, NO_AI_CODES } from "./brains/select";
import type { ModelGateway } from "./gateway";
import type { MachineStatus } from "./machine-hub";
import { missionTurnFor } from "./missions-engine";
import { orgKeyProviders, orgModelProvider, type RoutingSetup } from "./router";
import { planSignInsOf } from "./router-plan";
import type { AgentRun } from "./runs";

/**
 * Whether an agent has an AI to think with (ADR 0061), from what the engine already uses: a key for its
 * model brain, or its computer brain's availability (with the model brain as the fallback). `waiting`:
 * its computer is away for now (offline, paused, a plan limit), which is not "no AI". Computed per
 * request, with no cache and no secrets: no key is decrypted.
 */
export type AiState = "ready" | "no_ai" | "waiting";

/** Why an agent has no AI, as its card and the Connect dialog put it. */
export type NoAiReason = "no_key" | "not_signed_in" | "no_computer" | "cli_missing";

export interface AgentAi {
  state: AiState;
  /** With `no_ai`. */
  reason?: NoAiReason;
}

export interface AiStatusDeps {
  db: Executor;
  gateway: Pick<ModelGateway, "hasModelCredential">;
  /** Computers' status (the machine hub); absent: a computer brain with a computer counts as ready. */
  machines?: { status(machineId: string): Promise<MachineStatus | null> } | null;
}

type AiAgent = Pick<
  Agent,
  "orgId" | "model" | "credentialId" | "brain" | "brainFallback" | "brainAccountId" | "machineId"
>;

/** The run being checked: a mission's turn thinks with the mission's brain, and background work never falls back. */
type AiRun = Pick<AgentRun, "id" | "orgId" | "agentId" | "threadRootId" | "triggerMessageId" | "background">;

const READY: AgentAi = { state: "ready" };

/** The model brain can be called. `auto` isn't in the catalog: its provider's everyday model stands for it. */
async function modelReady(deps: AiStatusDeps, agent: AiAgent): Promise<boolean> {
  if (!isAutoModel(agent.model)) return deps.gateway.hasModelCredential(agent);
  const provider = await autoProvider(deps.db, agent).catch(() => "anthropic");
  // OpenRouter's line is its list.
  if (provider === "openrouter") await ensureOpenRouterModels();
  const model = modelForTier(provider, "medium") ?? modelForTier("anthropic", "medium");
  return model !== null && (await deps.gateway.hasModelCredential({ ...agent, model }));
}

/** The card's reason for an unavailable code in `NO_AI_CODES`. */
export const noAiReasonOf = (code: string): NoAiReason =>
  code === "not_logged_in" ? "not_signed_in" : code === "no_computer" ? "no_computer" : "cli_missing";

/** One agent (for one run, when given: right after its row is read, before any judge or model call). */
export async function agentAiState(deps: AiStatusDeps, agent: AiAgent, run?: AiRun): Promise<AgentAi> {
  const mission = run ? await missionTurnFor(deps.db, run).catch(() => null) : null;
  const kind = mission?.brain ?? brainOf(agent.brain);
  if (kind === "model") return (await modelReady(deps, agent)) ? READY : { state: "no_ai", reason: "no_key" };
  const machineId = mission?.session?.machineId ?? agent.machineId ?? null;
  const [status, account] = await Promise.all([
    machineId && deps.machines ? deps.machines.status(machineId).catch(() => null) : null,
    brainAccountFor(deps.db, agent, kind, machineId),
  ]);
  const unavailable =
    machineId && !deps.machines ? null : computerBrainUnavailable(kind, machineId, status, Date.now(), account);
  if (!unavailable) return READY;
  if (mayFallBack(agent, { background: run?.background ?? false }) && (await modelReady(deps, agent))) return READY;
  return NO_AI_CODES.has(unavailable.code)
    ? { state: "no_ai", reason: noAiReasonOf(unavailable.code) }
    : { state: "waiting" };
}

const agentFields = {
  id: schema.agents.id,
  orgId: schema.agents.orgId,
  model: schema.agents.model,
  credentialId: schema.agents.credentialId,
  brain: schema.agents.brain,
  brainFallback: schema.agents.brainFallback,
  brainAccountId: schema.agents.brainAccountId,
  machineId: schema.agents.machineId,
};

const activeAgents = (db: Executor, orgId: string) =>
  db
    .select(agentFields)
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, orgId), isNull(schema.agents.archivedAt)))
    .orderBy(asc(schema.agents.createdAt));

/** Every agent that isn't archived, and `any`: at least one of them is ready or waiting for its computer. */
export async function orgAiStatus(deps: AiStatusDeps, orgId: string) {
  const states = await Promise.all(
    (await activeAgents(deps.db, orgId)).map(async (a) => ({ agentId: a.id, ...(await agentAiState(deps, a)) })),
  );
  return { any: states.some((s) => s.state !== "no_ai"), agents: states };
}

/** `orgAiStatus(…).any`, stopping at the first agent that has an AI (it runs before routing every message). */
export async function orgHasAi(deps: AiStatusDeps, orgId: string): Promise<boolean> {
  for (const agent of await activeAgents(deps.db, orgId)) {
    if ((await agentAiState(deps, agent)).state !== "no_ai") return true;
  }
  return false;
}

/**
 * Who picks the agents for a message nobody mentioned (ADR 0074), as Settings and the members menu say it:
 * `by` for the workspace, `mine` for the person asking (a plan picks only for its owner's own messages).
 */
export interface AiRouting {
  by: "jev" | "model" | "plans" | "rules" | "off";
  mine: "jev" | "model" | "plan" | "rules" | "off";
  /** The small model, while it picks. */
  model: string | null;
  /** With `rules`: the default key's provider, which has no small model (Kimi alone). */
  noSmallModel: string | null;
}

/**
 * The first step of the chain that can pick for this workspace now, without asking any. `off`: the router is
 * off. `apiKey`: a key of its own, or the server's own Claude key. No key is decrypted.
 */
export async function orgRouting(
  deps: AiStatusDeps,
  routing: RoutingSetup | null,
  orgId: string,
  userId: string,
): Promise<{ routing: AiRouting; apiKey: boolean }> {
  const keys = await orgKeyProviders(deps.db, orgId);
  const claude = routerModelOf("anthropic");
  const apiKey =
    keys.size > 0 ||
    (claude !== null && (await deps.gateway.hasModelCredential({ orgId, model: claude, credentialId: null })));
  const of = (by: AiRouting["by"], mine: AiRouting["mine"], model: string | null, noSmallModel: string | null) => ({
    routing: { by, mine, model, noSmallModel },
    apiKey,
  });
  if (!routing) return of("off", "off", null, null);
  if (await routing.jev()) return of("jev", "jev", null, null);
  const model = await routing.smallModel(orgId);
  if (model) return of("model", "model", model, null);
  const plans = routing.plans ? await planSignInsOf(deps.db, routing.plans, orgId) : [];
  const mine = plans.some((p) => p.ownerId === userId) ? "plan" : "rules";
  if (plans.length > 0) return of("plans", mine, null, null);
  return of("rules", mine, null, keys.size > 0 ? await orgModelProvider(deps.db, orgId) : null);
}
