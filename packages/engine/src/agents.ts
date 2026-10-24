import { and, asc, type Database, eq, isNull, schema } from "@agenteschat/db";
import { AUTO_MODEL, isAutoModel, isKnownModel, MODEL_CATALOG } from "@agenteschat/providers";
import type { AgentAppearance } from "./appearance";
import { caches } from "./cache";
import { ConflictError, isUniqueViolation, NotFoundError, ValidationError } from "./errors";
import { getMembership, requirePermission } from "./organizations";
import { DEFAULT_AGENT_SCOPES, grantScopes } from "./tools/scopes";
import { resyncBudgetCounter } from "./usage";

const { agents, providerCredentials } = schema;

export type Agent = typeof agents.$inferSelect;

export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;

export interface AgentInput {
  name: string;
  handle: string;
  role?: string;
  instructions?: string;
  model?: string;
  credentialId?: string | null;
  ownerUserId?: string | null;
  monthlyBudgetNanoUsd?: number | null;
}

async function validate(db: Database, orgId: string, input: Partial<AgentInput>) {
  if (input.handle !== undefined && !HANDLE_PATTERN.test(input.handle)) {
    throw new ValidationError("handle must be 2–32 characters: lower-case letters, digits, - or _");
  }
  // "auto": each run picks the model from the line of the agent's key (any provider).
  if (input.model !== undefined && !isAutoModel(input.model) && !isKnownModel(input.model)) {
    throw new ValidationError(`model must be ${AUTO_MODEL} or one of: ${Object.keys(MODEL_CATALOG).join(", ")}`);
  }
  if (input.monthlyBudgetNanoUsd != null && input.monthlyBudgetNanoUsd < 0) {
    throw new ValidationError("budget can't be negative");
  }
  if (input.credentialId) {
    const [cred] = await db
      .select({ id: providerCredentials.id, provider: providerCredentials.provider })
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.id, input.credentialId),
          eq(providerCredentials.orgId, orgId),
          isNull(providerCredentials.revokedAt),
        ),
      );
    if (!cred) throw new ValidationError("credentialId does not belong to this organization");
    const model = input.model ? MODEL_CATALOG[input.model] : undefined;
    if (model && model.provider !== cred.provider) {
      throw new ValidationError(
        `The model ${input.model} is from ${model.provider}, but this key is from ${cred.provider}`,
      );
    }
  }
  if (input.ownerUserId && !(await getMembership(db, input.ownerUserId, orgId))) {
    throw new ValidationError("ownerUserId must be a member of this organization");
  }
}

/** What a person's new agent thinks with when nobody picks a model: "Automático". */
export const NEW_AGENT_DEFAULTS = { model: AUTO_MODEL } as const;

export async function createAgent(
  db: Database,
  actorId: string,
  orgId: string,
  input: AgentInput,
  defaults: { model: string },
): Promise<Agent> {
  await requirePermission(db, actorId, orgId, "manage_agents");
  const values = { ...input, handle: input.handle.toLowerCase(), model: input.model ?? defaults.model };
  await validate(db, orgId, values);
  // An agent born on "Automático" is automatic on every brain: switched to Claude Code or Codex later, it
  // starts with the model and effort picked per run (written here, so agents made before Automático keep theirs).
  const brainAuto = isAutoModel(values.model) ? { brainModel: AUTO_MODEL, brainEffort: AUTO_MODEL } : {};
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        ...values,
        ...brainAuto,
        orgId,
        ownerUserId: input.ownerUserId === undefined ? actorId : input.ownerUserId,
      })
      .returning();
    if (!agent) throw new Error("agent insert returned nothing");
    // Every agent may read context, keep its own notes and use its computer; everything else is granted explicitly.
    await grantScopes(
      db,
      orgId,
      agent.id,
      DEFAULT_AGENT_SCOPES.map((scope) => ({ connectionId: null, scope })),
    );
    // Skills the org marked "default for new agents".
    const defaults = await db
      .select({ id: schema.skills.id })
      .from(schema.skills)
      .where(
        and(
          eq(schema.skills.orgId, orgId),
          eq(schema.skills.defaultForNewAgents, true),
          isNull(schema.skills.deletedAt),
        ),
      );
    if (defaults.length > 0) {
      await db
        .insert(schema.agentSkills)
        .values(defaults.map((s) => ({ orgId, agentId: agent.id, skillId: s.id, enabled: true })))
        .onConflictDoNothing();
    }
    // Every agent has a budget (its own or the org's default): the month's counter exists
    // from the start, so the first call reserves in one statement.
    caches.agents.delete(`${orgId}:team`);
    await resyncBudgetCounter(db, orgId, agent.id);
    return agent;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`@${values.handle} is already taken`);
    throw error;
  }
}

export async function updateAgent(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  input: Partial<Omit<AgentInput, "handle">>,
): Promise<Agent> {
  await requirePermission(db, actorId, orgId, "manage_agents");
  await validate(db, orgId, input);
  const [agent] = await db
    .update(agents)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
    .returning();
  if (!agent) throw new NotFoundError("Agent not found");
  caches.agents.delete(`${orgId}:${agentId}`);
  caches.agents.delete(`${orgId}:team`);
  if (input.monthlyBudgetNanoUsd !== undefined) await resyncBudgetCounter(db, orgId, agentId);
  return agent;
}

export async function archiveAgent(db: Database, actorId: string, orgId: string, agentId: string) {
  await requirePermission(db, actorId, orgId, "manage_agents");
  await db
    .update(agents)
    .set({ archivedAt: new Date() })
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  caches.agents.delete(`${orgId}:${agentId}`);
  caches.agents.delete(`${orgId}:team`);
}

export async function listAgents(db: Database, actorId: string, orgId: string): Promise<Agent[]> {
  await requirePermission(db, actorId, orgId, "read");
  return db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .orderBy(asc(agents.createdAt));
}

export async function getAgent(db: Database, orgId: string, agentId: string): Promise<Agent | null> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  return agent ?? null;
}

/** Public view of an agent (no credential id, which is admin-only detail). */
export const agentView = (a: Agent) => ({
  id: a.id,
  name: a.name,
  handle: a.handle,
  role: a.role,
  instructions: a.instructions,
  model: a.model,
  ownerUserId: a.ownerUserId,
  hasCredential: a.credentialId !== null,
  monthlyBudgetNanoUsd: a.monthlyBudgetNanoUsd,
  /** Its look (color, eyes, accessory); null = the default. */
  appearance: (a.appearance ?? null) as AgentAppearance | null,
  createdAt: a.createdAt,
});

/** `getAgent` through the per-process cache (run path). */
export function getAgentCached(db: Database, orgId: string, agentId: string): Promise<Agent | null> {
  return caches.agents.getOrLoad(`${orgId}:${agentId}`, () => getAgent(db, orgId, agentId)) as Promise<Agent | null>;
}
