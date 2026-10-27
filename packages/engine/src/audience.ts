import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, eq, inArray, type SQL, schema, sql } from "@agenteschat/db";
import { type Agent, getAgent } from "./agents";
import { recordAudit } from "./audit";
import { isComputerBrain } from "./brains/types";
import { caches } from "./cache";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishUserEvent } from "./events";
import { can, requirePermission } from "./organizations";

const { agents, users, organizationMembers } = schema;

/** Who can talk to an agent. */
export type AudienceMode = "everyone" | "people" | "owner";
export const AUDIENCE_MODES: readonly AudienceMode[] = ["everyone", "people", "owner"];

export interface AgentAudience {
  mode: AudienceMode;
  /**
   * For `people`; the owner can always talk to the agent. Under `owner`, the
   * people a plan kept out (ADR 0059 §5), who come back when it is let out.
   */
  userIds: string[];
}

type AudienceFields = Pick<Agent, "audienceMode" | "audienceUserIds" | "ownerUserId">;
/** What the gate reads: the stored audience and whether the agent thinks with a plan (`personalPlans`). */
type GateFields = AudienceFields & Pick<Agent, "brain">;

export const OWNER_ONLY: AgentAudience = { mode: "owner", userIds: [] };

let personalPlans = false;

/**
 * Where the server provisions the workspaces' computers (`MACHINE_PROVISIONING=external`) it runs the plans'
 * CLIs for its customers, and the providers' terms for such platforms want each person on their own plan: an agent
 * on a plan answers only its owner whatever its stored audience, and nobody widens it. The stored audience holds
 * again once the agent moves to the API. Off on a self-host, whose owner may share a plan after a warning.
 */
export function enablePersonalPlans(on = true) {
  personalPlans = on;
}

/** Only its owner talks to it, whatever is stored: it thinks with a plan where plans are personal. */
const planKeepsItsOwn = (a: Pick<Agent, "brain">) => personalPlans && isComputerBrain(a.brain);

/** Who the agent answers as stored (what a change starts from and what the audit records). */
export const storedAudience = (a: AudienceFields): AgentAudience => ({
  mode: a.audienceMode,
  userIds: a.audienceMode === "everyone" ? [] : a.audienceUserIds,
});

/** Who the agent answers now: its stored audience, or only its owner while a personal plan thinks for it. */
export const audienceOf = (a: GateFields): AgentAudience => (planKeepsItsOwn(a) ? OWNER_ONLY : storedAudience(a));

/** Whether `to` lets someone talk to the agent whom `from` didn't (its owner always can). */
export function widensAudience(from: AgentAudience, to: AgentAudience, ownerUserId: string | null): boolean {
  if (to.mode === "owner" || from.mode === "everyone") return false;
  if (to.mode === "everyone") return true;
  const before = new Set(from.mode === "people" ? from.userIds : []);
  return to.userIds.some((id) => id !== ownerUserId && !before.has(id));
}

/** Someone besides its owner can talk to the agent. */
export const answersOthers = (a: AgentAudience, ownerUserId: string | null) =>
  widensAudience(OWNER_ONLY, a, ownerUserId);

/** Where plans are personal (`enablePersonalPlans`), nobody lets other people talk to an agent on one. */
export function refusePersonalPlan(agent: Pick<Agent, "name" | "brain">) {
  if (!planKeepsItsOwn(agent)) return;
  throw new ForbiddenError(
    `A plan is personal: only its owner talks to ${agent.name} while it thinks with one`,
    "plan.personal",
    { agentName: agent.name },
  );
}

/**
 * More people for an agent that thinks with a personal plan (ADR 0059 §5):
 * only the plan's owner, who is the agent's owner, lets them in; admins only
 * narrow. The first time anyone else may talk to it, the owner accepts that
 * answering other people on a personal plan might go against the provider's
 * terms. True when this change is that acceptance (the caller audits it).
 * Where plans are personal, nobody does (`refusePersonalPlan`).
 */
