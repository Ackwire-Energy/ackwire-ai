import { createHash, randomBytes } from "node:crypto";
import {
  HEARTBEAT_MS,
  MACHINE_TOKEN_PREFIX,
  type MachineAgent,
  MIN_RUNNER_PROTOCOL,
  type PubSub,
} from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNull, schema } from "@agenteschat/db";
import { getAgent } from "./agents";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import { can, requirePermission } from "./organizations";

const { machines, agents, users, organizationMembers } = schema;

/**
 * Connected computers (ADR 0025): the machine token, the list, pause and
 * access as the runner reports them (ADR 0036), and which computer each
 * agent uses. Connecting one is `machine-device.ts`; the live socket is the
 * hub's (`machine-hub.ts`); this file only reads and writes rows.
 */
export type MachineRow = typeof machines.$inferSelect;

/** A machine whose last sign of life is older than this is offline, whatever its row says (a replica may have died). */
export const MACHINE_STALE_MS = 3 * HEARTBEAT_MS;

export const MACHINE_LIMITS = { nameChars: 80 };

/**
 * Server-side signals (never forwarded to clients), for whichever replica
 * holds the machine's socket: `machine.revoke` closes it; `machine.agents`
 * sends the org's machines their `agents` frame again.
 */
export const MACHINE_CONTROL_TOPIC = "machines:control";

export interface MachineDeps {
  db: Database;
  pubsub?: PubSub;
  /** Our public base URL (the verification link). */
  publicUrl: string;
  now?: () => Date;
}

/** The machine can't be reached now (runner not connected). */
export class MachineOfflineError extends Error {
  constructor(readonly machineName: string) {
    super(`The computer ${machineName} is offline; ask its owner to start the runner.`);
    this.name = "MachineOfflineError";
  }
}

/**
 * The owner paused the machine (ADR 0036 §6): no new work starts there until
 * they resume (or `until` passes). The message is for the agent to relay.
 */
export class MachinePausedError extends Error {
  readonly code = "machine_paused";
  constructor(
    readonly machineName: string,
    /** ISO time, or null: until the owner resumes. */
    readonly until: string | null,
    timezone?: string | null,
  ) {
    super(pausedMessage(machineName, until, timezone));
    this.name = "MachinePausedError";
  }
}

/** "The owner paused the computer X until 16:24 (UTC)." in the owner's time zone when known. */
export function pausedMessage(name: string, until: string | null, timezone?: string | null, now = new Date()) {
  if (!until) return `The owner paused the computer ${name} until they resume it; nothing new can start there now.`;
  const at = new Date(until);
  const zone = timezone || "UTC";
  let when: string;
  try {
    const sameDay = at.getTime() - now.getTime() < 20 * 3600_000;
    when = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      ...(sameDay ? {} : { day: "numeric", month: "short" }),
    }).format(at);
  } catch {
    when = until.slice(11, 16);
  }
  return `The owner paused the computer ${name} until ${when}${zone === "UTC" ? " UTC" : ""}; nothing new can start there before that.`;
}

export const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

