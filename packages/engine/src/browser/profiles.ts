import { type AgentScope, BROWSER_PROFILE_PROTOCOL, type PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, inArray, isNull, notInArray, schema, sql } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import type { MachineCaller } from "../machine-hub";
import { type NotificationDeps, notify } from "../notifications";
import { can, requireActiveMembership, requirePermission } from "../organizations";
import { BROWSER_HANDOFF_TOPIC, webAddress } from "./handoff";

const { agents, agentRuns, browserProfiles, browserProfileGrants, machines, organizationMembers } = schema;

/** An agent's turn lasts this long after its last command (ADR 0110 §4). */
export const PROFILE_TURN_MS = 2 * 60_000;
/** A command waits this long for another agent's turn to end before it answers `profile_busy`. */
export const PROFILE_WAIT_MS = 60_000;
/** A person's control holds this long without them watching (renewed while they do). */
export const PROFILE_CONTROL_MS = 2 * 60_000;
export const PROFILE_NAME_MAX = 60;

/** The live view's and the runner's key for a profile's session: frames, viewers and Chrome are per profile. */
export const profileKey = (profileId: string) => `profile:${profileId}`;
export const profileIdOfKey = (key: string) => (key.startsWith("profile:") ? key.slice(8) : null);

export type BrowserProfileRow = typeof browserProfiles.$inferSelect;

export interface BrowserProfileView {
  id: string;
  machineId: string;
  name: string;
  createdAt: string;
  agentIds: string[];
  /** Who has the turn now: an agent's run or a person in control; null while free. */
  holder: { type: "agent"; agentId: string; since: string } | { type: "person"; userId: string; since: string } | null;
  lastUsedAt: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Who holds the turn now (a lapsed hold is free). */
export function holderOf(
  p: Pick<BrowserProfileRow, "heldByAgentId" | "heldByUserId" | "heldUntil" | "heldSince">,
  now = Date.now(),
): BrowserProfileView["holder"] {
  if (!p.heldUntil || p.heldUntil.getTime() < now) return null;
  const since = (p.heldSince ?? p.heldUntil).toISOString();
  if (p.heldByUserId) return { type: "person", userId: p.heldByUserId, since };
  if (p.heldByAgentId) return { type: "agent", agentId: p.heldByAgentId, since };
  return null;
}

async function grantsOf(db: Executor, profileIds: string[]) {
  if (profileIds.length === 0) return new Map<string, string[]>();
  const rows = await db
    .select({ profileId: browserProfileGrants.profileId, agentId: browserProfileGrants.agentId })
    .from(browserProfileGrants)
    .where(inArray(browserProfileGrants.profileId, profileIds))
    .orderBy(asc(browserProfileGrants.createdAt));
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.profileId, [...(out.get(r.profileId) ?? []), r.agentId]);
  return out;
}

const viewOf = (p: BrowserProfileRow, agentIds: string[]): BrowserProfileView => ({
  id: p.id,
  machineId: p.machineId,
  name: p.name,
  createdAt: p.createdAt.toISOString(),
  agentIds,
  holder: holderOf(p),
  lastUsedAt: iso(p.lastUsedAt),
});

/** A live profile of the workspace, or null. */
export async function getBrowserProfile(db: Executor, orgId: string, profileId: string) {
  const [row] = await db
    .select()
    .from(browserProfiles)
    .where(and(eq(browserProfiles.id, profileId), eq(browserProfiles.orgId, orgId), isNull(browserProfiles.deletedAt)));
  return row ?? null;
}

async function requireProfile(db: Executor, orgId: string, profileId: string) {
  const row = await getBrowserProfile(db, orgId, profileId);
  if (!row) throw new NotFoundError("Browser profile not found");
  return row;
}

/** The workspace's profiles (names and who may use them, never a page): any member. */
export async function listBrowserProfiles(
  db: Database,
  actorId: string,
  orgId: string,
  filter: { machineId?: string } = {},
): Promise<BrowserProfileView[]> {
  await requirePermission(db, actorId, orgId, "read");
  const rows = await db
    .select()
    .from(browserProfiles)
    .where(
      and(
        eq(browserProfiles.orgId, orgId),
        isNull(browserProfiles.deletedAt),
        filter.machineId ? eq(browserProfiles.machineId, filter.machineId) : undefined,
      ),
    )
    .orderBy(asc(browserProfiles.createdAt));
  const grants = await grantsOf(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => viewOf(r, grants.get(r.id) ?? []));
}

