import { and, type Database, type Executor, eq, isNull, type SQL, schema, sql } from "@agenteschat/db";
import { AUTO_MODEL } from "@agenteschat/providers";
import { ForbiddenError } from "./errors";

const { agents, agentBudgetPeriods, organizationMembers, organizations, users } = schema;

/**
 * The team's right hand (ADR 0134): one built-in agent per workspace that sets the team up and changes it, through
 * cards applied by whoever clicks, with the permissions of the person talking to it. Its row is an ordinary agent
 * (`agents.builtin`), so DMs, runs, the gateway's budget and accounting work as for any agent.
 */
export const RIGHT_HAND = "right_hand" as const;

export const isRightHand = (a: { builtin?: string | null } | null | undefined) => a?.builtin === RIGHT_HAND;

/** What it starts with. The name is the same in every language; admins may rename it and change its look. */
export const RIGHT_HAND_DEFAULTS = {
  name: "Lodi",
  handle: "lodi",
  model: AUTO_MODEL,
  appearance: { color: "teal", eyes: "happy", accessory: "headset" },
} as const;

/** What "Automático" reads of it (`chooseAutoModel`): small work first, so it starts on the cheap tier. */
export const RIGHT_HAND_AUTO = {
  role: "Workspace assistant",
  instructions:
    "Sets the team up with people: short questions and cards (a new agent, a setting, an app, an invite). Small work: the smallest tier and low effort, unless the person asks for something long or complex.",
} as const;

/**
 * Its tools, fixed in code whatever its grant rows say (`loadScopeKeys`): the setup cards, reading context, routines
 * for any agent, and `propose_instruction_change` (under `memory:write`, whose memory tools are denied: its runs keep
 * no memory, so nothing one person tells it reaches another). No apps, web, computer, databases, files or mail, so it
 * can't be used to reach data; nor posting elsewhere, putting agents in channels without a card, or long work.
 */
export const RIGHT_HAND_GRANTS: readonly string[] = [
  "setup:write",
  "context:read",
  "schedule:write",
  "memory:write",
  ...[
    "remember",
    "update_memory",
    "forget",
    "save_how_to",
    "web_search",
    "web_fetch",
    "post_message",
    "send_dm",
    "add_agent_to_channel",
    "work_in_background",
    "post_update",
    "steer_work",
    "stop_work",
  ].map((name) => `deny:${name}`),
];

/**
 * Its owner (the person accountable for it) is the workspace's longest-standing owner who can still sign in: set
 * again whenever the one it has is no longer an owner (a role change, leaving, an account deleted).
 */
export async function followOwner(db: Executor, orgId: string) {
  await db.execute(sql`update ${agents} a set owner_user_id = (
      select om.user_id from ${organizationMembers} om join ${users} u on u.id = om.user_id
      where om.org_id = ${orgId}::uuid and om.role = 'owner'
      order by u.blocked_at is not null, om.created_at limit 1)
    where a.org_id = ${orgId}::uuid and a.builtin = ${RIGHT_HAND}
      and not exists (select 1 from ${organizationMembers} om join ${users} u on u.id = om.user_id
        where om.org_id = a.org_id and om.user_id = a.owner_user_id and om.role = 'owner' and u.blocked_at is null)`);
}

/**
 * Gives the workspace its right hand unless it has one (idempotent: the partial unique index decides between two at
 * once). The handle is `lodi`, or the first free one after it. Its budget is the workspace's default. No audit row: it
 * comes with the workspace, as the workspace itself does.
 */
export async function ensureRightHand(db: Executor, orgId: string): Promise<string | null> {
  const [had] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.builtin, RIGHT_HAND)));
  if (had) return null;
  const { freeHandle, takenHandles } = await import("./agents");
  const taken = await takenHandles(db, orgId);
  const handle = taken.has(RIGHT_HAND_DEFAULTS.handle)
    ? freeHandle(RIGHT_HAND_DEFAULTS.handle, taken)
    : RIGHT_HAND_DEFAULTS.handle;
  const [made] = await db
    .insert(agents)
    .values({
      orgId,
      builtin: RIGHT_HAND,
      name: RIGHT_HAND_DEFAULTS.name,
      handle,
      model: RIGHT_HAND_DEFAULTS.model,
      brainModel: AUTO_MODEL,
      brainEffort: AUTO_MODEL,
      appearance: { ...RIGHT_HAND_DEFAULTS.appearance },
    })
    .onConflictDoNothing()
    .returning({ id: agents.id });
  if (!made) return null;
  await followOwner(db, orgId);
  await db
    .insert(agentBudgetPeriods)
    // The month's counter exists from the start, as for any new agent (`resyncBudgetCounter`): nothing spent yet.
    .values({ orgId, agentId: made.id, periodStart: sql`date_trunc('month', now() at time zone 'utc')::date` })
    .onConflictDoNothing();
  return made.id;
}

/**
 * Every workspace without a right hand gets one (boot): one query finds none once they all have it. Not one being
 * deleted, which nobody uses again.
 */
export async function ensureRightHands(db: Database, batch = 200): Promise<number> {
  let made = 0;
  for (;;) {
    const rows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          isNull(organizations.deletionDueAt),
          sql`not exists (select 1 from ${agents} a where a.org_id = ${organizations.id} and a.builtin = ${RIGHT_HAND})`,
        ),
      )
      .limit(batch);
    for (const org of rows) if (await db.transaction((tx) => ensureRightHand(tx, org.id))) made++;
    if (rows.length < batch) return made;
  }
}

/** 403 `agent.right_hand_permanent`: it is part of the workspace, as its Settings say. */
export const rightHandPermanent = (what: string) =>
  new ForbiddenError(`The team's right hand can't be ${what}`, "agent.right_hand_permanent");

/** What admins may change on it (ADR 0134): its name and handle, AI and model, budget. Look and audience have their own calls. */
export const RIGHT_HAND_EDITABLE: ReadonlySet<string> = new Set([
  "name",
  "handle",
  "model",
  "credentialId",
  "monthlyBudgetNanoUsd",
]);

/** Refuses `what` for the right hand: archived, deleted. */
export async function refuseRightHand(db: Executor, orgId: string, agentId: string, what: string) {
  const [row] = await db
    .select({ builtin: agents.builtin })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
  if (isRightHand(row)) throw rightHandPermanent(what);
}

/**
 * The right hand is in no channel: an @mention in any channel reaches it all the same (ADR 0134), never a DM between
 * people. Read wherever a run needs the agent in the conversation (the mention lookups, `eligibleChannelAgents`).
 */
export const rightHandReaches = (agent: SQL, channelId: SQL) =>
  sql`(${agent}.builtin = ${RIGHT_HAND} and exists (select 1 from ${schema.channels} rhc
    where rhc.id = ${channelId} and rhc.kind = 'channel' and rhc.archived_at is null and rhc.deleted_at is null))`;
