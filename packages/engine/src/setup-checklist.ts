import { and, type Database, eq, isNotNull, isNull, schema, sql } from "@agenteschat/db";
import { caches } from "./cache";
import { NotFoundError } from "./errors";
import { can, requirePermission } from "./organizations";

/*
 * A new agent's setup checklist (ADR 0152 §2): the top of its chat lists what it still needs (an AI, apps, channels,
 * who talks to it, how it works). The apps draw it; this keeps the role it started from (for the suggestions) and the
 * steps a person confirmed. A step is also done when the agent's data says so, which the apps read themselves.
 */

const { agents } = schema;

export const SETUP_STEPS = ["ai", "apps", "where", "who", "how"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export const isSetupStep = (v: unknown): v is SetupStep => SETUP_STEPS.includes(v as SetupStep);

export interface SetupChecklist {
  /** The ready-made role it started from ("support"); null: from scratch, or made some other way. */
  role: string | null;
  /** The steps a person confirmed, in the order they did. */
  done: SetupStep[];
}

/** The role ids the apps offer are short lower-case words; anything else is no role. */
const ROLE_ID = /^[a-z][a-z_-]{0,31}$/;

/** What a new agent's checklist starts with. */
export const newSetup = (role: string | null | undefined): SetupChecklist => ({
  role: role && ROLE_ID.test(role) ? role : null,
  done: [],
});

/** The stored checklist as the apps read it (unknown steps dropped); null for an agent made before it. */
export function setupOf(stored: { role?: unknown; done?: unknown } | null | undefined): SetupChecklist | null {
  if (!stored) return null;
  const role = typeof stored.role === "string" && ROLE_ID.test(stored.role) ? stored.role : null;
  const done = Array.isArray(stored.done) ? stored.done.filter(isSetupStep) : [];
  return { role, done: [...new Set(done)] };
}

/**
 * A person confirmed one step of the agent's checklist (they chose in its dialog, or skipped it). Who may change the
 * agent may: its owner or whoever manages agents. Confirming twice changes nothing; an agent with no checklist keeps
 * none.
 */
export async function confirmSetupStep(db: Database, actorId: string, orgId: string, agentId: string, step: SetupStep) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const [agent] = await db
    .select({ ownerUserId: agents.ownerUserId, builtin: agents.builtin })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId), isNull(agents.deletedAt)));
  // Not found for whoever may not change it, as for an agent that isn't there.
  if (!agent || agent.builtin || (agent.ownerUserId !== actorId && !can(membership, "manage_agents"))) {
    throw new NotFoundError("Agent not found");
  }
  const one = JSON.stringify([step]);
  const done = sql`coalesce(${agents.setup}->'done', '[]'::jsonb)`;
  await db
    .update(agents)
    .set({ setup: sql`jsonb_set(${agents.setup}, '{done}', ${done} || ${one}::jsonb)` })
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.orgId, orgId),
        isNotNull(agents.setup),
        sql`not (${done} @> ${one}::jsonb)`,
      ),
    );
  caches.agents.delete(`${orgId}:${agentId}`);
  caches.agents.delete(`${orgId}:team`);
}
