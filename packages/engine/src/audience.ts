import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, type SQL, schema, sql } from "@agenteschat/db";
import { type Agent, getAgent } from "./agents";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishUserEvent } from "./events";
import { can, requirePermission } from "./organizations";

const { agents, users, organizationMembers } = schema;

/** Who can talk to an agent (D31). */
export type AudienceMode = "everyone" | "people" | "owner";
export const AUDIENCE_MODES: readonly AudienceMode[] = ["everyone", "people", "owner"];

export interface AgentAudience {
  mode: AudienceMode;
  /** For `people`; the owner can always talk to the agent. */
  userIds: string[];
}

type AudienceFields = Pick<Agent, "audienceMode" | "audienceUserIds" | "ownerUserId">;

export const audienceOf = (a: AudienceFields): AgentAudience => ({
  mode: a.audienceMode,
  userIds: a.audienceMode === "people" ? a.audienceUserIds : [],
});

/** Can this person's message start a run of the agent? (`null` = no person: routines and webhooks check their creator.) */
export function canTalkTo(a: AudienceFields, userId: string | null): boolean {
  if (a.audienceMode === "everyone") return true;
  if (!userId) return false;
  if (a.ownerUserId === userId) return true;
  return a.audienceMode === "people" && a.audienceUserIds.includes(userId);
}

/** The same rule in SQL, for an `agents` row aliased `alias` and a person id expression. */
export function audienceSql(alias: string, userId: SQL): SQL {
  const a = sql.raw(alias);
  return sql`(${a}.audience_mode = 'everyone' or (${userId} is not null and (${a}.owner_user_id = ${userId}
    or (${a}.audience_mode = 'people' and ${userId} = any(${a}.audience_user_ids)))))`;
}

/** Who the agent answers, as a stable code and params (the app says it in the person's language). */
export async function audienceDetail(db: Database, a: Agent) {
  const ids = [
    ...new Set([...(a.ownerUserId ? [a.ownerUserId] : []), ...(a.audienceMode === "people" ? a.audienceUserIds : [])]),
  ];
  const rows = ids.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))
    : [];
  const people = ids.flatMap((id) => {
    const name = rows.find((r) => r.id === id)?.name;
    return name ? [{ id, name }] : [];
  });
  const code = people.length === 0 ? "audience.nobody" : "audience.only";
  const params = {
    agentId: a.id,
    agentName: a.name,
    userIds: people.map((p) => p.id),
    names: people.map((p) => p.name),
  };
  const english =
    people.length === 0
      ? `${a.name} isn't answering anyone right now`
      : `${a.name} only answers ${people.map((p) => p.name).join(", ")}`;
  return { code, params, english };
}

/** The ForbiddenError for someone the agent doesn't answer (D31), with code and params. */
export async function audienceError(db: Database, a: Agent) {
  const d = await audienceDetail(db, a);
  return new ForbiddenError(d.english, d.code, d.params);
}

/** "Theo only replies to Walter and Ana." (English text for agents' context and old clients; the app uses `audienceDetail`). */
export async function audienceNotice(db: Database, a: Agent): Promise<string> {
  const ids = [
    ...new Set([...(a.ownerUserId ? [a.ownerUserId] : []), ...(a.audienceMode === "people" ? a.audienceUserIds : [])]),
  ];
  const rows = ids.length
    ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))
    : [];
  const names = ids.map((id) => rows.find((r) => r.id === id)?.name).filter((n): n is string => Boolean(n));
  if (names.length === 0) return `${a.name} isn't replying to anyone right now.`;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${a.name} only replies to ${list}.`;
}

/**
 * Tells only that person that the agent won't answer them (ephemeral: their
 * own topic, never stored as a message).
 */
export async function notifyBlocked(
  deps: { db: Database; pubsub: PubSub },
  orgId: string,
  userId: string,
  input: { agentIds: string[]; channelId: string; threadId: string | null; messageId: string },
) {
  const out: { agentId: string; text: string; code: string; params: Record<string, unknown> }[] = [];
  for (const agentId of input.agentIds) {
    const agent = await getAgent(deps.db, orgId, agentId);
    if (!agent) continue;
    const text = await audienceNotice(deps.db, agent);
    const detail = await audienceDetail(deps.db, agent);
    out.push({ agentId, text, code: detail.code, params: detail.params });
    await publishUserEvent(deps.pubsub, orgId, userId, {
      type: "agent.unavailable",
      agentId,
      channelId: input.channelId,
      threadId: input.threadId,
      messageId: input.messageId,
      text,
      code: detail.code,
      params: detail.params,
    });
  }
  return out;
}

/** Changes who can talk to the agent: its owner or admins (with no owner, admins only). Audited. */
export async function setAgentAudience(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  audience: AgentAudience,
): Promise<Agent> {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  if (!can(membership.role, "manage_agents") && !(agent.ownerUserId && agent.ownerUserId === actorId)) {
    throw new ForbiddenError("Only the agent's owner or an admin can change who talks to it");
  }
  if (!AUDIENCE_MODES.includes(audience.mode)) throw new ValidationError("Unknown audience mode");
  let userIds = audience.mode === "people" ? [...new Set(audience.userIds)] : [];
  if (userIds.length > 500) throw new ValidationError("At most 500 people");
  if (userIds.length > 0) {
    const members = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), inArray(organizationMembers.userId, userIds)));
    const known = new Set(members.map((m) => m.userId));
    if (userIds.some((id) => !known.has(id))) throw new ValidationError("Everyone in the list must be a member");
    userIds = userIds.filter((id) => known.has(id));
  }
  if (audience.mode === "people" && userIds.length === 0 && !agent.ownerUserId) {
    throw new ValidationError("Pick at least one person");
  }
  const [updated] = await db
    .update(agents)
    .set({ audienceMode: audience.mode, audienceUserIds: userIds, updatedAt: new Date() })
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
    .returning();
  if (!updated) throw new NotFoundError("Agent not found");
  caches.agents.delete(`${orgId}:${agentId}`);
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "agent.audience_changed",
    target: { type: "agent", id: agentId },
    details: { from: audienceOf(agent), to: audienceOf(updated) },
  });
  return updated;
}
