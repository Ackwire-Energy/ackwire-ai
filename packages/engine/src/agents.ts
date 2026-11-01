import type { PubSub } from "@agenteschat/adapters";
import {
  and,
  arrayContains,
  asc,
  type Database,
  type Executor,
  eq,
  inArray,
  isNotNull,
  isNull,
  rowsOf,
  schema,
  sql,
} from "@agenteschat/db";
import { AUTO_MODEL, isAutoModel, MODEL_CATALOG } from "@agenteschat/providers";
import { isIdHandle } from "@agenteschat/ui/names";
import type { AgentAppearance } from "./appearance";
import { recordAudit } from "./audit";
import { isComputerBrain } from "./brains/types";
import { caches } from "./cache";
import { modelInfoFor } from "./credentials";
import { ConflictError, ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import type { CommandApproval } from "./missions";
import { recordOperatorEvent } from "./operator-events";
import { can, getMembership, type Membership, requirePermission } from "./organizations";
import { DEFAULT_AGENT_SCOPES, grantScopes } from "./tools/scopes";
import { resyncBudgetCounter } from "./usage";
import { resumeBudgetWaits } from "./usage-pause";

const { agents, importItems, machines, organizationMembers, providerCredentials } = schema;

export type Agent = typeof agents.$inferSelect;

export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,31}$/;

/** Every handle an agent can't take: the other agents' (archived and deleted ones too), the ones they had, people's. */
export async function takenHandles(db: Executor, orgId: string, exceptAgentId?: string): Promise<Set<string>> {
  const [bots, people] = await Promise.all([
    db
      .select({ id: agents.id, handle: agents.handle, previous: agents.previousHandles })
      .from(agents)
      .where(eq(agents.orgId, orgId)),
    db
      .select({ handle: organizationMembers.handle })
      .from(organizationMembers)
      .where(eq(organizationMembers.orgId, orgId)),
  ]);
  return new Set([
    ...bots.flatMap((b) => (b.id === exceptAgentId ? [] : [b.handle, ...b.previous])),
    ...people.flatMap((p) => (p.handle ? [p.handle] : [])),
  ]);
}

/** `base` with the first free number after a dash (`scout` → `scout-2`) in 32 characters, as the apps suggest. */
export function freeHandle(base: string, taken: Set<string>) {
  for (let n = 2; ; n++) {
    const handle = `${base.slice(0, 31 - String(n).length).replace(/[-_]+$/, "")}-${n}`;
    if (!taken.has(handle)) return handle;
  }
}

/** "@ada is taken", with the first free one (`ada-2`) for the apps to offer. */
const handleTaken = (handle: string, taken: Set<string>) => {
  const suggestion = freeHandle(handle, taken);
  return new ConflictError(`@${handle} is already taken. How about @${suggestion}?`, "agent.handle_taken", {
    handle,
    suggestion,
  });
};

export interface AgentInput {
  name: string;
  handle: string;
  role?: string;
  instructions?: string;
  model?: string;
  credentialId?: string | null;
  ownerUserId?: string | null;
  monthlyBudgetNanoUsd?: number | null;
  /** It may follow a light reply with a sticker or a GIF (ADR 0091), as often as the workspace allows. */
  mediaReplies?: boolean;
}