export function planSharing(
  agent: Pick<Agent, "name" | "brain" | "ownerUserId">,
  actorId: string,
  from: AgentAudience,
  to: AgentAudience,
  acceptPlanTerms: boolean,
): boolean {
  if (!isComputerBrain(agent.brain) || !widensAudience(from, to, agent.ownerUserId)) return false;
  refusePersonalPlan(agent);
  if (!agent.ownerUserId || agent.ownerUserId !== actorId) {
    throw new ForbiddenError(
      `Only ${agent.name}'s owner can let more people talk to it: it thinks with their plan`,
      "audience.plan_owner_only",
      { agentName: agent.name },
    );
  }
  if (answersOthers(from, agent.ownerUserId)) return false;
  if (!acceptPlanTerms) {
    throw new ValidationError(
      "Letting other people talk to an agent on your personal plan needs your confirmation",
      "audience.plan_terms_required",
      { brain: agent.brain },
    );
  }
  return true;
}

/** Can this person's message start a run of the agent? (`null` = no person: routines and webhooks check their creator.) */
export function canTalkTo(a: GateFields, userId: string | null): boolean {
  const mode = planKeepsItsOwn(a) ? "owner" : a.audienceMode;
  if (mode === "everyone") return true;
  if (!userId) return false;
  if (a.ownerUserId === userId) return true;
  return mode === "people" && a.audienceUserIds.includes(userId);
}

/** The same rule in SQL, for an `agents` row aliased `alias` and a person id expression. */
export function audienceSql(alias: string, userId: SQL): SQL {
  const a = sql.raw(alias);
  const stored = sql`(${a}.audience_mode = 'everyone' or (${userId} is not null and (${a}.owner_user_id = ${userId}
    or (${a}.audience_mode = 'people' and ${userId} = any(${a}.audience_user_ids)))))`;
  if (!personalPlans) return stored;
  // `isComputerBrain`'s two brains.
  return sql`(case when ${a}.brain in ('claude_code', 'codex') then coalesce(${a}.owner_user_id = ${userId}, false)
    else ${stored} end)`;
}

/** The people it answers by name: its owner, then the people of its audience now. */
function answeredIds(a: Agent) {
  const now = audienceOf(a);
  return [...new Set([...(a.ownerUserId ? [a.ownerUserId] : []), ...(now.mode === "people" ? now.userIds : [])])];
}

/** Who the agent answers, as a stable code and params (the app says it in the person's language). */
export async function audienceDetail(db: Database, a: Agent) {
  const ids = answeredIds(a);
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

/** The ForbiddenError for someone the agent doesn't answer, with code and params. */
export async function audienceError(db: Database, a: Agent) {
  const d = await audienceDetail(db, a);
  return new ForbiddenError(d.english, d.code, d.params);
}

/** "Theo only replies to Walter and Ana." (English text for agents' context and old clients; the app uses `audienceDetail`). */
export async function audienceNotice(db: Database, a: Agent): Promise<string> {
  const ids = answeredIds(a);
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

/**
 * Changes who can talk to the agent: its owner or admins (with no owner,
 * admins only); on a personal plan, more people only by its owner
 * (`planSharing`). Audited.
 */
export async function setAgentAudience(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  audience: AgentAudience,
  options: { acceptPlanTerms?: boolean } = {},
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
  const accepted = planSharing(
    agent,
    actorId,
    audienceOf(agent),
    { mode: audience.mode, userIds },
    options.acceptPlanTerms === true,
  );
  const [updated] = await db
    .update(agents)
    .set({ audienceMode: audience.mode, audienceUserIds: userIds, updatedAt: new Date() })
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
    .returning();
  if (!updated) throw new NotFoundError("Agent not found");
  caches.agents.delete(`${orgId}:${agentId}`);
  caches.agents.delete(`${orgId}:team`);
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "agent.audience_changed",
    target: { type: "agent", id: agentId },
    details: {
      from: storedAudience(agent),
      to: storedAudience(updated),
      ...(accepted ? { acceptedPlanTerms: true } : {}),
    },
  });
  return updated;
}
