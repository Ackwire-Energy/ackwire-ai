import {
  DESKTOP_PROTOCOL,
  type PubSub,
  type RateLimiter,
  STREAM_CLOSE,
  STREAM_LIMITS,
  type StreamRequest,
} from "@agenteschat/adapters";
import { and, type Database, eq, inArray, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import {
  agentUsesScreen,
  BROWSER_HANDOFF_TOPIC,
  type BrowserHandoffView,
  CONTROL_GRACE_MS,
  handoffView,
  openHandoffOf,
  openHandoffOn,
  requireBrowserAccess,
  setControlDeadline,
  stopAgentBrowser,
  touchControl,
} from "./browser/handoff";
import { HANDOFF_KEEPALIVE_MS } from "./browser/live";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import type { MachineCaller, MachineHub } from "./machine-hub";
import { drivesComputer, getMachine, machineOnline, requireComputerDriver } from "./machines";
import { can, getMembership } from "./organizations";
import type { Stream, StreamBroker, StreamInput, StreamTarget } from "./streams";

const { agents, browserHandoffs } = schema;

const refused = (code: number, reason: string) => ({ refused: code, reason });

/**
 * Who may watch an agent's desktop (ADR 0056 §4): the browser's rule on the `desktop` screen, and whoever
 * may drive its computer (`requireBrowserAccess`).
 */
export const requireDesktopAccess = (db: Database, userId: string, orgId: string, agentId: string) =>
  requireBrowserAccess(db, userId, orgId, agentId, undefined, "desktop");

/** Who may turn an agent's desktop on and off: admins, the agent's owner, and whoever may drive its computer. */
export async function requireDesktopManager(db: Database, userId: string, orgId: string, agentId: string) {
  const membership = await getMembership(db, userId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
  const [agent] = await db
    .select({ owner: agents.ownerUserId, machineId: agents.machineId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
  if (!agent) throw new NotFoundError("Agent not found");
  if (can(membership.role, "manage_agents") || agent.owner === userId) return;
  const machine = agent.machineId ? await getMachine(db, orgId, agent.machineId) : null;
  if (machine && drivesComputer(machine, { userId, admin: false, owner: false })) return;
  throw new ForbiddenError("Only admins and the agent's owner can turn its desktop on or off");
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

/**
 * Whether the person may have this stream now, as `authorizeStream` decides and the broker checks again
 * every 30 s while it is open: watching follows the desktop's rule, control and the terminal its computer's
 * driver. While someone controls the desktop, or the browser showing the same window, nobody else sees it;
 * control is only theirs, on the desktop's own handoff (`control`: its id).
 */
async function streamAccess(
  db: Database,
  input: StreamInput,
): Promise<{ refused: number; reason: string } | { driven: string | null; control: string | null }> {
  const { userId, orgId, agentId, request } = input;
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
  if (request.kind !== "desktop") return { driven, control: null };
  const open = await openHandoffOn(db, orgId, agentId, "desktop");
  const controller = open?.status === "active" ? open.controllerUserId : null;
  if (controller && controller !== userId) return refused(STREAM_CLOSE.hidden, "someone_in_control");
  if (request.mode === "watch") return { driven, control: null };
  if (open?.screen !== "desktop" || controller !== userId) {
    return refused(STREAM_CLOSE.controlEnded, "not_in_control");
  }
  return { driven, control: open.id };
}

export interface StreamPolicyDeps {
  db: Database;
  hub: Pick<MachineHub, "isLocal">;
  rateLimiter?: RateLimiter;
}

/**
 * Whether a person's stream may open, and where (the broker's `authorize`):
 * at most `opensPerMinute` opens a minute per person, `streamAccess`, then the
 * computer (`desktopTarget`). A control stream opening is its holder back: the
 * grace of their control starts again.
 */
export async function authorizeStream(deps: StreamPolicyDeps, input: StreamInput): Promise<StreamTarget> {
  const rate = await deps.rateLimiter?.consume(`stream-open:${input.userId}`, {
    limit: STREAM_LIMITS.opensPerMinute,
    windowMs: 60_000,
  });
  if (rate && !rate.allowed) return refused(STREAM_CLOSE.tooMany, "rate_limited");
  const access = await streamAccess(deps.db, input);
  if ("refused" in access) return access;
  const target = await desktopTarget(deps.db, deps.hub, input.orgId, input.agentId, input.request.kind);
  if (!("machineId" in target)) return target;
  // The agent moved to another computer meanwhile: who drives that one wasn't checked.
  if (access.driven && target.machineId !== access.driven) return refused(STREAM_CLOSE.forbidden, "forbidden");
  if (access.control) await touchControl(deps.db, access.control, input.userId, new Date(), true).catch(() => {});
  return target;
}

/**
 * The broker's `recheck`: the stream's close when its person lost it (`streamAccess`); a control stream
 * still open keeps its holder's control alive (`touchControl`).
 */
export async function recheckStream(db: Database, stream: Stream) {
  const access = await streamAccess(db, stream);
  if ("refused" in access) return access;
  if (access.control) await touchControl(db, access.control, stream.userId).catch(() => {});
  return null;
}

/**
 * The broker's `onClosed`: the audit, and a control stream's holder keeps control `CONTROL_GRACE_MS` from
 * now to come back (another stream of theirs keeps it longer).
 */
export async function streamClosed(db: Database, s: Stream) {
  if (s.request.kind === "desktop" && s.request.mode === "control") {
    const open = await openHandoffOf(db, s.orgId, s.agentId, "desktop");
    if (open?.status === "active" && open.controllerUserId === s.userId) {
      await setControlDeadline(db, open.id, s.userId, new Date(Date.now() + CONTROL_GRACE_MS)).catch(() => {});
    }
  }
  await auditStream(db, s);
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

// ── The desktop's REST (`routes/app/desktop.ts`) ──────────────────────────────

export interface DesktopDeps {
  db: Database;
  hub?: MachineCaller;
  streams?: Pick<StreamBroker, "count">;
  pubsub?: PubSub;
}

/** The REST reaches a computer through whichever server holds its socket (`hub.call`), unlike a stream. */
const ANYWHERE = { isLocal: () => true };

/** An agent's desktop as one person sees it: whether it can be shown and runs, who controls it, what they may do. */
export interface DesktopStatus {
  /** Whether it can be shown now, else why (a stream's refusal reason: `not_allowed`, `offline`…). */
  available: boolean;
  reason: string | null;
  /** What the computer says it lacks (what to install). */
  detail: string | null;
  running: boolean;
  startedAt: string | null;
  /** Who is in control (of the desktop, or of the browser showing the same window), and that handoff. */
  controllerUserId: string | null;
  handoff: BrowserHandoffView | null;
  /** People watching it through this server. */
  viewers: number;
  /** This person may take control (and open the terminal), and turn it on or off. */
  canControl: boolean;
  canStart: boolean;
  terminal: { available: boolean; reason: string | null; allowed: boolean };
}

const passes = (check: Promise<unknown>) =>
  check.then(
    () => true,
    () => false,
  );

/** `GET …/agents/{agentId}/desktop`: for whoever may watch it. */
export async function desktopStatus(
  deps: DesktopDeps,
  userId: string,
  orgId: string,
  agentId: string,
): Promise<DesktopStatus> {
  const { db } = deps;
  await requireDesktopAccess(db, userId, orgId, agentId);
  const [served, terminalServed, open, canControl, canStart] = await Promise.all([
    desktopTarget(db, ANYWHERE, orgId, agentId, "desktop"),
    desktopTarget(db, ANYWHERE, orgId, agentId, "terminal"),
    openHandoffOn(db, orgId, agentId, "desktop"),
    passes(requireComputerDriver(db, userId, orgId, agentId)),
    passes(requireDesktopManager(db, userId, orgId, agentId)),
  ]);
  const machineId =
    "machineId" in served ? served.machineId : "machineId" in terminalServed ? terminalServed.machineId : null;
  const online = machineId && deps.hub ? (await deps.hub.status(machineId))?.online === true : false;
  const now = (t: StreamTarget): StreamTarget =>
    "refused" in t || online ? t : refused(STREAM_CLOSE.unreachable, "offline");
  const desktop = now(served);
  const terminal = now(terminalServed);
  let running = false;
  let startedAt: string | null = null;
  if ("machineId" in desktop && deps.hub) {
    try {
      const reply = await deps.hub.call<"desktop.session.status">(
        desktop.machineId,
        { op: "desktop.session.status", agent: desktop.agent },
        { timeoutMs: 5_000 },
      );
      running = reply.running;
      startedAt = reply.startedAt ?? null;
    } catch {
      // Not known now: the panel shows it off, and a stream finds out.
    }
  }
  const reasonOf = (t: StreamTarget) => ("refused" in t ? t.reason : null);
  let detail: string | null = null;
  if (reasonOf(desktop) === "desktop_unavailable") {
    const [agent] = await db
      .select({ machineId: agents.machineId })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.orgId, orgId)));
    const machine = agent?.machineId ? await getMachine(db, orgId, agent.machineId) : null;
    detail = machine?.executors?.desktop?.reason?.slice(0, 500) ?? null;
  }
  return {
    available: "machineId" in desktop,
    reason: reasonOf(desktop),
    detail,
    running,
    startedAt,
    controllerUserId: open?.status === "active" ? open.controllerUserId : null,
    handoff: open ? handoffView(open) : null,
    viewers: deps.streams?.count(agentId, "desktop") ?? 0,
    canControl,
    canStart,
    terminal: { available: "machineId" in terminal, reason: reasonOf(terminal), allowed: canControl },
  };
}

/** `POST …/desktop/start` ("Ligar"): admins, the agent's owner, whoever may drive its computer. */
export async function startDesktop(deps: DesktopDeps, userId: string, orgId: string, agentId: string) {
  await requireDesktopManager(deps.db, userId, orgId, agentId);
  if (!deps.hub) throw new ValidationError("Connected computers are not available on this server");
  const target = await desktopTarget(deps.db, ANYWHERE, orgId, agentId, "desktop");
  if ("refused" in target) {
    if (target.refused === STREAM_CLOSE.notFound) {
      throw new NotFoundError("This agent has no desktop", `desktop.${target.reason}`);
    }
    throw new ConflictError("The desktop can't start on this agent's computer", `desktop.${target.reason}`);
  }
  await deps.hub.call<"desktop.session.start">(
    target.machineId,
    { op: "desktop.session.start", agent: target.agent },
    { timeoutMs: 30_000 },
  );
}

/** `POST …/desktop/stop` ("Desligar"): the same people as "Ligar". */
export async function stopDesktop(deps: DesktopDeps, userId: string, orgId: string, agentId: string) {
  await requireDesktopManager(deps.db, userId, orgId, agentId);
  await stopAgentBrowser(deps.db, deps.hub, userId, orgId, agentId, deps.pubsub, "desktop");
}

// ── Control on this server ────────────────────────────────────────────────────

export interface DesktopControlDeps {
  db: Database;
  pubsub?: PubSub;
  hub: Pick<MachineHub, "call" | "isLocal">;
  streams: Pick<StreamBroker, "closeWhere" | "some">;
  log?: { warn(message: string, data?: Record<string, unknown>): void };
}

/**
 * The desktops' side of handoffs on this server (ADR 0056 §5). When control
 * of an agent's desktop, or of the browser showing the same window, changes
 * hands (on any server), the streams here that may no longer show it close:
 * everyone else's while someone is in control (4409), and a control stream
 * whose holder lost control (4410). Their panels open again once it is handed
 * back. It also keeps the desktops of open handoffs from idling.
 */
export function createDesktopControl(deps: DesktopControlDeps) {
  /** Last keep-alive per open handoff. */
  const touched = new Map<string, number>();

  async function enforce(orgId: string, agentId: string) {
    const ofAgent = (s: Stream) => s.orgId === orgId && s.agentId === agentId && s.request.kind === "desktop";
    if (!deps.streams.some(ofAgent)) return;
    const open = await openHandoffOn(deps.db, orgId, agentId, "desktop");
    const controller = open?.status === "active" ? open.controllerUserId : null;
    const onDesktop = open?.screen === "desktop" ? controller : null;
    deps.streams.closeWhere(
      (s) => ofAgent(s) && controller !== null && s.userId !== controller,
      STREAM_CLOSE.hidden,
      "someone_in_control",
    );
    deps.streams.closeWhere(
      (s) => ofAgent(s) && s.request.kind === "desktop" && s.request.mode === "control" && s.userId !== onDesktop,
      STREAM_CLOSE.controlEnded,
      "control_ended",
    );
  }

  const off = deps.pubsub?.subscribe(BROWSER_HANDOFF_TOPIC, (event) => {
    if (event.type !== "browser.handoff.changed") return;
    if (typeof event.orgId !== "string" || typeof event.agentId !== "string") return;
    const { orgId, agentId } = event;
    void enforce(orgId, agentId).catch((error) =>
      deps.log?.warn("desktop control change failed", { agentId, error: String(error) }),
    );
  });

  return {
    /**
     * Keeps the desktops of open desktop handoffs running (worker, every
     * minute): a start every `HANDOFF_KEEPALIVE_MS` counts as use (and starts
     * one that stopped), so the runner's idle stop never ends a desktop a
     * person was asked to work on.
     */
    async keepAlive(now = Date.now()) {
      const open = await deps.db
        .select({
          id: browserHandoffs.id,
          agentId: browserHandoffs.agentId,
          machineId: browserHandoffs.machineId,
          handle: agents.handle,
        })
        .from(browserHandoffs)
        .innerJoin(agents, eq(agents.id, browserHandoffs.agentId))
        .where(and(eq(browserHandoffs.screen, "desktop"), inArray(browserHandoffs.status, ["pending", "active"])));
      const ids = new Set(open.map((h) => h.id));
      for (const id of touched.keys()) if (!ids.has(id)) touched.delete(id);
      // Only computers held here (each server keeps its own).
      const due = open.filter(
        (h) => deps.hub.isLocal(h.machineId) && now - (touched.get(h.id) ?? 0) >= HANDOFF_KEEPALIVE_MS,
      );
      for (const h of due) touched.set(h.id, now);
      await Promise.all(
        due.map((h) =>
          deps.hub
            .call(
              h.machineId,
              { op: "desktop.session.start", agent: { id: h.agentId, handle: h.handle } },
              { timeoutMs: 30_000 },
            )
            .catch(() => {}),
        ),
      );
      return due.length;
    },

    /** Stops hearing handoff changes (shutdown, tests). */
    close() {
      off?.();
    },
  };
}

export type DesktopControl = ReturnType<typeof createDesktopControl>;
