import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, ne, schema, sql } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { ForbiddenError } from "./errors";
import { publishOrgEvent } from "./events";
import type { Judge } from "./judge";
import type { MachineHub } from "./machine-hub";
import { notifyAgentHold, notifyOrgStanding, resolveAgentHold } from "./notification-producers";
import { isAgentesCloud } from "./telemetry";

const { organizations, agents, users, sessions, pushDevices, organizationMembers, machineProvisioning } = schema;

let cloudNotices = false;

/**
 * From the server's own address at boot: on agentes.chat Cloud a restriction says `cloud: true` beside its code, with
 * a held agent's or a blocked account's kind, and an agent hold tells its people, so the apps add the Terms section
 * and how to contest it (ADR 0056 §9). Elsewhere its people read what they always read.
 */
export function setRestrictionNotices(publicUrl: string) {
  cloudNotices = isAgentesCloud(publicUrl);
}

/** `{ cloud: true }` on agentes.chat Cloud, nothing elsewhere: spread beside a restriction the apps put in words. */
export const cloudNotice = () => (cloudNotices ? { cloud: true as const } : undefined);

/**
 * What the people a restriction meets read of its stored reason, on agentes.chat Cloud only: an agent hold is
 * `network` (a network rule's, `network.…`) or `operator`, an account block `abuse` (a sign-up linked to an account
 * closed for abuse), `legal` (a legal hold) or `other`. Never the reason itself.
 */
export const agentHoldKind = (reason: string | null) => (reason?.startsWith("network.") ? "network" : "operator");
export const accountBlockKind = (reason: string | null) =>
  reason === "abuse.resignup" ? "abuse" : reason === "legal_hold" ? "legal" : "other";

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

const ACTIVE: WorkspaceStanding = { state: "active", reason: null, notice: "shown" };

/** The reason the workspace is told: only with the notice `shown`. */
export const toldReason = (s: Pick<OrgStanding, "reason" | "notice">) => (s.notice === "shown" ? s.reason : null);

const PAUSED = "Agents in this workspace are paused for now.";
const UNAVAILABLE = "This workspace is unavailable for now.";
const ON_HOLD = "This workspace is on hold: ";
const SUSPENDED = "This workspace is suspended: ";
const AGENT_PAUSED = "This agent is paused for now.";
/** On agentes.chat Cloud, followed by the hold's kind: a run keeps it in its error, so its line names the kind. */
const AGENT_HELD = "This agent is paused: ";

/** What the workspace reads when work is refused; silent, only that it is paused. */
export function standingText(s: WorkspaceStanding): string {
  const reason = toldReason(s);
  if (s.state === "suspended") return reason ? `${SUSPENDED}${reason}` : UNAVAILABLE;
  return reason ? `${ON_HOLD}${reason}` : PAUSED;
}

/**
 * The app's code of a run refused by its standing, with the reason told or the hold's kind, and on agentes.chat Cloud
 * `cloud` ("true": a run's values are text); null for any other error.
 */
export function standingErrorDetail(error: string): { errorCode: string; errorParams?: Record<string, string> } | null {
  const told = (errorCode: string, values: Record<string, string> = {}) => {
    const errorParams = cloudNotices ? { ...values, cloud: "true" } : values;
    return Object.keys(errorParams).length > 0 ? { errorCode, errorParams } : { errorCode };
  };
  if (error === AGENT_PAUSED) return told("run.agent_paused");
  if (error.startsWith(AGENT_HELD)) return told("run.agent_paused", { kind: error.slice(AGENT_HELD.length) });
  if (error === PAUSED) return told("run.org_paused");
  if (error === UNAVAILABLE) return told("run.org_suspended");
  if (error.startsWith(ON_HOLD)) return told("run.org_paused", { reason: error.slice(ON_HOLD.length) });
  if (error.startsWith(SUSPENDED)) return told("run.org_suspended", { reason: error.slice(SUSPENDED.length) });
  return null;
}

/** Work refused because the workspace isn't active: `org.paused` on hold, else `org.suspended` (403). */
export class OrgPausedError extends ForbiddenError {
  /** A job that hits it fails at once: retrying within minutes won't lift a hold (the outbox reads this flag). */
  readonly retryable = false;

  constructor(readonly standing: WorkspaceStanding) {
    const reason = toldReason(standing);
    const params = { ...(reason ? { reason } : {}), ...cloudNotice() };
    super(
      standingText(standing),
      standing.state === "suspended" ? "org.suspended" : "org.paused",
      Object.keys(params).length > 0 ? params : undefined,
    );
    this.name = "OrgPausedError";
  }
}

/**
 * Work refused because this agent is held (`agent.paused`, 403). The workspace never reads why: on agentes.chat Cloud
 * only the hold's kind (`agentHoldKind`).
 */
export class AgentHeldError extends ForbiddenError {
  /** Like `OrgPausedError`: a job that hits it fails at once. */
  readonly retryable = false;