/** An agent's fields as the API takes them: its handle, model, key (of the model's provider), budget and owner. */
export async function validateAgentFields(db: Database, orgId: string, input: Partial<AgentInput>) {
  if (input.handle !== undefined && !HANDLE_PATTERN.test(input.handle)) {
    throw new ValidationError("handle must be 2–32 characters: lower-case letters, digits, - or _");
  }
  // An id-shaped handle is how mentions written before migration 0132 still name an imported agent (`currentHandles`).
  if (input.handle !== undefined && isIdHandle(input.handle)) {
    throw new ValidationError("handle can't look like an id. Pick one from the agent's name");
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

/**
 * An agent's "Quem pensa" and its Autonomia as new agents take them (ADR 0094). Who it answers stays out: a new agent
 * on a plan answers only its owner (ADR 0059 §5).
 */
export function setupOfAgent(a: Agent): schema.AgentSetup {
  const autonomy = a.missionCommandApproval;
  if (!isComputerBrain(a.brain)) {
    return { brain: "model", model: a.model, key: a.credentialId, contextTokens: a.contextTokens, autonomy };
  }
  return {
    brain: a.brain,
    model: a.brainModel,
    machineId: a.machineId,
    account: a.brainAccountId,
    effort: a.brainEffort,
    contextTokens: a.contextTokens,
    fallback: a.brainFallback,
    autonomy,
  };
}

/**
 * What the workspace's new agents start with from now on: the "Quem pensa" someone just saved or used on others.
 * Only whoever creates agents sets it (they start from it), and one on the API only an admin: only admins change an
 * agent's API model and key.
 */
export async function rememberAgentSetup(db: Executor, membership: Membership, setup: schema.AgentSetup) {
  if (!can(membership, "create_agents") || (setup.brain === "model" && !can(membership, "manage_agents"))) return;
  await db
    .insert(schema.organizationSettings)
    .values({ orgId: membership.orgId, agentSetup: setup })
    .onConflictDoUpdate({
      target: schema.organizationSettings.orgId,
      set: { agentSetup: setup, updatedAt: new Date() },
    });
}

export async function createAgent(
  db: Database,
  actorId: string,
  orgId: string,
  input: AgentInput & { autonomy?: CommandApproval; audienceMode?: Agent["audienceMode"] },
  defaults: { model: string },
  options: { remember?: boolean } = {},
): Promise<Agent> {
  const membership = await requirePermission(db, actorId, orgId, "create_agents");
  const { autonomy, audienceMode, ...fields } = input;
  // `create_agents` makes the creator's own agent (ADR 0085 §5): another owner, or none, is for who edits any agent.
  // So whoever gets this far may also set its Autonomia (ADR 0094): an admin or the new agent's owner.
  if (input.ownerUserId !== undefined && input.ownerUserId !== actorId && !can(membership, "manage_agents")) {
    throw new ForbiddenError("Only an admin can create an agent for someone else or with no owner");
  }
  const values = { ...fields, handle: fields.handle.toLowerCase(), model: fields.model ?? defaults.model };
  await validateAgentFields(db, orgId, values);
  const ownerUserId = input.ownerUserId === undefined ? actorId : input.ownerUserId;
  // Another agent's old handle still names that agent.
  const [held] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), arrayContains(agents.previousHandles, [values.handle])));
  if (held) throw handleTaken(values.handle, await takenHandles(db, orgId));
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
        ownerUserId,
        ...(autonomy ? { missionCommandApproval: autonomy } : {}),
        ...(audienceMode ? { audienceMode } : {}),
      })
      .returning();
    if (!agent) throw new Error("agent insert returned nothing");
    // The first agent of a team coordinates it (ADR 0093): no active agent is older, so of two first agents made at
    // once only the older claims it. In a savepoint: with the same time both try, and the unique index turns the
    // second claim down without failing its creation.
    const [first] = await db
      .transaction((tx) =>
        tx
          .update(agents)
          .set({ coordinator: true })
          .where(
            and(
              eq(agents.id, agent.id),
              sql`not exists (select 1 from agents a where a.org_id = agents.org_id and a.id <> agents.id and a.archived_at is null and a.created_at < agents.created_at)`,
            ),
          )
          .returning(),
      )
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) return [];
        throw error;
      });
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
      details: {
        name: agent.name,
        handle: agent.handle,
        model: agent.model,
        ...(first ? { coordinator: true } : {}),
        ...(autonomy ? { autonomy } : {}),
      },
    });
    // A model or key the creator picked is their latest choice; "Automático" with the default key is no choice.
    if (options.remember && (!isAutoModel(agent.model) || agent.credentialId)) {
      await rememberAgentSetup(db, membership, setupOfAgent(agent));
    }
    return first ?? agent;
  } catch (error) {
    if (isUniqueViolation(error)) throw handleTaken(values.handle, await takenHandles(db, orgId));
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
  patch: Partial<AgentInput>,
  options: { remember?: boolean } = {},
): Promise<Agent> {
  const membership = await requirePermission(db, actorId, orgId, "manage_agents");
  const input =
    patch.handle === undefined ? patch : { ...patch, handle: patch.handle.trim().replace(/^@/, "").toLowerCase() };
  await validateAgentFields(db, orgId, input);
  const handle = input.handle;
  if (handle !== undefined) {
    const taken = await takenHandles(db, orgId, agentId);
    if (taken.has(handle)) throw handleTaken(handle, taken);
  }
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
  // The handle it leaves joins the ones it had, so what names it there still reaches it; taking one back takes it out.
  const previous =
    handle === undefined
      ? {}
      : {
          previousHandles: sql`case when ${agents.handle} = ${handle} then ${agents.previousHandles}
            else array_append(array_remove(${agents.previousHandles}, ${handle}::text), ${agents.handle}) end`,
        };
  let agent: Agent | undefined;
  try {
    [agent] = await db
      .update(agents)
      .set({ ...input, ...handover, ...previous, updatedAt: new Date() })
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.deletedAt)))
      .returning();
  } catch (error) {
    if (handle !== undefined && isUniqueViolation(error))
      throw handleTaken(handle, await takenHandles(db, orgId, agentId));
    throw error;
  }
  if (!agent) throw new NotFoundError("Agent not found");
  caches.agents.delete(`${orgId}:${agentId}`);
  caches.agents.delete(`${orgId}:team`);
  if (input.name !== undefined || handle !== undefined) {
    // What other runs read of it (who is in a channel, archived and old handles) names it as it is now.
    caches.agents.delete(`${orgId}:archived`);
    caches.agents.delete(`${orgId}:old-handles`);
    caches.channelMembers.deletePrefix(`${orgId}:`);
  }
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
  if (input.monthlyBudgetNanoUsd !== undefined) {
    await resyncBudgetCounter(db, orgId, agentId);
    // Its runs that wait for the budget look again now: one that still doesn't fit parks again quietly.
    await resumeBudgetWaits(db, orgId, agentId);
  }
  // Its API model or key is "Quem pensa" only while it thinks through the API.
  const thinking = input.model !== undefined || input.credentialId !== undefined;
  if (thinking && options.remember !== false && !isComputerBrain(agent.brain)) {
    await rememberAgentSetup(db, membership, setupOfAgent(agent));
  }
  return agent;
}

