import {
  DESKTOP_PROTOCOL,
  type RateLimiter,
  STREAM_CLOSE,
  STREAM_LIMITS,
  type StreamRequest,
} from "@agenteschat/adapters";
import { and, type Database, eq, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { agentUsesScreen, openHandoffOf, requireBrowserAccess } from "./browser/handoff";
import { ForbiddenError, NotFoundError } from "./errors";
import type { MachineHub } from "./machine-hub";
import { getMachine, type MachineRow, machineOnline } from "./machines";
import { getMembership } from "./organizations";
import type { Stream, StreamInput, StreamTarget } from "./streams";

const { agents } = schema;

const refused = (code: number, reason: string): StreamTarget => ({ refused: code, reason });

/** Who may watch an agent's desktop (ADR 0056 §4): the browser's rule, on the `desktop` screen. */
export const requireDesktopAccess = (db: Database, userId: string, orgId: string, agentId: string) =>
  requireBrowserAccess(db, userId, orgId, agentId, undefined, "desktop");

/**
 * Who may control an agent's desktop or open its terminal (ADR 0056 §4): who
 * may run commands as the OS user it runs as, since a desktop in control has a
 * terminal too. A runner runs its agents as its own user, which holds every
 * agent's folder, the computer's sign-ins and its token: only the person who
 * paired the computer, and nobody on a computer nobody paired. Returns that
 * computer.
 */
export async function requireComputerDriver(
  db: Database,
  userId: string,
  orgId: string,
  agentId: string,
): Promise<MachineRow> {
  if (!(await getMembership(db, userId, orgId))) throw new ForbiddenError("You are not a member of this organization");
  const [agent] = await db
    .select({ machineId: agents.machineId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  if (!agent) throw new NotFoundError("Agent not found");
  const machine = agent.machineId ? await getMachine(db, orgId, agent.machineId) : null;
  if (!machine) throw new NotFoundError("This agent has no computer");
  // ponytail: single-user for every runner (none reports system mode); system mode adds admins and the agent's owner.
  if (machine.pairedByUserId !== userId) {
    throw new ForbiddenError("Only the person who connected this computer can use it as the agent");
  }
  return machine;
}

/**
 * The computer a person's stream of an agent goes to, or why it can't: the
 * agent's own computer, with its socket on this server (streams don't cross
 * servers), on protocol 18 or later, its switch for that kind on and the
 * runner able to serve it; for a desktop, an agent that may use one.
 */
export async function desktopTarget(
  db: Database,
  hub: Pick<MachineHub, "isLocal">,
  orgId: string,
  agentId: string,
  kind: StreamRequest["kind"],
): Promise<StreamTarget> {
  const [agent] = await db
    .select({ handle: agents.handle, name: agents.name, machineId: agents.machineId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  if (!agent) return refused(STREAM_CLOSE.notFound, "no_agent");
  if (kind === "desktop" && !(await agentUsesScreen(db, orgId, agentId, "desktop"))) {
    return refused(STREAM_CLOSE.notFound, "no_desktop");
  }
  const machine = agent.machineId ? await getMachine(db, orgId, agent.machineId) : null;
  if (!machine) return refused(STREAM_CLOSE.notFound, "no_computer");
  if (!hub.isLocal(machine.id)) {
    return refused(STREAM_CLOSE.unreachable, machineOnline(machine) ? "other_server" : "offline");
  }
  if (machine.protocol < DESKTOP_PROTOCOL) return refused(STREAM_CLOSE.refused, "runner_outdated");
  if (!machine.access?.tools[kind]) return refused(STREAM_CLOSE.refused, "not_allowed");
  if (!machine.executors?.[kind]?.available) return refused(STREAM_CLOSE.refused, `${kind}_unavailable`);
  return { machineId: machine.id, agent: { id: agentId, handle: agent.handle, name: agent.name } };
}

export interface StreamPolicyDeps {
  db: Database;
  hub: Pick<MachineHub, "isLocal">;
  rateLimiter?: RateLimiter;
}

/**
 * Whether a person's stream may open, and where (the broker's `authorize`):
 * at most `opensPerMinute` opens a minute per person; watching follows the
 * browser's rule, control and the terminal the computer's driver; while
 * someone controls the desktop nobody else sees it, and only they get
 * control; then the computer (`desktopTarget`).
 */
export async function authorizeStream(deps: StreamPolicyDeps, input: StreamInput): Promise<StreamTarget> {
  const { db } = deps;
  const { userId, orgId, agentId, request } = input;
  const rate = await deps.rateLimiter?.consume(`stream-open:${userId}`, {
    limit: STREAM_LIMITS.opensPerMinute,
    windowMs: 60_000,
  });
  if (rate && !rate.allowed) return refused(STREAM_CLOSE.tooMany, "rate_limited");
  let driven: string | null = null;
  try {
    if (request.kind === "terminal" || request.mode === "control") {
      driven = (await requireComputerDriver(db, userId, orgId, agentId)).id;
    } else await requireDesktopAccess(db, userId, orgId, agentId);
  } catch (error) {
    if (error instanceof ForbiddenError) return refused(STREAM_CLOSE.forbidden, "forbidden");
    if (error instanceof NotFoundError) return refused(STREAM_CLOSE.notFound, "not_found");
    throw error;
  }
  if (request.kind === "desktop") {
    const open = await openHandoffOf(db, orgId, agentId, "desktop");
    const controller = open?.status === "active" ? open.controllerUserId : null;
    if (controller && controller !== userId) return refused(STREAM_CLOSE.hidden, "someone_in_control");
    if (request.mode === "control" && controller !== userId) {
      return refused(STREAM_CLOSE.controlEnded, "not_in_control");
    }
  }
  const target = await desktopTarget(db, deps.hub, orgId, agentId, request.kind);
  // The agent moved to another computer meanwhile: who drives that one wasn't checked.
  if (driven && "machineId" in target && target.machineId !== driven) {
    return refused(STREAM_CLOSE.forbidden, "forbidden");
  }
  return target;
}

/** A stream that ran, in the org's audit log (ADR 0056 §12): who, which agent and computer, how long, how many bytes. */
export async function auditStream(db: Database, s: Stream) {
  const action =
    s.request.kind === "terminal"
      ? "terminal.session"
      : s.request.mode === "control"
        ? "desktop.controlled"
        : "desktop.watched";
  await recordAudit(db, {
    orgId: s.orgId,
    actor: { type: "person", id: s.userId },
    action,
    target: { type: "agent", id: s.agentId },
    details: {
      machineId: s.machineId,
      seconds: Math.round((Date.now() - (s.readyAt ?? s.openedAt)) / 1000),
      bytesIn: s.bytesIn,
      bytesOut: s.bytesOut,
    },
  });
}