/** One profile as the list shows it. */
export async function browserProfileView(db: Executor, orgId: string, profileId: string) {
  const row = await requireProfile(db, orgId, profileId);
  return viewOf(row, (await grantsOf(db, [row.id])).get(row.id) ?? []);
}

function cleanName(name: string) {
  const n = name.trim().replace(/\s+/g, " ");
  if (!n || n.length > PROFILE_NAME_MAX) throw new ValidationError(`A name has 1 to ${PROFILE_NAME_MAX} characters`);
  return n;
}

/** A name another live profile of the workspace has (ignoring case) is refused before the unique index would. */
async function requireFreeName(db: Executor, orgId: string, name: string, except?: string) {
  const [taken] = await db
    .select({ id: browserProfiles.id })
    .from(browserProfiles)
    .where(
      and(
        eq(browserProfiles.orgId, orgId),
        isNull(browserProfiles.deletedAt),
        sql`lower(${browserProfiles.name}) = lower(${name})`,
        except ? sql`${browserProfiles.id} <> ${except}` : undefined,
      ),
    );
  if (taken) throw new ConflictError("Another browser profile has this name", "browser_profile.name_taken");
}

/**
 * The agents of the workspace this person may give or take a profile from: everyone's with `manage_agents`, else
 * only the agents they own. Unknown ids are refused.
 */
async function requireEditableAgents(
  db: Executor,
  membership: Awaited<ReturnType<typeof requirePermission>>,
  orgId: string,
  actorId: string,
  agentIds: string[],
) {
  if (agentIds.length === 0) return;
  const rows = await db
    .select({ id: agents.id, ownerUserId: agents.ownerUserId })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds)));
  if (rows.length !== new Set(agentIds).size) throw new ValidationError("Unknown agent");
  if (can(membership, "manage_agents")) return;
  if (rows.some((a) => a.ownerUserId !== actorId)) {
    throw new ForbiddenError("You can give profiles only to agents you may edit");
  }
}

/**
 * Whether the computer can hold profiles now: its runner speaks `BROWSER_PROFILE_PROTOCOL` and runs every agent as
 * one OS user. System mode (an OS user per profile) is phase 2: until then such a computer is refused with a clear
 * message. An unknown or older computer (offline since before the protocol) is refused as outdated.
 */
export async function profileMachineProblem(
  db: Executor,
  hub: Pick<MachineCaller, "status"> | undefined,
  orgId: string,
  machineId: string,
): Promise<string | null> {
  const [m] = await db
    .select({ protocol: machines.protocol, executors: machines.executors, deletedAt: machines.deletedAt })
    .from(machines)
    .where(and(eq(machines.id, machineId), eq(machines.orgId, orgId)));
  if (!m || m.deletedAt) return "This computer no longer exists";
  const status = await hub?.status(machineId).catch(() => null);
  const protocol = status?.protocol ?? m.protocol ?? 0;
  const mode = (status?.executors ?? m.executors)?.mode;
  if (mode === "system") {
    return "Browser profiles don't work yet on a computer where each agent runs as its own user (system mode)";
  }
  if (protocol < BROWSER_PROFILE_PROTOCOL) return "Update this computer to use browser profiles";
  return null;
}

export interface ProfileDeps {
  db: Database;
  hub?: MachineCaller;
}

/** Creates a profile on one computer, granted to the chosen agents only (`manage_connectors`). */
export async function createBrowserProfile(
  deps: ProfileDeps,
  actorId: string,
  orgId: string,
  input: { machineId: string; name: string; agentIds?: string[] },
): Promise<BrowserProfileView> {
  const { db } = deps;
  const membership = await requirePermission(db, actorId, orgId, "manage_connectors");
  const name = cleanName(input.name);
  const agentIds = [...new Set(input.agentIds ?? [])];
  await requireEditableAgents(db, membership, orgId, actorId, agentIds);
  const problem = await profileMachineProblem(db, deps.hub, orgId, input.machineId);
  if (problem) throw new ValidationError(problem, "browser_profile.machine");
  return db.transaction(async (tx) => {
    await requireFreeName(tx, orgId, name);
    const [row] = await tx
      .insert(browserProfiles)
      .values({ orgId, machineId: input.machineId, name, createdBy: actorId })
      .returning();
    if (!row) throw new Error("profile not created");
    if (agentIds.length > 0) {
      await tx
        .insert(browserProfileGrants)
        .values(agentIds.map((agentId) => ({ orgId, profileId: row.id, agentId, grantedBy: actorId })));
    }
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "browser_profile.created",
      target: { type: "browser_profile", id: row.id },
      details: { name, machineId: input.machineId, agentIds },
    });
    return viewOf(row, agentIds);
  });
}

