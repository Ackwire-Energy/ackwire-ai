import type { PubSub } from "@agenteschat/adapters";
import { type Database, type Executor, eq, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { ForbiddenError } from "./errors";
import { publishOrgEvent } from "./events";
import type { Judge } from "./judge";
import { notifyOrgStanding } from "./notification-producers";

const { organizations } = schema;

/**
 * A workspace's standing (ADR 0056 §8), set by the people who run this server through the operator API and
 * enforced where work starts:
 *
 * - `hold`: its agents stop. No model call (Model Gateway), no new computer work and no bridge call (machine
 *   hub), no judge or router call (they bill the server, not the workspace), no routine, no invitation; a run
 *   that starts fails at once and says why. People still read and write.
 * - `suspended`: the same, and every permission check refuses (`org.suspended`).
 * - notice `shown`: the workspace is told the reason, the change goes into its audit log and a new state
 *   notifies its owners and admins. `silent`: it is told only that it is paused, never why or by whom, and
 *   nothing is written where it can read it.
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

/** What the workspace reads when work is refused; silent, only that it is paused. */
export function standingText(s: WorkspaceStanding): string {
  const reason = toldReason(s);
  if (s.state === "suspended") return reason ? `${SUSPENDED}${reason}` : UNAVAILABLE;
  return reason ? `${ON_HOLD}${reason}` : PAUSED;
}

/** The app's code (and the reason told) of a run that failed with `standingText`; null for any other error. */
export function standingErrorDetail(error: string): { errorCode: string; errorParams?: Record<string, string> } | null {
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

/** A workspace's standing, cached 5 s per process. An unknown id reads as active: what needs the row fails on its own. */
export async function orgStanding(db: Executor, orgId: string): Promise<WorkspaceStanding> {
  return (await caches.standing.getOrLoad(`${orgId}:`, async () => {
    const [row] = await db.select(STANDING_COLUMNS).from(organizations).where(eq(organizations.id, orgId));
    return row ?? ACTIVE;
  })) as WorkspaceStanding;
}

/** Why work in this workspace is refused now, or null while it is active. */
export async function standingRefusal(db: Executor, orgId: string): Promise<OrgPausedError | null> {
  const standing = await orgStanding(db, orgId);
  return standing.state === "active" ? null : new OrgPausedError(standing);
}

/** Throws `OrgPausedError` unless the workspace is active. */
export async function assertCanWork(db: Executor, orgId: string) {
  const refusal = await standingRefusal(db, orgId);
  if (refusal) throw refusal;
}

/**
 * The judge, asking nothing for a workspace that isn't active: Jev bills the server, not the workspace,
 * and callers already carry on without an answer.
 */
export function standingJudge(db: Database, judge: Judge): Judge {
  return {
    name: judge.name,
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

/**
 * Sets a workspace's standing (the operator API): at once in this process, within 5 s in the others. When
 * what the workspace sees changes (the state, or the reason it is told), its members hear `org.standing`;
 * with the notice `shown` the change goes into its audit log, and a new state notifies its owners and
 * admins. Null when there is no such workspace.
 */
export async function setOrgStanding(
  deps: { db: Database; pubsub?: PubSub },
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
      event: { type: "org.standing", orgId, state: after.state, reason: toldReason(after) },
    });
  }
  if (done.moved && after.notice === "shown") await notifyOrgStanding(deps, orgId, after).catch(() => {});
  return after;
}
