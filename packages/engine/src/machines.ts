import { createHash, randomBytes } from "node:crypto";
import {
  HEARTBEAT_MS,
  MACHINE_TOKEN_PREFIX,
  type MachineOs,
  MIN_RUNNER_PROTOCOL,
  normalizePairingCode,
  type PubSub,
} from "@agenteschat/adapters";
import { and, type Database, eq, gt, inArray, isNull, schema } from "@agenteschat/db";
import { getAgent } from "./agents";
import { recordAudit } from "./audit";
import { caches } from "./cache";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import { can, getMembership, requirePermission } from "./organizations";

const { machines, machinePairings, agents, users } = schema;

/**
 * Connected computers (ADR 0025): pairing, the machine token, the list, and
 * which computer each agent uses. The live socket is the hub's
 * (`machine-hub.ts`); this file only reads and writes rows.
 */
export type MachineRow = typeof machines.$inferSelect;

/** A pairing code lives this long. */
export const PAIRING_TTL_MS = 10 * 60_000;
/** No letters or digits people confuse (0/O, 1/I). */
export const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** A machine whose last sign of life is older than this is offline, whatever its row says (a replica may have died). */
export const MACHINE_STALE_MS = 3 * HEARTBEAT_MS;

export const MACHINE_LIMITS = { nameChars: 80 };

/** Server-side signal (never forwarded to clients): close a machine's socket wherever it is. */
export const MACHINE_CONTROL_TOPIC = "machines:control";