export async function renameBrowserProfile(
  db: Database,
  actorId: string,
  orgId: string,
  profileId: string,
  name: string,
) {
  await requirePermission(db, actorId, orgId, "manage_connectors");
  const clean = cleanName(name);
  return db.transaction(async (tx) => {
    const row = await requireProfile(tx, orgId, profileId);
    await requireFreeName(tx, orgId, clean, profileId);
    await tx.update(browserProfiles).set({ name: clean }).where(eq(browserProfiles.id, profileId));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "browser_profile.renamed",
      target: { type: "browser_profile", id: profileId },
      details: { from: row.name, name: clean },
    });
    return browserProfileView(tx, orgId, profileId);
  });
}

/**
 * Agents taken off a profile: their turn ends at once, and a default on it goes back to their own browser. Their
 * unfinished runs that followed that default are pinned to the profile first, so the next command reaches the turn
 * check and is told the access was removed, instead of landing silently in the agent's own browser.
 */
async function dropAgents(tx: Executor, orgId: string, profileId: string, agentIds: string[]) {
  if (agentIds.length === 0) return;
  await tx
    .delete(browserProfileGrants)
    .where(and(eq(browserProfileGrants.profileId, profileId), inArray(browserProfileGrants.agentId, agentIds)));
  await tx
    .update(browserProfiles)
    .set({ heldByRunId: null, heldByAgentId: null, heldUntil: null, heldSince: null })
    .where(and(eq(browserProfiles.id, profileId), inArray(browserProfiles.heldByAgentId, agentIds)));
  await tx
    .update(agentRuns)
    .set({ browserProfileId: profileId })
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        notInArray(agentRuns.status, ["done", "failed", "canceled"]),
        isNull(agentRuns.browserProfileId),
        sql`${agentRuns.browserProfileOwn} is not true`,
        inArray(agentRuns.agentId, agentIds),
        sql`exists (select 1 from ${agents} a where a.id = ${agentRuns.agentId} and a.browser_profile_id = ${profileId})`,
      ),
    );
  await tx
    .update(agents)
    .set({ browserProfileId: null })
    .where(and(eq(agents.orgId, orgId), eq(agents.browserProfileId, profileId), inArray(agents.id, agentIds)));
}

/**
 * "Mudar quem pode usar": the profile's agents become exactly these (`manage_connectors`, and only agents the
 * person may edit are given or taken). An agent's owner may always take their own agents off, never give.
 * One audit row per agent given or taken.
 */
export async function setBrowserProfileAgents(
  db: Database,
  actorId: string,
  orgId: string,
  profileId: string,
  agentIds: string[],
) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const wanted = [...new Set(agentIds)];
  return db.transaction(async (tx) => {
    const row = await requireProfile(tx, orgId, profileId);
    const had = (await grantsOf(tx, [profileId])).get(profileId) ?? [];
    const added = wanted.filter((a) => !had.includes(a));
    const removed = had.filter((a) => !wanted.includes(a));
    if (!can(membership, "manage_connectors")) {
      const owned =
        removed.length === 0
          ? []
          : await tx
              .select({ id: agents.id })
              .from(agents)
              .where(and(eq(agents.orgId, orgId), inArray(agents.id, removed), eq(agents.ownerUserId, actorId)));
      if (added.length > 0 || removed.length === 0 || owned.length !== removed.length) throw new ForbiddenError();
    }
    await requireEditableAgents(tx, membership, orgId, actorId, [...added, ...removed]);
    if (added.length > 0) {
      await tx
        .insert(browserProfileGrants)
        .values(added.map((agentId) => ({ orgId, profileId, agentId, grantedBy: actorId })));
    }
    await dropAgents(tx, orgId, profileId, removed);
    for (const [action, list] of [
      ["browser_profile.granted", added],
      ["browser_profile.revoked", removed],
    ] as const) {
      for (const agentId of list) {
        await recordAudit(tx, {
          orgId,
          actor: { type: "person", id: actorId },
          action,
          target: { type: "browser_profile", id: profileId },
          details: { name: row.name, agentId },
        });
      }
    }
    return browserProfileView(tx, orgId, profileId);
  });
}