/** `agm_` + 32 random bytes, base64url. */
export const generateMachineToken = () => `${MACHINE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;

/** Online and seen recently: a row left `online` by a replica that died goes stale. */
export function machineOnline(row: Pick<MachineRow, "online" | "lastSeenAt" | "deletedAt">, now = new Date()) {
  if (!row.online || row.deletedAt || !row.lastSeenAt) return false;
  return now.getTime() - row.lastSeenAt.getTime() <= MACHINE_STALE_MS;
}

/** The pause in force now (a past `until` is over); null when not paused. */
export function machinePause(
  row: Pick<MachineRow, "paused" | "pausedUntil">,
  now = new Date(),
): { until: string | null } | null {
  if (!row.paused) return null;
  if (row.pausedUntil && row.pausedUntil.getTime() <= now.getTime()) return null;
  return { until: row.pausedUntil?.toISOString() ?? null };
}

/** The time zone the machine's owner reads times in (their own, else UTC). */
export async function machineOwnerTimezone(db: Database, row: Pick<MachineRow, "orgId" | "pairedByUserId">) {
  if (!row.pairedByUserId) return null;
  const [m] = await db
    .select({ timezone: organizationMembers.timezone })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, row.orgId), eq(organizationMembers.userId, row.pairedByUserId)));
  return m?.timezone ?? null;
}

/** Throws `MachinePausedError` when the owner paused this machine. */
export async function assertNotPaused(db: Database, row: MachineRow, now = new Date()) {
  const pause = machinePause(row, now);
  if (!pause) return;
  throw new MachinePausedError(row.name, pause.until, await machineOwnerTimezone(db, row).catch(() => null));
}

export const cleanMachineName = (name: string | undefined | null) =>
  (name ?? "")
    .replace(/[\p{Cc}]/gu, " ")
    .trim()
    .slice(0, MACHINE_LIMITS.nameChars);

/** `machine.status { machineId, online }` to every member of the org. */
export async function publishMachineStatus(
  pubsub: PubSub | undefined,
  orgId: string,
  machineId: string,
  online: boolean,
) {
  await publishOrgEvent(pubsub, { type: "org.broadcast", orgId, event: { type: "machine.status", machineId, online } });
}

/** The machine a token belongs to; null for unknown, revoked (deleted) or outdated runners. */
export async function authenticateMachine(db: Database, token: string): Promise<MachineRow | null> {
  if (!token.startsWith(MACHINE_TOKEN_PREFIX) || token.length > 200) return null;
  const [row] = await db
    .select()
    .from(machines)
    .where(and(eq(machines.tokenHash, sha256Hex(token)), isNull(machines.deletedAt)));
  if (!row || row.protocol < MIN_RUNNER_PROTOCOL) return null;
  return row;
}

export async function getMachine(db: Database, orgId: string, machineId: string): Promise<MachineRow | null> {
  const [row] = await db
    .select()
    .from(machines)
    .where(and(eq(machines.orgId, orgId), eq(machines.id, machineId), isNull(machines.deletedAt)));
  return row ?? null;
}

/** By id only (the hub and the provider: the id comes from our own rows). */
export async function getMachineById(db: Database, machineId: string): Promise<MachineRow | null> {
  const [row] = await db.select().from(machines).where(eq(machines.id, machineId));
  return row ?? null;
}

/**
 * The machines of an org as one person sees them: every member sees them;
 * the workspace path and the access report only admins and the pairer.
 */
async function machineViews(db: Database, actorId: string, orgId: string, only?: string, now = new Date()) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const admin = can(membership.role, "configure");
  const rows = await db
    .select({ machine: machines, pairedByName: users.name })
    .from(machines)
    .leftJoin(users, eq(users.id, machines.pairedByUserId))
    .where(and(eq(machines.orgId, orgId), isNull(machines.deletedAt), ...(only ? [eq(machines.id, only)] : [])))
    .orderBy(machines.createdAt);
  const ids = rows.map((r) => r.machine.id);
  const using = ids.length
    ? await db
        .select({ id: agents.id, name: agents.name, handle: agents.handle, machineId: agents.machineId })
        .from(agents)
        .where(and(eq(agents.orgId, orgId), inArray(agents.machineId, ids), isNull(agents.archivedAt)))
    : [];
  return rows.map(({ machine: m, pairedByName }) => {
    const mine = m.pairedByUserId === actorId;
    const pause = machinePause(m, now);
    return {
      id: m.id,
      name: m.name,
      online: machineOnline(m, now),
      lastSeenAt: m.lastSeenAt?.toISOString() ?? null,
      hostname: m.hostname,
      os: m.os,
      arch: m.arch,
      runnerVersion: m.runnerVersion,
      /** The runner's machine protocol (9+: pause; 10+: access on the machine). */
      protocol: m.protocol,
      execAllowed: m.execAllowed,
      /** The owner paused it (ADR 0036 §6); `until` null: until they resume. */
      paused: pause ? { until: pause.until } : null,
      pairedBy: m.pairedByUserId ? { id: m.pairedByUserId, name: pairedByName ?? "" } : null,
      agents: using.filter((a) => a.machineId === m.id).map((a) => ({ id: a.id, name: a.name, handle: a.handle })),
      /** Shown to admins and the person who paired it only. */
      workspace: admin || mine ? m.workspace : null,
      /** Folders and tools allowed on the machine (protocol 10); admins and the pairer only, null otherwise or unknown. */
      access: admin || mine ? (m.access ?? null) : null,
      /** Whether the agent browser can run there (protocol 12, ADR 0040); null when its runner doesn't say. */
      browser: m.executors?.browser
        ? {
            available: m.executors.browser.available,
            version: m.executors.browser.version ?? null,
            chrome: m.executors.browser.chrome ?? null,
            reason: m.executors.browser.reason ?? null,
          }
        : null,
      /** This person may rename, delete or reduce its access. */
      canManage: admin || mine,
      createdAt: m.createdAt.toISOString(),
    };
  });
}

/** `GET …/machines`. */
export function listMachines(db: Database, actorId: string, orgId: string, now = new Date()) {
  return machineViews(db, actorId, orgId, undefined, now);
}

export type MachineView = Awaited<ReturnType<typeof listMachines>>[number];

/** One machine as `actorId` sees it. */
export async function machineView(db: Database, actorId: string, orgId: string, machineId: string) {
  const [view] = await machineViews(db, actorId, orgId, machineId);
  if (!view) throw new NotFoundError("Computer not found", "machine.not_found");
  return view;
}

/** `machine.updated` to every member: what changed (no access details: those are for admins and the pairer). */
export async function publishMachineUpdated(
  pubsub: PubSub | undefined,
  orgId: string,
  machineId: string,
  change: Record<string, unknown>,
) {
  await publishOrgEvent(pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "machine.updated", machineId, ...change },
  });
}

/** The agents of the org pointed at this machine, as its `agents` frame lists them (protocol 9). */
export async function machineAgents(db: Database, orgId: string, machineId: string): Promise<MachineAgent[]> {
  const rows = await db
    .select({ id: agents.id, handle: agents.handle, name: agents.name, appearance: agents.appearance })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.machineId, machineId), isNull(agents.archivedAt)))
    .orderBy(agents.createdAt);
  return rows.map((a) => ({
    id: a.id,
    handle: a.handle,
    name: a.name,
    ...(a.appearance
      ? { look: { color: a.appearance.color, eyes: a.appearance.eyes, accessory: a.appearance.accessory } }
      : {}),
  }));
}

/**
 * The agents on the org's machines changed (pointed at or away, renamed, a
 * new look, archived): the replica holding each machine's socket sends its
 * `agents` frame again.
 */
export async function publishMachineAgentsChanged(pubsub: PubSub | undefined, orgId: string) {
  await pubsub?.publish(MACHINE_CONTROL_TOPIC, { type: "machine.agents", orgId }).catch(() => undefined);
}

/** The person who paired it, or an admin (`configure`). */
export async function requireMachineManager(db: Database, actorId: string, orgId: string, machineId: string) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const machine = await getMachine(db, orgId, machineId);
  if (!machine) throw new NotFoundError("Computer not found", "machine.not_found");
  if (!can(membership.role, "configure") && machine.pairedByUserId !== actorId) {
    throw new ForbiddenError(
      "Only an admin or the person who connected this computer can change it",
      "machine.forbidden",
    );
  }
  return machine;
}

export async function renameMachine(
  deps: Pick<MachineDeps, "db" | "pubsub">,
  actorId: string,
  orgId: string,
  machineId: string,
  input: { name: string },
) {
  const machine = await requireMachineManager(deps.db, actorId, orgId, machineId);
  const name = cleanMachineName(input.name);
  if (!name) throw new ValidationError("Give the computer a name", "machine.name_required");
  await deps.db.update(machines).set({ name, updatedAt: new Date() }).where(eq(machines.id, machine.id));
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "machine.renamed",
    target: { type: "machine", id: machine.id },
    details: { from: machine.name, to: name },
  });
  await publishMachineUpdated(deps.pubsub, orgId, machine.id, { name });
  return { id: machine.id, name };
}

/**
 * Removes a machine: its token stops working, its socket is closed
 * (`refused: revoked`, on whichever replica holds it), and agents that used
 * it go back to the cloud computer (remembered in `previous_agent_ids`, so
 * reconnecting the same computer gives them back). Soft delete, audited.
 */
export async function deleteMachine(
  deps: Pick<MachineDeps, "db" | "pubsub">,
  actorId: string,
  orgId: string,
  machineId: string,
) {
  const machine = await requireMachineManager(deps.db, actorId, orgId, machineId);
  const now = new Date();
  const freed = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(agents)
      // Its accounts (ADR 0041) stay with it: the agents leave them.
      .set({ machineId: null, brainAccountId: null, updatedAt: now })
      .where(and(eq(agents.orgId, orgId), eq(agents.machineId, machine.id)))
      .returning({ id: agents.id });
    const ids = rows.map((r) => r.id);
    // Remembered so reconnecting this computer gives them back (`confirmDeviceCode`).
    await tx
      .update(machines)
      .set({
        deletedAt: now,
        tokenHash: null,
        online: false,
        connectedReplica: null,
        previousAgentIds: ids,
        updatedAt: now,
      })
      .where(eq(machines.id, machine.id));
    return ids;
  });
  for (const agentId of freed) caches.agents.delete(`${orgId}:${agentId}`);
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "machine.deleted",
    target: { type: "machine", id: machine.id },
    details: { name: machine.name, agents: freed },
  });
  await deps.pubsub
    ?.publish(MACHINE_CONTROL_TOPIC, { type: "machine.revoke", machineId: machine.id })
    .catch(() => undefined);
  await publishOrgEvent(deps.pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "machine.deleted", machineId: machine.id },
  });
  for (const agentId of freed) {
    await publishOrgEvent(deps.pubsub, {
      type: "org.broadcast",
      orgId,
      event: { type: "agent.computer", agentId, target: { kind: "cloud" } },
    });
  }
}

/** Which computer an agent uses (`GET …/computer` `target`). */
export type ComputerTarget = { kind: "cloud" } | { kind: "machine"; machineId: string; name: string; online: boolean };

export async function computerTarget(db: Database, orgId: string, agentId: string): Promise<ComputerTarget> {
  const agent = await getAgent(db, orgId, agentId);
  if (!agent?.machineId) return { kind: "cloud" };
  const machine = await getMachine(db, orgId, agent.machineId);
  if (!machine) return { kind: "cloud" };
  return { kind: "machine", machineId: machine.id, name: machine.name, online: machineOnline(machine) };
}

/**
 * Points an agent at a connected machine (or back to the cloud computer with
 * null). An admin (`manage_agents`) may; so may the agent's owner when they
 * paired that machine (going back to the cloud only needs the owner).
 */
export async function setAgentComputerTarget(
  deps: Pick<MachineDeps, "db" | "pubsub">,
  actorId: string,
  orgId: string,
  agentId: string,
  machineId: string | null,
): Promise<ComputerTarget> {
  const membership = await requirePermission(deps.db, actorId, orgId, "read");
  const agent = await getAgent(deps.db, orgId, agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  const admin = can(membership.role, "manage_agents");
  const machine = machineId ? await getMachine(deps.db, orgId, machineId) : null;
  if (machineId && !machine) throw new NotFoundError("Computer not found", "machine.not_found");
  if (!admin) {
    if (agent.ownerUserId !== actorId) {
      throw new ForbiddenError("Only an admin or the agent's owner can choose its computer", "machine.forbidden");
    }
    if (machine && machine.pairedByUserId !== actorId) {
      throw new ForbiddenError(
        "You can only give your agent a computer you connected yourself; ask an admin for this one",
        "machine.forbidden",
      );
    }
  }
  const moved = (machine?.id ?? null) !== agent.machineId;
  await deps.db
    .update(agents)
    .set({
      machineId: machine?.id ?? null,
      // An account is a folder on one computer (ADR 0041): another computer starts on its own sign-in.
      ...(moved ? { brainAccountId: null } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
  caches.agents.delete(`${orgId}:${agentId}`);
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "agent.computer_target",
    target: { type: "agent", id: agentId },
    details: { from: agent.machineId, to: machine?.id ?? null, name: machine?.name ?? null },
  });
  const target: ComputerTarget = machine
    ? { kind: "machine", machineId: machine.id, name: machine.name, online: machineOnline(machine) }
    : { kind: "cloud" };
  await publishOrgEvent(deps.pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "agent.computer", agentId, target },
  });
  // The machine it left and the one it joined list their agents again (protocol 9).
  await publishMachineAgentsChanged(deps.pubsub, orgId);
  return target;
}