export interface MachineDeps {
  db: Database;
  pubsub?: PubSub;
  /** Our public base URL (the install command). */
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

export const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

/** `XXXX-XXXX` from the alphabet above (32 symbols: one random byte each, no bias). */
export function generatePairingCode() {
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** `agm_` + 32 random bytes, base64url. */
export const generateMachineToken = () => `${MACHINE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;

/** Online and seen recently: a row left `online` by a replica that died goes stale. */
export function machineOnline(row: Pick<MachineRow, "online" | "lastSeenAt" | "deletedAt">, now = new Date()) {
  if (!row.online || row.deletedAt || !row.lastSeenAt) return false;
  return now.getTime() - row.lastSeenAt.getTime() <= MACHINE_STALE_MS;
}

const cleanName = (name: string | undefined | null) =>
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

/**
 * A member who can post creates a one-time code (10 minutes) and the
 * install command to run on the machine. Only the code's hash is stored.
 */
export async function createMachinePairing(deps: MachineDeps, actorId: string, orgId: string, input: { name: string }) {
  const membership = await getMembership(deps.db, actorId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
  if (!can(membership.role, "post")) {
    throw new ForbiddenError(
      "Only members who can post in the organization can connect a computer",
      "machine.forbidden",
    );
  }
  const name = cleanName(input.name);
  if (!name) throw new ValidationError("Give the computer a name", "machine.name_required");
  const code = generatePairingCode();
  const now = deps.now?.() ?? new Date();
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
  await deps.db.insert(machinePairings).values({
    orgId,
    codeHash: sha256Hex(normalizePairingCode(code)),
    name,
    createdByUserId: actorId,
    expiresAt,
    createdAt: now,
  });
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "machine.pairing_created",
    target: { type: "organization", id: orgId },
    details: { name },
  });
  const base = deps.publicUrl.replace(/\/$/, "");
  return {
    code,
    expiresAt: expiresAt.toISOString(),
    installCommand: `curl -fsSL ${base}/api/machines/install.sh | sh -s -- --code ${code}`,
  };
}

export interface RedeemInput {
  code: string;
  name?: string | null;
  hostname: string;
  os: string;
  arch: string;
  version: string;
  protocol: number;
  workspace: string;
  exec: boolean;
}

const OSES: MachineOs[] = ["linux", "darwin", "windows"];

/**
 * `POST /api/machines/pair`: trades a valid code (single use, atomically) for
 * a machine and its token. Wrong, used and expired codes all get the same
 * answer. The token is returned once; only its hash is kept.
 */
export async function redeemMachinePairing(deps: Omit<MachineDeps, "publicUrl">, input: RedeemInput) {
  if (input.protocol < MIN_RUNNER_PROTOCOL) {
    throw new ValidationError("This runner is too old; download the latest one and pair again", "machine.outdated");
  }
  const now = deps.now?.() ?? new Date();
  const [pairing] = await deps.db
    .update(machinePairings)
    .set({ usedAt: now })
    .where(
      and(
        eq(machinePairings.codeHash, sha256Hex(normalizePairingCode(input.code))),
        isNull(machinePairings.usedAt),
        gt(machinePairings.expiresAt, now),
      ),
    )
    .returning();
  if (!pairing) {
    throw new ValidationError("This pairing code is invalid or expired; create a new one", "machine.pairing_invalid");
  }
  const token = generateMachineToken();
  const name = cleanName(input.name) || pairing.name;
  const [machine] = await deps.db
    .insert(machines)
    .values({
      orgId: pairing.orgId,
      name,
      pairedByUserId: pairing.createdByUserId,
      tokenHash: sha256Hex(token),
      hostname: input.hostname.slice(0, 200),
      os: OSES.find((o) => o === input.os) ?? "other",
      arch: input.arch.slice(0, 40),
      runnerVersion: input.version.slice(0, 40),
      protocol: input.protocol,
      workspace: input.workspace.slice(0, 500),
      execAllowed: input.exec !== false,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!machine) throw new Error("machine insert returned nothing");
  await deps.db.update(machinePairings).set({ machineId: machine.id }).where(eq(machinePairings.id, pairing.id));
  await recordAudit(deps.db, {
    orgId: pairing.orgId,
    actor: { type: "person", id: pairing.createdByUserId },
    action: "machine.paired",
    target: { type: "machine", id: machine.id },
    details: { name, hostname: machine.hostname, os: machine.os, arch: machine.arch, exec: machine.execAllowed },
  });
  await publishOrgEvent(deps.pubsub, {
    type: "org.broadcast",
    orgId: pairing.orgId,
    event: { type: "machine.paired", machineId: machine.id, name },
  });
  return { machineId: machine.id, name, token };
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

/** `GET …/machines`: every member sees the org's machines; the workspace path only for admins and the pairer. */
export async function listMachines(db: Database, actorId: string, orgId: string, now = new Date()) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const admin = can(membership.role, "configure");
  const rows = await db
    .select({ machine: machines, pairedByName: users.name })
    .from(machines)
    .leftJoin(users, eq(users.id, machines.pairedByUserId))
    .where(and(eq(machines.orgId, orgId), isNull(machines.deletedAt)))
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
    return {
      id: m.id,
      name: m.name,
      online: machineOnline(m, now),
      lastSeenAt: m.lastSeenAt?.toISOString() ?? null,
      hostname: m.hostname,
      os: m.os,
      arch: m.arch,
      runnerVersion: m.runnerVersion,
      execAllowed: m.execAllowed,
      pairedBy: m.pairedByUserId ? { id: m.pairedByUserId, name: pairedByName ?? "" } : null,
      agents: using.filter((a) => a.machineId === m.id).map((a) => ({ id: a.id, name: a.name, handle: a.handle })),
      /** Shown to admins and the person who paired it only. */
      workspace: admin || mine ? m.workspace : null,
      /** This person may rename or delete it. */
      canManage: admin || mine,
      createdAt: m.createdAt.toISOString(),
    };
  });
}

export type MachineView = Awaited<ReturnType<typeof listMachines>>[number];

/** The person who paired it, or an admin (`configure`). */
async function requireMachineManager(db: Database, actorId: string, orgId: string, machineId: string) {
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
  const name = cleanName(input.name);
  if (!name) throw new ValidationError("Give the computer a name", "machine.name_required");
  await deps.db.update(machines).set({ name, updatedAt: new Date() }).where(eq(machines.id, machine.id));
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "machine.renamed",
    target: { type: "machine", id: machine.id },
    details: { from: machine.name, to: name },
  });
  await publishOrgEvent(deps.pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "machine.updated", machineId: machine.id, name },
  });
  return { id: machine.id, name };
}

/**
 * Removes a machine: its token stops working, its socket is closed
 * (`refused: revoked`, on whichever replica holds it), and agents that used
 * it go back to the cloud computer. Soft delete, audited.
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
      .set({ machineId: null, updatedAt: now })
      .where(and(eq(agents.orgId, orgId), eq(agents.machineId, machine.id)))
      .returning({ id: agents.id });
    await tx
      .update(machines)
      .set({ deletedAt: now, tokenHash: null, online: false, connectedReplica: null, updatedAt: now })
      .where(eq(machines.id, machine.id));
    return rows.map((r) => r.id);
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
  await deps.db
    .update(agents)
    .set({ machineId: machine?.id ?? null, updatedAt: new Date() })
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
  return target;
}