/** Grants one agent a profile (an admin approving its `request_permission`). */
export async function grantBrowserProfile(
  db: Executor,
  orgId: string,
  profileId: string,
  agentId: string,
  by: { type: "person" | "agent" | "system"; id: string | null },
) {
  const row = await requireProfile(db, orgId, profileId);
  await db
    .insert(browserProfileGrants)
    .values({ orgId, profileId, agentId, grantedBy: by.type === "person" ? by.id : null })
    .onConflictDoNothing();
  await recordAudit(db, {
    orgId,
    actor: by,
    action: "browser_profile.granted",
    target: { type: "browser_profile", id: profileId },
    details: { name: row.name, agentId },
  });
}

/**
 * Deletes a profile: its grants and agents' defaults on it go, its turn ends, and its computer is told to remove
 * its folder (best effort: an offline runner keeps it until it is deleted there).
 */
export async function deleteBrowserProfile(deps: ProfileDeps, actorId: string, orgId: string, profileId: string) {
  const { db } = deps;
  await requirePermission(db, actorId, orgId, "manage_connectors");
  const row = await db.transaction(async (tx) => {
    const p = await requireProfile(tx, orgId, profileId);
    const had = (await grantsOf(tx, [profileId])).get(profileId) ?? [];
    await dropAgents(tx, orgId, profileId, had);
    await tx
      .update(browserProfiles)
      .set({ deletedAt: new Date(), heldByRunId: null, heldByAgentId: null, heldByUserId: null, heldUntil: null })
      .where(eq(browserProfiles.id, profileId));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "browser_profile.deleted",
      target: { type: "browser_profile", id: profileId },
      details: { name: p.name, agents: had.length },
    });
    return p;
  });
  await deps.hub
    ?.call(row.machineId, { op: "browser.profile.delete", profile: { id: profileId } }, { timeoutMs: 30_000 })
    .catch(() => {});
}

/**
 * An agent's default browser: a profile it is granted, or null for its own. Whoever may edit the agent
 * (`manage_agents` or its owner).
 */
export async function setAgentBrowserProfile(
  db: Database,
  actorId: string,
  orgId: string,
  agentId: string,
  profileId: string | null,
) {
  const membership = await requireActiveMembership(db, actorId, orgId);
  const [agent] = await db
    .select({ ownerUserId: agents.ownerUserId, browserProfileId: agents.browserProfileId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  if (!agent) throw new NotFoundError("Agent not found");
  if (!can(membership, "manage_agents") && agent.ownerUserId !== actorId) {
    throw new ForbiddenError("Only an admin or the agent's owner can choose its browser");
  }
  let name: string | null = null;
  if (profileId) {
    const p = await requireProfile(db, orgId, profileId);
    if (!(await isGranted(db, profileId, agentId))) throw new ValidationError("This agent can't use that profile");
    name = p.name;
  }
  if (agent.browserProfileId === profileId) return;
  await db.update(agents).set({ browserProfileId: profileId }).where(eq(agents.id, agentId));
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "browser_profile.default_set",
    target: { type: "agent", id: agentId },
    details: { profileId, name },
  });
}

export async function isGranted(db: Executor, profileId: string, agentId: string) {
  const [g] = await db
    .select({ agentId: browserProfileGrants.agentId })
    .from(browserProfileGrants)
    .where(and(eq(browserProfileGrants.profileId, profileId), eq(browserProfileGrants.agentId, agentId)));
  return Boolean(g);
}

/** The profiles an agent is granted (live ones), oldest grant first. */
export async function agentBrowserProfiles(db: Executor, orgId: string, agentId: string) {
  return db
    .select({ id: browserProfiles.id, name: browserProfiles.name, machineId: browserProfiles.machineId })
    .from(browserProfileGrants)
    .innerJoin(browserProfiles, eq(browserProfiles.id, browserProfileGrants.profileId))
    .where(
      and(
        eq(browserProfileGrants.orgId, orgId),
        eq(browserProfileGrants.agentId, agentId),
        isNull(browserProfiles.deletedAt),
      ),
    )
    .orderBy(asc(browserProfileGrants.createdAt));
}

