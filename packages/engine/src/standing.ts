import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, ne, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { ForbiddenError } from "./errors";
import { publishOrgEvent } from "./events";
import type { Judge } from "./judge";
import type { MachineHub } from "./machine-hub";
import { notifyOrgStanding } from "./notification-producers";

const { organizations, agents, users, sessions, pushDevices, organizationMembers, machineProvisioning } = schema;

/**
 * A workspace's standing (ADR 0056 §8), set by the people who run this server through the operator API and
 * enforced where work starts:
 *
 * - `hold`: its agents stop. No model call (Model Gateway), no new computer work and no bridge call (machine
 *   hub), no judge or router call (they bill the server, not the workspace), no routine, no invitation; a run
 *   that starts fails at once and says why. People still read and write.
 * - `suspended`: the same, every permission check refuses (`org.suspended`), and what its agents still have
 *   going stops at once (`stopOrgWork`).
 * - notice `shown`: the workspace is told the reason, the change goes into its audit log and a new state
 *   notifies its owners and admins. `silent`: it is told only that it is paused, never why or by whom, and
 *   nothing is written where it can read it.
 *
 * Also one agent held (the same refusals, for that agent only) and one account blocked (no sign-in, no
 * membership anywhere): ADR 0056 §9.
 */
export const STANDING_STATES = ["active", "hold", "suspended"] as const;
export type StandingState = (typeof STANDING_STATES)[number];
export const STANDING_NOTICES = ["shown", "silent"] as const;
export type StandingNotice = (typeof STANDING_NOTICES)[number];

export interface OrgStanding {
  state: StandingState;
  reason: string | null;
  /** The operator's own note: never shown to the workspace. */
  note: string | null;
  notice: StandingNotice;
  changedAt: Date | null;
}

/** What a refusal needs, for selects that already read the organization row. */
export const STANDING_COLUMNS = {
  state: organizations.standing,
  reason: organizations.standingReason,
  notice: organizations.standingNotice,
};

/** All of it, the operator's note included: for the operator API only. */
export const OPERATOR_STANDING_COLUMNS = {
  ...STANDING_COLUMNS,
  note: organizations.standingNote,
  changedAt: organizations.standingChangedAt,
};

/** What the workspace may know of its standing: never the operator's note. */
export type WorkspaceStanding = Pick<OrgStanding, "state" | "reason" | "notice">;

/**
 * Holds a billing service sets (ADR 0077): a shown hold whose reason is one of these codes, which the apps say in
 * the person's words. `payment`: no plan yet; `unpaid`: its payment failed; `ended`: its plan ended.
 */
export const BILLING_HOLDS = ["payment", "unpaid", "ended"] as const;
export type BillingHold = (typeof BILLING_HOLDS)[number];

/** A hold the billing service set: never one an operator or trust set (those win, and block creating workspaces). */
export const isBillingHold = (s: Pick<OrgStanding, "state" | "reason" | "notice">) =>
  s.state === "hold" && s.notice === "shown" && (BILLING_HOLDS as readonly string[]).includes(s.reason ?? "");

const ACTIVE: WorkspaceStanding = { state: "active", reason: null, notice: "shown" };

/** The reason the workspace is told: only with the notice `shown`. */
export const toldReason = (s: Pick<OrgStanding, "reason" | "notice">) => (s.notice === "shown" ? s.reason : null);

const PAUSED = "Agents in this workspace are paused for now.";
const UNAVAILABLE = "This workspace is unavailable for now.";
const ON_HOLD = "This workspace is on hold: ";
const SUSPENDED = "This workspace is suspended: ";
const AGENT_PAUSED = "This agent is paused for now.";

/** What the workspace reads when work is refused; silent, only that it is paused. */
export function standingText(s: WorkspaceStanding): string {
  const reason = toldReason(s);
  if (s.state === "suspended") return reason ? `${SUSPENDED}${reason}` : UNAVAILABLE;
  return reason ? `${ON_HOLD}${reason}` : PAUSED;
}

