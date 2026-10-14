import { and, asc, type Database, eq, isNull, schema } from "@agenteschat/db";
import { isKnownModel, MODEL_CATALOG } from "@agenteschat/providers";
import { ConflictError, isUniqueViolation, NotFoundError, ValidationError } from "./errors";
import { getMembership, requirePermission } from "./organizations";

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
  if (input.model !== undefined && !isKnownModel(input.model)) {
    throw new ValidationError(`model must be one of: ${Object.keys(MODEL_CATALOG).join(", ")}`);
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
  }
  if (input.ownerUserId && !(await getMembership(db, input.ownerUserId, orgId))) {
    throw new ValidationError("ownerUserId must be a member of this organization");
  }
}

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
  try {
    const [agent] = await db
      .insert(agents)
      .values({ ...values, orgId, ownerUserId: input.ownerUserId === undefined ? actorId : input.ownerUserId })
      .returning();
    if (!agent) throw new Error("agent insert returned nothing");
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
  return agent;
}

export async function archiveAgent(db: Database, actorId: string, orgId: string, agentId: string) {
  await requirePermission(db, actorId, orgId, "manage_agents");
  await db
    .update(agents)
    .set({ archivedAt: new Date() })
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
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
  createdAt: a.createdAt,
});