/**
 * "Pedir mais um perfil": a person who can't grant asks the people who can (`manage_connectors`) to give the agent
 * a profile. An inbox line for them; nothing changes until one of them grants it.
 */
export async function requestBrowserProfile(deps: NotificationDeps, actorId: string, orgId: string, agentId: string) {
  const membership = await requireActiveMembership(deps.db, actorId, orgId);
  const [agent] = await deps.db
    .select({ name: agents.name, handle: agents.handle, ownerUserId: agents.ownerUserId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  if (!agent) throw new NotFoundError("Agent not found");
  if (!can(membership, "manage_agents") && agent.ownerUserId !== actorId) {
    throw new ForbiddenError("Only an admin or the agent's owner can ask for a profile");
  }
  const members = await deps.db
    .select({ userId: organizationMembers.userId, role: organizationMembers.role })
    .from(organizationMembers)
    .where(eq(organizationMembers.orgId, orgId));
  const deciders: string[] = [];
  for (const m of members) {
    const them = await requireActiveMembership(deps.db, m.userId, orgId).catch(() => null);
    if (them && can(them, "manage_connectors")) deciders.push(m.userId);
  }
  await notify(deps, {
    orgId,
    userIds: deciders,
    kind: "browser_profile_request",
    groupKey: `browser_profile_request:${agentId}`,
    waiting: true,
    actor: { type: "user", id: actorId },
    source: { agentId, label: agent.name || agent.handle },
  });
}

// ── The turn (ADR 0110 §4) ──────────────────────────────────────────────────────

export type TurnResult =
  | {
      ok: true;
      /** The run didn't hold the turn just before: the page is unknown to it (look first). */
      fresh: boolean;
      /** It held a turn of this profile before and another took it since: its command must not run. */
      lost: boolean;
      profile: { id: string; name: string; machineId: string };
    }
  | { ok: false; reason: "busy"; name: string; holder: NonNullable<BrowserProfileView["holder"]> }
  | { ok: false; reason: "revoked" | "deleted"; name: string | null };

/**
 * Takes or renews the turn for a run, in one UPDATE that also checks the grant, with no cache: a revoke made on any
 * replica refuses the very next command. Free means nobody holds it, the hold lapsed, or this run holds it. No row
 * back means busy, revoked or deleted; a second read says which.
 */
export async function takeProfileTurn(
  db: Database,
  at: { orgId: string; profileId: string; agentId: string; runId: string },
  turnMs = PROFILE_TURN_MS,
  retried = false,
): Promise<TurnResult> {
  const { orgId, profileId, agentId, runId } = at;
  const p = browserProfiles;
  const [row] = await db
    .update(p)
    .set({
      heldByRunId: runId,
      heldByAgentId: agentId,
      heldByUserId: null,
      heldUntil: sql`now() + make_interval(secs => ${turnMs / 1000})`,
      heldSince: sql`case when ${p.heldByRunId} = ${runId} then ${p.heldSince} else now() end`,
      lastUsedAt: sql`now()`,
    })
    .where(
      and(
        eq(p.id, profileId),
        eq(p.orgId, orgId),
        isNull(p.deletedAt),
        sql`exists (select 1 from ${browserProfileGrants} g where g.profile_id = ${p.id} and g.agent_id = ${agentId})`,
        sql`(${p.heldUntil} is null or ${p.heldUntil} < now() or ${p.heldByRunId} = ${runId})`,
      ),
    )
    .returning({ name: p.name, machineId: p.machineId, fresh: sql<boolean>`${p.heldSince} = now()` });
  if (row) {
    const [run] = await db
      .update(agentRuns)
      .set({ browserProfileTurnAt: sql`now()` })
      .where(eq(agentRuns.id, runId))
      .returning({
        before: sql<Date | null>`(select r.browser_profile_turn_at from ${agentRuns} r where r.id = ${runId})`,
      });
    const fresh = row.fresh === true;
    return {
      ok: true,
      fresh,
      lost: fresh && Boolean(run?.before),
      profile: { id: profileId, name: row.name, machineId: row.machineId },
    };
  }
  const [read] = await db
    .select({ row: p, live: sql<boolean>`coalesce(${p.heldUntil} >= now(), false)` })
    .from(p)
    .where(and(eq(p.id, profileId), eq(p.orgId, orgId)));
  const now = read?.row;
  if (!now || now.deletedAt) return { ok: false, reason: "deleted", name: now?.name ?? null };
  if (!(await isGranted(db, profileId, agentId))) return { ok: false, reason: "revoked", name: now.name };
  // Lapsed by the database's clock between the two statements: one more try takes it. The app's clock may differ.
  if (!read?.live && !retried) return takeProfileTurn(db, at, turnMs, true);
  const holder = holderOf(now, 0);
  if (!holder) throw new Error("browser profile turn refused with no holder");
  return { ok: false, reason: "busy", name: now.name, holder };
}

/**
 * A person takes control ("Fazer login"): the turn becomes theirs in one statement, from an agent too (its next
 * command waits; one already on the runner finishes first), never from another person. Null when another person has
 * it.
 */
export async function takeProfileControl(
  db: Database,
  orgId: string,
  profileId: string,
  userId: string,
  ms = PROFILE_CONTROL_MS,
) {
  const p = browserProfiles;
  const [row] = await db
    .update(p)
    .set({
      heldByRunId: null,
      heldByAgentId: null,
      heldByUserId: userId,
      heldUntil: sql`now() + make_interval(secs => ${ms / 1000})`,
      heldSince: sql`case when ${p.heldByUserId} = ${userId} and ${p.heldUntil} >= now() then ${p.heldSince} else now() end`,
    })
    .where(
      and(
        eq(p.id, profileId),
        eq(p.orgId, orgId),
        isNull(p.deletedAt),
        sql`(${p.heldByUserId} is null or ${p.heldByUserId} = ${userId} or ${p.heldUntil} is null or ${p.heldUntil} < now())`,
      ),
    )
    .returning();
  return row ?? null;
}

/** The person in control is still there (watching): their hold moves on. False once it isn't theirs. */
export async function touchProfileControl(db: Executor, profileId: string, userId: string, ms = PROFILE_CONTROL_MS) {
  const rows = await db
    .update(browserProfiles)
    .set({ heldUntil: sql`now() + make_interval(secs => ${ms / 1000})` })
    .where(
      and(
        eq(browserProfiles.id, profileId),
        eq(browserProfiles.heldByUserId, userId),
        sql`${browserProfiles.heldUntil} >= now()`,
      ),
    )
    .returning({ id: browserProfiles.id });
  return rows.length > 0;
}

/** Devolver: the person's control ends, and agents may take the turn again. */
export async function releaseProfileControl(db: Executor, orgId: string, profileId: string, userId: string) {
  const rows = await db
    .update(browserProfiles)
    .set({ heldByUserId: null, heldUntil: null, heldSince: null })
    .where(
      and(
        eq(browserProfiles.id, profileId),
        eq(browserProfiles.orgId, orgId),
        eq(browserProfiles.heldByUserId, userId),
      ),
    )
    .returning({ id: browserProfiles.id });
  return rows.length > 0;
}

/** Who may drive a profile (log in, open a site, take control): `manage_connectors` with `control_computers`. */
export async function requireProfileDriver(db: Database, userId: string, orgId: string, profileId: string) {
  const membership = await requirePermission(db, userId, orgId, "manage_connectors");
  if (!can(membership, "control_computers")) throw new ForbiddenError();
  return requireProfile(db, orgId, profileId);
}

/**
 * Who may watch a profile live: its drivers and the owners of the agents granted it. Never the person behind a
 * run: a profile shows a whole account, so the asker gets the agent's answer, not the screen.
 */
export async function requireProfileWatcher(db: Database, userId: string, orgId: string, profileId: string) {
  const membership = await requireActiveMembership(db, userId, orgId);
  const row = await requireProfile(db, orgId, profileId);
  if (can(membership, "manage_connectors") && can(membership, "control_computers")) return row;
  const [owned] = await db
    .select({ id: agents.id })
    .from(browserProfileGrants)
    .innerJoin(agents, eq(agents.id, browserProfileGrants.agentId))
    .where(and(eq(browserProfileGrants.profileId, profileId), eq(agents.ownerUserId, userId)))
    .limit(1);
  if (!owned) throw new ForbiddenError();
  return row;
}

/** How a person's control of a profile drives its runner session: the profile's key stands for the agent. */
export const profileScope = (profileId: string): AgentScope => ({ id: profileKey(profileId), handle: "profile" });

/**
 * A person's control of a profile as the live view and the apps read a take over: the same shape as an agent's
 * handoff, its id and agent the profile's key (`profile:<id>`). Null while no person holds it.
 */
export function profileControlRow(
  p: BrowserProfileRow,
  now = Date.now(),
): typeof schema.browserHandoffs.$inferSelect | null {
  const holder = holderOf(p, now);
  if (holder?.type !== "person" || !p.heldUntil) return null;
  const key = profileKey(p.id);
  return {
    id: key,
    orgId: p.orgId,
    agentId: key,
    runId: null,
    machineId: p.machineId,
    screen: "browser",
    kind: "takeover",
    instructions: "",
    status: "active",
    requestedForUserId: holder.userId,
    controllerUserId: holder.userId,
    note: null,
    expiresAt: p.heldUntil,
    pageReadAt: null,
    createdAt: p.heldSince ?? p.heldUntil,
    resolvedAt: null,
  };
}

export interface ProfileControlDeps extends ProfileDeps {
  pubsub?: PubSub;
}

/** Every replica's live views of the profile read its control again (`opened`: start the stream again too). */
async function announceProfile(deps: ProfileControlDeps, orgId: string, profileId: string, opened = false) {
  await deps.pubsub
    ?.publish(BROWSER_HANDOFF_TOPIC, {
      type: opened ? "browser.opened" : "browser.handoff.changed",
      orgId,
      agentId: profileKey(profileId),
      screen: "browser",
    })
    .catch(() => {});
}

/**
 * "Fazer login": the person who may drive it takes control of the profile (agents wait meanwhile) and its Chrome
 * starts, so the live view shows a page at once. 409 `browser_profile.busy` while another person has it.
 */
export async function startProfileControl(deps: ProfileControlDeps, userId: string, orgId: string, profileId: string) {
  const row = await requireProfileDriver(deps.db, userId, orgId, profileId);
  const problem = await profileMachineProblem(deps.db, deps.hub, orgId, row.machineId);
  if (problem) throw new ValidationError(problem, "browser_profile.machine");
  const taken = await takeProfileControl(deps.db, orgId, profileId, userId);
  if (!taken) throw new ConflictError("Someone else is using this profile", "browser_profile.busy");
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: userId },
    action: "browser_profile.control",
    target: { type: "browser_profile", id: profileId },
    details: { name: row.name },
  });
  await deps.hub
    ?.call(
      row.machineId,
      { op: "browser.warm", agent: profileScope(profileId), profile: { id: profileId } },
      { timeoutMs: 90_000 },
    )
    .catch(() => {});
  await announceProfile(deps, orgId, profileId, true);
  return browserProfileView(deps.db, orgId, profileId);
}