  constructor(kind?: string) {
    super(kind ? `${AGENT_HELD}${kind}` : AGENT_PAUSED, "agent.paused", kind ? { kind, cloud: true } : undefined);
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

/** This agent's hold (its stored reason), or null while it isn't held: cached 5 s per process like the standing. */
async function agentHold(db: Executor, orgId: string, agentId: string): Promise<{ reason: string | null } | null> {
  return (await caches.standing.getOrLoad(`${orgId}:${agentId}`, async () => {
    const [row] = await db
      .select({ heldAt: agents.operatorHoldAt, reason: agents.operatorHoldReason })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
    return row?.heldAt ? { reason: row.reason } : null;
  })) as { reason: string | null } | null;
}

/** Why work in this workspace (by this agent, when given) is refused now, or null while it may go on. */
export async function standingRefusal(
  db: Executor,
  orgId: string,
  agentId?: string | null,
): Promise<OrgPausedError | AgentHeldError | null> {
  const standing = await orgStanding(db, orgId);
  if (standing.state !== "active") return new OrgPausedError(standing);
  const hold = agentId ? await agentHold(db, orgId, agentId) : null;
  if (!hold) return null;
  return new AgentHeldError(cloudNotices ? agentHoldKind(hold.reason) : undefined);
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
  const { db } = deps;
  const done = await db.transaction(async (tx) => {
    const [before] = await tx
      .select(OPERATOR_STANDING_COLUMNS)
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for("update");
    if (!before) return null;
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
  });
  if (!done) return null;
  caches.standing.delete(`${orgId}:`);
  const { after } = done;
  if (done.seen) {
    await publishOrgEvent(deps.pubsub, {
      type: "org.broadcast",
      orgId,
      event: { type: "org.standing", orgId, state: after.state, reason: toldReason(after), ...cloudNotice() },
    });
  }
  if (done.moved && after.notice === "shown")
    await notifyOrgStanding(deps, orgId, { ...after, cloud: cloudNotices }).catch(() => {});
  // Every time, not only on the move: setting it again (a retry after a failure) finishes the job.
  if (after.state === "suspended") {
    // Loaded here: the run engine builds on this module.
    const { stopOrgWork } = await import("./cancel");
    await stopOrgWork(deps, orgId, standingText(after));
  }
  return after;
}

/**
 * Holds an agent, or lets it go (the operator API): held, it starts nothing (no run, model call, computer
 * work, routine slot or bridge call) and the router never picks it, while the rest of the workspace works.
 * What it is doing now stops at its next model, computer or bridge call. At once in this process, within
 * 5 s in the others. On agentes.chat Cloud its responsible person and the workspace's admins are told, with the
 * hold's kind, and told again when it is held again for another kind. Letting it go closes that notice. Null when the
 * workspace has no such agent.
 */
export async function setAgentHold(
  db: Database,
  orgId: string,
  agentId: string,
  change: { held: boolean; reason: string | null },
  pubsub?: PubSub,
) {
  const theAgent = and(eq(agents.id, agentId), eq(agents.orgId, orgId));
  const [before] = await db
    .select({ heldAt: agents.operatorHoldAt, reason: agents.operatorHoldReason })
    .from(agents)
    .where(theAgent);
  const [row] = await db
    .update(agents)
    .set(
      change.held
        ? { operatorHoldAt: sql`coalesce(${agents.operatorHoldAt}, now())`, operatorHoldReason: change.reason }
        : { operatorHoldAt: null, operatorHoldReason: null },
    )
    .where(theAgent)
    .returning({ heldAt: agents.operatorHoldAt, reason: agents.operatorHoldReason, name: agents.name });
  if (!row) return null;
  caches.standing.delete(`${orgId}:${agentId}`);
  caches.agents.delete(`${orgId}:${agentId}`);
  const { heldAt, reason, name } = row;
  const deps = { db, pubsub };
  const kind = agentHoldKind(reason);
  // The notice says the kind its refusals and runs say: another kind while held replaces it, the same one keeps it.
  const was = before?.heldAt ? agentHoldKind(before.reason) : null;
  if (!heldAt || (was && was !== kind)) await resolveAgentHold(deps, orgId, agentId).catch(() => {});
  if (heldAt && cloudNotices && was !== kind)
    await notifyAgentHold(deps, { orgId, agentId, name, kind, at: new Date() }).catch(() => {});
  return { heldAt, reason };
}

/**
 * Whether this account is blocked (null: it isn't), and what its sign-in may say of why: on agentes.chat Cloud the
 * block's kind (`accountBlockKind`) with `cloud: true`, never the reason.
 */
export async function accountBlock(db: Executor, userId: string) {
  const [row] = await db
    .select({ blockedAt: users.blockedAt, reason: users.blockedReason })
    .from(users)
    .where(eq(users.id, userId));
  if (!row?.blockedAt) return null;
  return cloudNotices ? { kind: accountBlockKind(row.reason), cloud: true as const } : {};
}

/** Whether this account is blocked (`setUserBlocked`). */
export async function isUserBlocked(db: Executor, userId: string) {
  return (await accountBlock(db, userId)) !== null;
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