export async function archiveAgent(db: Database, actorId: string, orgId: string, agentId: string) {
  await requirePermission(db, actorId, orgId, "manage_agents");
  const [gone] = await db
    .update(agents)
    // An archived agent coordinates nothing: the team has no coordinator until someone picks one (ADR 0093).
    .set({ archivedAt: new Date(), coordinator: false })
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
  caches.agents.delete(`${orgId}:old-handles`);
  // Its channel memberships stay: what runs read of a channel's members leaves it out from now on.
  caches.channelMembers.deletePrefix(`${orgId}:`);
}

/**
 * Picks the agent that coordinates the team, or (`on` false) leaves the team with none (ADR 0093). Owners and admins.
 * Turning it on takes it from whoever had it in the same transaction, under a lock per workspace, so of two saves at
 * once the last one wins. Audited, and every open app of the workspace reads its agents again (`agent.coordinator`).
 */
export async function setCoordinator(
  deps: { db: Database; pubsub?: PubSub },
  actorId: string,
  orgId: string,
  agentId: string,
  on: boolean,
): Promise<Agent> {
  const { db } = deps;
  await requirePermission(db, actorId, orgId, "manage_agents");
  const done = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`coordinator:${orgId}`}))`);
    const [agent] = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.archivedAt)));
    if (!agent) throw new NotFoundError("Agent not found");
    if (agent.coordinator === on) return { agent, changed: false, from: null };
    const cleared = on
      ? await tx
          .update(agents)
          .set({ coordinator: false })
          .where(and(eq(agents.orgId, orgId), eq(agents.coordinator, true)))
          .returning({ id: agents.id })
      : [];
    const [next] = await tx
      .update(agents)
      .set({ coordinator: on, updatedAt: new Date() })
      .where(eq(agents.id, agent.id))
      .returning();
    return { agent: next ?? agent, changed: true, from: cleared[0]?.id ?? null };
  });
  if (!done.changed) return done.agent;
  caches.agents.deletePrefix(`${orgId}:`);
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "agent.coordinator",
    target: { type: "agent", id: agentId },
    details: { name: done.agent.name, on, ...(done.from ? { from: done.from } : {}) },
  });
  await publishOrgEvent(deps.pubsub, { type: "org.broadcast", orgId, event: { type: "agent.coordinator" } });
  return done.agent;
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
  /** It may follow a light reply with a sticker or a GIF (ADR 0091). */
  mediaReplies: a.mediaReplies,
  coordinator: a.coordinator,
  createdAt: a.createdAt,
});

/** A handle as a tool's input names it ("@Ada ") → as stored ("ada"). */
export const handleOf = (raw: unknown) => String(raw).replace(/^@/, "").trim().toLowerCase();

/**
 * `handles` with the import ids they were written as read as their agents' handles now. An import gave an agent the other app's id
 * cut to 32 characters (`agent-e9665a97-c8d5-423f-ae59-25`, OpenBot.run's) until migration 0132 named it, and
 * routines, memory and messages written before still cite it: that handle is read again from the import's key
 * (`import_items.key`), never stored, and names the agent while no agent here has it as its own.
 */
async function importedHandles(db: Executor, orgId: string, handles: string[]): Promise<string[]> {
  const old = handles.filter((h) => HANDLE_PATTERN.test(h) && isIdHandle(h));
  if (old.length === 0) return handles;
  const key = sql<string>`left(lower(${importItems.key}), 32)`;
  const rows = await db
    .selectDistinctOn([key], { old: key, handle: agents.handle })
    .from(importItems)
    .innerJoin(agents, and(eq(agents.id, importItems.targetId), eq(agents.orgId, importItems.orgId)))
    .where(
      and(
        eq(importItems.orgId, orgId),
        eq(importItems.kind, "agent"),
        isNull(agents.archivedAt),
        inArray(key, old),
        sql`not exists (select 1 from ${agents} held where held.org_id = ${orgId}::uuid and held.handle = ${key})`,
      ),
    )
    // Two people who imported the same file: the first import held the handle (the second got a suffix).
    .orderBy(key, asc(importItems.createdAt));
  const now = new Map(rows.map((r) => [r.old, r.handle]));
  return handles.map((h) => now.get(h) ?? h);
}

type Named = { id: string; handle: string };

/**
 * Every handle that names an agent besides its own, with that agent and its handle now: the ones it had before a
 * rename (`previous_handles`), not an archived agent's, and not one an agent or a person has as their own (that @ is
 * theirs). The one place an old handle is read as an agent's: `currentHandles` maps by it, and the agent list gives
 * the apps each agent's (`oldHandlesByAgent`) for the mentions in old messages. Per process: a rename or an archive
 * here drops it, another replica's within the cache's TTL.
 */
function loadOldHandles(db: Executor, orgId: string): Promise<Map<string, Named>> {
  return caches.agents.getOrLoad(`${orgId}:old-handles`, async () => {
    const rows = rowsOf<Named & { old: string }>(
      await db.execute(sql`select distinct on (u.old) u.old, ag.id, ag.handle
        from ${agents} ag cross join unnest(ag.previous_handles) as u(old)
        where ag.org_id = ${orgId}::uuid and ag.archived_at is null
          and not exists (select 1 from ${agents} held where held.org_id = ${orgId}::uuid and held.handle = u.old)
          and not exists (select 1 from ${organizationMembers} om
            where om.org_id = ${orgId}::uuid and om.handle = u.old)
        order by u.old, ag.created_at`),
    );
    return new Map(rows.map((r) => [r.old, { id: r.id, handle: r.handle }]));
  }) as Promise<Map<string, Named>>;
}

/**
 * `handles` (lower case, without the @) as their agents have them now, in the same order (`loadOldHandles`, then
 * `importedHandles`). What
 * reads a handle someone wrote asks here (a message's mentions, a tool's input, a routine's or a note's text), so an
 * agent renamed from @ada to @claudio still answers to @ada.
 */
export async function currentHandles(db: Executor, orgId: string, handles: string[]): Promise<string[]> {
  if (handles.length === 0) return handles;
  const old = await loadOldHandles(db, orgId);
  return importedHandles(
    db,
    orgId,
    handles.map((h) => old.get(h)?.handle ?? h),
  );
}

/** The old handles that still name each agent (`loadOldHandles`), by its id. */
export async function oldHandlesByAgent(db: Executor, orgId: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const [old, a] of await loadOldHandles(db, orgId)) out.set(a.id, [...(out.get(a.id) ?? []), old]);
  return out;
}

/** `@handles` (a tool's input, old ones too) → the organization's agents that aren't archived; the missing ones by handle. */
export async function agentsByHandle(db: Executor, orgId: string, raw: unknown) {
  const written = (Array.isArray(raw) ? raw : []).map(handleOf);
  const current = await currentHandles(db, orgId, written);
  const handles = [...new Set(current)];
  const rows =
    handles.length === 0
      ? []
      : await db
          .select({ id: agents.id, handle: agents.handle, name: agents.name })
          .from(agents)
          .where(and(eq(agents.orgId, orgId), inArray(agents.handle, handles), isNull(agents.archivedAt)));
  const missing = handles.filter((h) => !rows.some((r) => r.handle === h));
  /** The row a handle as written names, an old one included. */
  const rowOf = (h: unknown) => {
    const now = current[written.indexOf(handleOf(h))] ?? handleOf(h);
    return rows.find((r) => r.handle === now);
  };
  return { handles, rows, missing, rowOf };
}

/** `getAgent` through the per-process cache (run path). */
export function getAgentCached(db: Database, orgId: string, agentId: string): Promise<Agent | null> {
  return caches.agents.getOrLoad(`${orgId}:${agentId}`, () => getAgent(db, orgId, agentId)) as Promise<Agent | null>;
}