/** Devolver: the person's control ends; agents granted it may use it again. */
export async function endProfileControl(deps: ProfileControlDeps, userId: string, orgId: string, profileId: string) {
  await requireProfile(deps.db, orgId, profileId);
  await releaseProfileControl(deps.db, orgId, profileId, userId);
  await announceProfile(deps, orgId, profileId);
  return browserProfileView(deps.db, orgId, profileId);
}

/** How long a person's open may take on the computer (a slow page, or Chrome starting). */
const OPEN_PAGE_SECONDS = 60;

/** The person in control opens a site in the profile (its live view's address field); the views show it at once. */
export async function openProfilePage(
  deps: ProfileControlDeps,
  userId: string,
  orgId: string,
  profileId: string,
  typed: string,
) {
  const row = await requireProfileDriver(deps.db, userId, orgId, profileId);
  if (holderOf(row)?.type !== "person" || row.heldByUserId !== userId) {
    throw new ConflictError("Take control of the profile first", "browser.not_in_control");
  }
  const url = webAddress(typed);
  if (!url) throw new ValidationError("Type a web address (https://…)", "browser.bad_address");
  if (!deps.hub) throw new ValidationError("Connected computers are not available on this server");
  const reply = await deps.hub.call<"browser.act">(
    row.machineId,
    {
      op: "browser.act",
      agent: profileScope(profileId),
      profile: { id: profileId },
      command: "open",
      args: [url],
      timeoutSeconds: OPEN_PAGE_SECONDS,
    },
    { timeoutMs: (OPEN_PAGE_SECONDS + 30) * 1000 },
  );
  await touchProfileControl(deps.db, profileId, userId);
  await announceProfile(deps, orgId, profileId, true);
  if (!reply.success) throw new ValidationError(reply.error || "The page didn't open", "browser.open_failed");
}
