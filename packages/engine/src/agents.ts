import { and, asc, type Database, type Executor, eq, inArray, isNotNull, isNull, schema, sql } from "@agenteschat/db";
import { AUTO_MODEL, isAutoModel, MODEL_CATALOG } from "@agenteschat/providers";
import type { AgentAppearance } from "./appearance";
import { recordAudit } from "./audit";
import { isComputerBrain } from "./brains/types";
import { caches } from "./cache";
import { modelInfoFor } from "./credentials";
import { ConflictError, isUniqueViolation, NotFoundError, ValidationError } from "./errors";
import { recordOperatorEvent } from "./operator-events";
import { getMembership, requirePermission } from "./organizations";
import { DEFAULT_AGENT_SCOPES, grantScopes } from "./tools/scopes";
import { resyncBudgetCounter } from "./usage";

const { agents, machines, providerCredentials } = schema;

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
  const model = input.model && !isAutoModel(input.model) ? await modelInfoFor(db, input.model) : undefined;
  if (input.model !== undefined && !isAutoModel(input.model) && !model) {
    throw new ValidationError(
      `model must be ${AUTO_MODEL}, one of: ${Object.keys(MODEL_CATALOG).join(", ")}, or one OpenRouter lists`,
    );
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
  await requirePermission(db, actorId, orgId, "create_agents");
  const values = { ...input, handle: input.handle.toLowerCase(), model: input.model ?? defaults.model };
  await validate(db, orgId, values);
  // An agent born on "Automático" is automatic on every brain: switched to Claude Code or Codex later, it
  // starts with the model and effort picked per run (written here, so agents made before Automático keep theirs).
  const brainAuto = isAutoModel(values.model) ? { brainModel: AUTO_MODEL, brainEffort: AUTO_MODEL } : {};
  // The workspace's own computer (managed, else the server's own) once it has connected (ADR 0056 §10); one
  // still being prepared gives itself to the agents with none when it is ready.
  const [home] = await db
    .select({ id: machines.id })
    .from(machines)
    .where(
      and(
        eq(machines.orgId, orgId),
        inArray(machines.kind, ["managed", "host"]),
        isNotNull(machines.tokenHash),
        isNull(machines.deletedAt),
      ),
    )
    .orderBy(sql`${machines.kind} = 'managed' desc`, asc(machines.createdAt))
    .limit(1);
  try {
    const [agent] = await db
      .insert(agents)
      .values({
        ...values,
        ...brainAuto,
        machineId: home?.id ?? null,
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
    await recordOperatorEvent(db, { type: "agent.created", orgId, userId: actorId, data: { agentId: agent.id } });
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "agent.created",
      target: { type: "agent", id: agent.id },
      details: { name: agent.name, handle: agent.handle, model: agent.model },
    });
    return agent;
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(`@${values.handle} is already taken`);
    throw error;
  }
}

/** Whose plan the agent's computer brain thinks with: its account's owner, else whoever connected its computer. */
async function planOwner(db: Database, agent: Agent): Promise<string | null> {
  if (!agent.machineId) return null;
  const { machineAccounts, machines } = schema;
  const [row] = agent.brainAccountId
    ? await db
        .select({ owner: machineAccounts.createdBy })
        .from(machineAccounts)
        .where(and(eq(machineAccounts.orgId, agent.orgId), eq(machineAccounts.id, agent.brainAccountId)))
    : await db
        .select({ owner: machines.pairedByUserId })
        .from(machines)
        .where(and(eq(machines.orgId, agent.orgId), eq(machines.id, agent.machineId)));
  return row?.owner ?? null;
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
  const owner = input.ownerUserId;
  const before = owner !== undefined ? await getAgent(db, orgId, agentId) : null;
  // A plan thinks only for its owner's agents (ADR 0059 §3): a new owner who doesn't own it sends the agent back
  // to the API; one who does decides for themselves whether anyone else talks to it.
  const handover =
    before && before.ownerUserId !== owner && isComputerBrain(before.brain)
      ? owner && (await planOwner(db, before)) === owner
        ? { audienceMode: "owner" as const }
        : { brain: "model", brainAccountId: null }
      : {};
  const [agent] = await db
    .update(agents)
    .set({ ...input, ...handover, updatedAt: new Date() })
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.deletedAt)))
    .returning();
  if (!agent) throw new NotFoundError("Agent not found");
  caches.agents.delete(`${orgId}:${agentId}`);
  caches.agents.delete(`${orgId}:team`);
  if (before && "brain" in handover) {
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "agent.brain",
      target: { type: "agent", id: agentId },
      details: {
        from: { brain: before.brain, account: before.brainAccountId },
        to: { brain: "model", account: null },
        reason: "owner_changed",
      },
    });
  }
  // Which fields changed, not the instructions' text (they can be long and say anything); the rest as set.
  const changed = Object.keys(input).filter((k) => input[k as keyof typeof input] !== undefined);
  if (changed.length) {
    const { instructions: _, ...shown } = input;
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "agent.updated",
      target: { type: "agent", id: agentId },
      details: { name: agent.name, changed, ...shown },
    });
  }
  if (input.monthlyBudgetNanoUsd !== undefined) await resyncBudgetCounter(db, orgId, agentId);
  return agent;
}