/** The app's code (and the reason told) of a run refused by its standing; null for any other error. */
export function standingErrorDetail(error: string): { errorCode: string; errorParams?: Record<string, string> } | null {
  if (error === AGENT_PAUSED) return { errorCode: "run.agent_paused" };
  if (error === PAUSED) return { errorCode: "run.org_paused" };
  if (error === UNAVAILABLE) return { errorCode: "run.org_suspended" };
  if (error.startsWith(ON_HOLD))
    return { errorCode: "run.org_paused", errorParams: { reason: error.slice(ON_HOLD.length) } };
  if (error.startsWith(SUSPENDED))
    return { errorCode: "run.org_suspended", errorParams: { reason: error.slice(SUSPENDED.length) } };
  return null;
}

/** Work refused because the workspace isn't active: `org.paused` on hold, else `org.suspended` (403). */
export class OrgPausedError extends ForbiddenError {
  /** A job that hits it fails at once: retrying within minutes won't lift a hold (the outbox reads this flag). */
  readonly retryable = false;

  constructor(readonly standing: WorkspaceStanding) {
    const reason = toldReason(standing);
    super(
      standingText(standing),
      standing.state === "suspended" ? "org.suspended" : "org.paused",
      reason ? { reason } : undefined,
    );
    this.name = "OrgPausedError";
  }
}

/** Work refused because this agent is held (`agent.paused`, 403). The workspace never reads why. */
export class AgentHeldError extends ForbiddenError {
  /** Like `OrgPausedError`: a job that hits it fails at once. */
  readonly retryable = false;

  constructor() {
    super(AGENT_PAUSED, "agent.paused");
    this.name = "AgentHeldError";
  }
}

/** A workspace's standing, cached 5 s per process. An unknown id reads as active: what needs the row fails on its own. */
export async function orgStanding(db: Executor, orgId: string): Promise<WorkspaceStanding> {
  return (await caches.standing.getOrLoad(`${orgId}:`, async () => {
    const [row] = await db.select(STANDING_COLUMNS).from(organizations).where(eq(organizations.id, orgId));
    return row ?? ACTIVE;
  })) as WorkspaceStanding;
}

/** Whether this agent is held, cached 5 s per process like the workspace's standing. */
async function agentHeld(db: Executor, orgId: string, agentId: string): Promise<boolean> {
  return (await caches.standing.getOrLoad(`${orgId}:${agentId}`, async () => {
    const [row] = await db
      .select({ heldAt: agents.operatorHoldAt })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
    return Boolean(row?.heldAt);
  })) as boolean;
}

/** Why work in this workspace (by this agent, when given) is refused now, or null while it may go on. */
export async function standingRefusal(
  db: Executor,
  orgId: string,
  agentId?: string | null,
): Promise<OrgPausedError | AgentHeldError | null> {
  const standing = await orgStanding(db, orgId);
  if (standing.state !== "active") return new OrgPausedError(standing);
  return agentId && (await agentHeld(db, orgId, agentId)) ? new AgentHeldError() : null;
}

/** Throws `OrgPausedError` unless the workspace is active, and `AgentHeldError` when the agent given is held. */
export async function assertCanWork(db: Executor, orgId: string, agentId?: string | null) {
  const refusal = await standingRefusal(db, orgId, agentId);
  if (refusal) throw refusal;
}

/**
 * The judge, asking nothing for a workspace that isn't active: Jev bills the server, not the workspace,
 * and callers already carry on without an answer.
 */
export function standingJudge(db: Database, judge: Judge): Judge {
  return {
    // Read live: the name follows whether Jev has a key now.
    get name() {
      return judge.name;
    },
    async ask(request) {
      await assertCanWork(db, request.orgId);
      return judge.ask(request);
    },
  };
}

export interface StandingChange {
  state: StandingState;
  reason: string | null;
  note?: string | null;
  notice: StandingNotice;
}

