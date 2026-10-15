import { and, type Database, eq, schema } from "@agenteschat/db";
import { type Agent, getAgent } from "./agents";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { can, requirePermission } from "./organizations";

const { agents } = schema;

/** The looks the app knows how to draw; anything else is refused. */
export const AGENT_LOOK = {
  colors: ["sky", "indigo", "violet", "rose", "amber", "green", "teal", "graphite"],
  eyes: ["round", "dots", "wide", "happy", "sleepy"],
  accessories: ["none", "hat", "cap", "glasses", "sunglasses", "headphones", "bow", "crown"],
} as const;

export interface AgentAppearance {
  color: (typeof AGENT_LOOK.colors)[number];
  eyes: (typeof AGENT_LOOK.eyes)[number];
  accessory: (typeof AGENT_LOOK.accessories)[number];
}

export function validateAppearance(input: { color?: unknown; eyes?: unknown; accessory?: unknown }): AgentAppearance {
  const pick = <T extends string>(value: unknown, allowed: readonly T[], field: string): T => {
    if (typeof value !== "string" || !allowed.includes(value as T)) {
      throw new ValidationError(`appearance.${field} must be one of: ${allowed.join(", ")}`);
    }
    return value as T;
  };
  return {
    color: pick(input.color, AGENT_LOOK.colors, "color"),
    eyes: pick(input.eyes, AGENT_LOOK.eyes, "eyes"),
    accessory: pick(input.accessory ?? "none", AGENT_LOOK.accessories, "accessory"),
  };
}

/**
 * Changes an agent's look (`appearance` on PATCH/POST …/agents). Its owner or
 * an admin; audited. `null` goes back to the default look.
 */
export async function setAgentAppearance(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  appearance: { color?: unknown; eyes?: unknown; accessory?: unknown } | null,
): Promise<Agent> {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  if (!can(membership.role, "manage_agents") && !(agent.ownerUserId && agent.ownerUserId === actorId)) {
    throw new ForbiddenError("Only the agent's owner or an admin can change its look");
  }
  const look = appearance === null ? null : validateAppearance(appearance);
  const [updated] = await db
    .update(agents)
    .set({ appearance: look, updatedAt: new Date() })
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
    .returning();
  if (!updated) throw new NotFoundError("Agent not found");
  caches.agents.delete(`${orgId}:${agentId}`);
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "agent.appearance_changed",
    target: { type: "agent", id: agentId },
    details: { from: agent.appearance, to: look },
  });
  return updated;
}