export async function archiveAgent(db: Database, actorId: string, orgId: string, agentId: string) {
  await requirePermission(db, actorId, orgId, "manage_agents");
  const [gone] = await db
    .update(agents)
    .set({ archivedAt: new Date() })
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .returning({ name: agents.name, handle: agents.handle });
  if (gone) {
    await recordAudit(db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "agent.archived",
      target: { type: "agent", id: agentId },
      details: { name: gone.name, handle: gone.handle },
    });
  }
  caches.agents.delete(`${orgId}:${agentId}`);
  caches.agents.delete(`${orgId}:team`);
  caches.agents.delete(`${orgId}:archived`);
  // Its channel memberships stay: what runs read of a channel's members leaves it out from now on.
  caches.channelMembers.deletePrefix(`${orgId}:`);
}

export async function listAgents(db: Database, actorId: string, orgId: string): Promise<Agent[]> {
  await requirePermission(db, actorId, orgId, "read");
  return db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .orderBy(asc(agents.createdAt));
}

/** An agent, archived or not; null for a deleted one (its tombstone only names what it left, `listFormerAgents`). */
export async function getAgent(db: Database, orgId: string, agentId: string): Promise<Agent | null> {
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.deletedAt)));
  return agent ?? null;
}

/**
 * Agents no longer in the team (archived or deleted) as what they left behind shows them: name, role and look,
 * so their old messages, threads and reports still say who wrote them. Never offered anywhere an agent is picked.
 */
export async function listFormerAgents(db: Database, actorId: string, orgId: string) {
  await requirePermission(db, actorId, orgId, "read");
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      role: agents.role,
      appearance: agents.appearance,
      deletedAt: agents.deletedAt,
    })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNotNull(agents.archivedAt)))
    .orderBy(asc(agents.createdAt));
  return rows.map(({ deletedAt, ...a }) => ({
    ...a,
    appearance: (a.appearance ?? null) as AgentAppearance | null,
    deleted: deletedAt !== null,
  }));
}

/** A deleted agent's handle: longer than `HANDLE_PATTERN` allows, so nobody's and never mentioned. */
export const deletedHandle = (agentId: string) => `deleted-${agentId}`;

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

/** A handle as a tool's input names it ("@Ada ") → as stored ("ada"). */
export const handleOf = (raw: unknown) => String(raw).replace(/^@/, "").trim().toLowerCase();

/** `@handles` (a tool's input) → the organization's agents that aren't archived; the missing ones by handle. */
export async function agentsByHandle(db: Executor, orgId: string, raw: unknown) {
  const handles = [...new Set((Array.isArray(raw) ? raw : []).map(handleOf))];
  const rows =
    handles.length === 0
      ? []
      : await db
          .select({ id: agents.id, handle: agents.handle, name: agents.name })
          .from(agents)
          .where(and(eq(agents.orgId, orgId), inArray(agents.handle, handles), isNull(agents.archivedAt)));
  const missing = handles.filter((h) => !rows.some((r) => r.handle === h));
  return { handles, rows, missing };
}

/** `getAgent` through the per-process cache (run path). */
export function getAgentCached(db: Database, orgId: string, agentId: string): Promise<Agent | null> {
  return caches.agents.getOrLoad(`${orgId}:${agentId}`, () => getAgent(db, orgId, agentId)) as Promise<Agent | null>;
}