export interface StandingDeps {
  db: Database;
  pubsub?: PubSub;
  /** Stops the tasks of a suspended workspace on its computers (absent: they are only marked canceled). */
  hub?: Pick<MachineHub, "call">;
}

/**
 * Sets a workspace's standing (the operator API): at once in this process, within 5 s in the others. When
 * what the workspace sees changes (the state, or the reason it is told), its members hear `org.standing`;
 * with the notice `shown` the change goes into its audit log, and a new state notifies its owners and
 * admins. Suspending it also stops its runs and tasks now. A workspace held or suspended waits for no computer:
 * what its provisioner last said goes, and the apps ask again on `org.standing`. Null when there is no such workspace.
 */
export async function setOrgStanding(
  deps: StandingDeps,
  orgId: string,
  change: StandingChange,
): Promise<OrgStanding | null> {
  const done = await deps.db.transaction(async (tx) => {
    const [before] = await lockStanding(tx, orgId);
    return before ? writeStanding(tx, orgId, before, change) : null;
  });
  if (!done) return null;
  await standingWritten(deps, orgId, done);
  return done.after;
}

/**
 * Puts the billing service's hold on a workspace, moves it to another code, or lifts it (`null`), through the same
 * write as `setOrgStanding`. A suspension or any other hold is never replaced nor lifted from here: `applied` false,
 * as when it is already so. Null when there is no such workspace.
 */
export async function setBillingHold(
  deps: StandingDeps,
  orgId: string,
  hold: BillingHold | null,
): Promise<{ applied: boolean; standing: OrgStanding } | null> {
  const done = await deps.db.transaction(async (tx) => {
    const [before] = await lockStanding(tx, orgId);
    if (!before) return null;
    const change = billingChange(before, hold);
    return { before, written: change ? await writeStanding(tx, orgId, before, change) : null };
  });
  if (!done) return null;
  if (!done.written) return { applied: false, standing: done.before };
  await standingWritten(deps, orgId, done.written);
  return { applied: true, standing: done.written.after };
}

/** What a billing hold changes on the standing now; null when nothing (already so, or not the billing service's). */
function billingChange(before: OrgStanding, hold: BillingHold | null): StandingChange | null {
  const billing = isBillingHold(before);
  if (before.state === "suspended" || (before.state === "hold" && !billing)) return null;
  if (hold === null) return billing ? { state: "active", reason: null, note: null, notice: "shown" } : null;
  return billing && before.reason === hold ? null : { state: "hold", reason: hold, note: null, notice: "shown" };
}

const lockStanding = (tx: Executor, orgId: string) =>
  tx.select(OPERATOR_STANDING_COLUMNS).from(organizations).where(eq(organizations.id, orgId)).for("update");

/** Writes a standing on the workspace's row, locked by `lockStanding` in the same transaction. */
async function writeStanding(tx: Executor, orgId: string, before: OrgStanding, change: StandingChange) {
  const moved = before.state !== change.state;
  const [after] = await tx
    .update(organizations)
    .set({
      standing: change.state,
      standingReason: change.reason,
      standingNote: change.note ?? null,
      standingNotice: change.notice,
      ...(moved ? { standingChangedAt: new Date() } : {}),
    })
    .where(eq(organizations.id, orgId))
    .returning(OPERATOR_STANDING_COLUMNS);
  if (!after) return null;
  // Held or suspended, it waits for no computer: what its provisioner last said goes (a ready computer stays), each
  // time it is set. Under this row's lock, which a report and a removal share, so neither brings the wait back.
  if (after.state !== "active") {
    await tx
      .delete(machineProvisioning)
      .where(and(eq(machineProvisioning.orgId, orgId), ne(machineProvisioning.state, "ready")));
  }
  const seen = moved || (after.state !== "active" && toldReason(before) !== toldReason(after));
  if (seen && after.notice === "shown") {
    await recordAudit(tx, {
      orgId,
      actor: { type: "system", id: null },
      action: "organization.standing_changed",
      target: { type: "organization", id: orgId },
      details: { from: before.state, to: after.state, reason: after.reason },
    });
  }
  return { after, moved, seen };
}

/** What follows a standing written, once its transaction committed: caches, the members, owners and admins, work. */
async function standingWritten(
  deps: StandingDeps,
  orgId: string,
  { after, moved, seen }: { after: OrgStanding; moved: boolean; seen: boolean },
) {
  caches.standing.delete(`${orgId}:`);
  if (seen) {
    await publishOrgEvent(deps.pubsub, {
      type: "org.broadcast",
      orgId,
      event: { type: "org.standing", orgId, state: after.state, reason: toldReason(after) },
    });
  }
  if (moved && after.notice === "shown") {
    await notifyOrgStanding(deps, orgId, { ...after, billing: isBillingHold(after) }).catch(() => {});
  }
  // Every time, not only on the move: setting it again (a retry after a failure) finishes the job.
  if (after.state === "suspended") {
    // Loaded here: the run engine builds on this module.
    const { stopOrgWork } = await import("./cancel");
    await stopOrgWork(deps, orgId, standingText(after));
  }
}

/**
 * Holds an agent, or lets it go (the operator API): held, it starts nothing (no run, model call, computer
 * work, routine slot or bridge call) and the router never picks it, while the rest of the workspace works.
 * What it is doing now stops at its next model, computer or bridge call. At once in this process, within
 * 5 s in the others. Null when the workspace has no such agent.
 */
export async function setAgentHold(
  db: Database,
  orgId: string,
  agentId: string,
  change: { held: boolean; reason: string | null },
) {
  const [row] = await db
    .update(agents)
    .set(
      change.held
        ? { operatorHoldAt: sql`coalesce(${agents.operatorHoldAt}, now())`, operatorHoldReason: change.reason }
        : { operatorHoldAt: null, operatorHoldReason: null },
    )
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)))
    .returning({ heldAt: agents.operatorHoldAt, reason: agents.operatorHoldReason });
  if (!row) return null;
  caches.standing.delete(`${orgId}:${agentId}`);
  caches.agents.delete(`${orgId}:${agentId}`);
  return row;
}

/** Whether this account is blocked (`setUserBlocked`). */
export async function isUserBlocked(db: Executor, userId: string) {
  const [row] = await db.select({ blockedAt: users.blockedAt }).from(users).where(eq(users.id, userId));
  return Boolean(row?.blockedAt);
}

/**
 * Blocks an account, or lets it back (the operator API). Blocked, it can't sign in (`auth.ts`), its sessions
 * and phones are gone, and every membership check reads it as no member (`getMembership`): that bites on
 * its next request, even while a browser's cookie cache still holds the session for minutes. Its open
 * sockets in every workspace close (`membership.revoked`). Null when there is no such account.
 */
export async function setUserBlocked(
  deps: { db: Database; pubsub?: PubSub },
  userId: string,
  change: { blocked: boolean; reason: string | null },
) {
  const done = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set(
        change.blocked
          ? { blockedAt: sql`coalesce(${users.blockedAt}, now())`, blockedReason: change.reason }
          : { blockedAt: null, blockedReason: null },
      )
      .where(eq(users.id, userId))
      .returning({ blockedAt: users.blockedAt, reason: users.blockedReason });
    if (!row) return null;
    if (!change.blocked) return { ...row, sessionsRevoked: 0, orgIds: [] };
    const revoked = await tx.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
    await tx.delete(pushDevices).where(eq(pushDevices.userId, userId));
    const orgs = await tx
      .select({ orgId: organizationMembers.orgId })
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, userId));
    return { ...row, sessionsRevoked: revoked.length, orgIds: orgs.map((o) => o.orgId) };
  });
  if (!done) return null;
  const { orgIds, ...state } = done;
  for (const orgId of orgIds) await publishOrgEvent(deps.pubsub, { type: "membership.revoked", orgId, userId });
  return state;
}
