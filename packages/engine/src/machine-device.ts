import { randomBytes, randomInt } from "node:crypto";
import { type MachineOs, MIN_RUNNER_PROTOCOL, type PubSub } from "@agenteschat/adapters";
import { and, count, type Database, eq, gt, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "./audit";
import { ForbiddenError, isUniqueViolation, NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import {
  cleanMachineName,
  generateMachineToken,
  type MachineView,
  machineView,
  publishMachineAgentsChanged,
  sha256Hex,
} from "./machines";
import { notifyMachineConnected } from "./notification-producers";
import { can, getMembership } from "./organizations";

const { machineDeviceCodes, machines, organizations } = schema;

/**
 * Connecting a computer (ADR 0036 §5): a device-code flow like OAuth's. The
 * computer (the desktop app or `agentes-runner pair`) asks for a code, shows
 * it with a link, and polls; a signed-in person opens the link, compares the
 * code, picks the organization and confirms (or says "it wasn't me"). The
 * machine row is made on confirm, with no token yet; the token is issued to
 * the computer's next poll, exactly once, and only its hash is kept.
 *
 * Against a link sent by someone else (device-code phishing): 10 minutes,
 * single use, the page shows what asked and from roughly where, admins are
 * notified of every new computer, and a new computer gets no agents until
 * someone points one at it.
 */
export type DeviceCodeRow = typeof machineDeviceCodes.$inferSelect;

/** A code lives this long. */
export const DEVICE_CODE_TTL_MS = 10 * 60_000;
/** Seconds the computer waits between polls (`slow_down` when faster). */
export const DEVICE_POLL_INTERVAL_S = 3;
/** Pending codes one address may hold at once. */
export const DEVICE_MAX_PENDING_PER_IP = 10;
/** No letters or digits people confuse (0/O, 1/I/L). */
export const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const USER_CODE_LENGTH = 6;

/** Polls this much earlier than the interval still count as on time (network jitter). */
const POLL_SLACK_MS = 750;
const OSES: MachineOs[] = ["linux", "darwin", "windows"];

export interface DeviceDeps {
  db: Database;
  pubsub?: PubSub;
  now?: () => Date;
}

/** One address holds too many pending codes (the route answers 429). */
export class DeviceCodeLimitError extends Error {
  constructor() {
    super("Too many pending connection codes from this address; wait a few minutes and try again.");
    this.name = "DeviceCodeLimitError";
  }
}

/** `K7Q4ZP`: uniform over the alphabet (`randomInt` has no modulo bias). */
export function generateUserCode() {
  let code = "";
  for (let i = 0; i < USER_CODE_LENGTH; i++) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return code;
}

/** A user code as people may type or paste it (`k7q·4zp`, `K7Q-4ZP`): letters and digits, upper case. */
export const normalizeUserCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** `K7Q·4ZP`, how both sides show it. */
export const formatUserCode = (code: string) => `${code.slice(0, 3)}·${code.slice(3)}`;

export interface DeviceStartInput {
  name: string;
  os: string;
  arch: string;
  hostname: string;
  version: string;
  /** Optional extras a runner may send; copied to the machine (its `hello` updates them anyway). */
  protocol?: number;
  workspace?: string;
  exec?: boolean;
}

export interface DeviceRequester {
  ip: string;
  /** Best effort, from the requesting address ("São Paulo, BR"); absent when unknown. */
  approxLocation?: string | null;
}

const nowOf = (deps: { now?: () => Date }) => deps.now?.() ?? new Date();

/**
 * `POST /api/machines/device` (no session): a new code for the computer.
 * At most `DEVICE_MAX_PENDING_PER_IP` pending codes per address.
 */
export async function startDeviceCode(
  deps: DeviceDeps & { publicUrl: string },
  input: DeviceStartInput,
  requester: DeviceRequester,
) {
  if (input.protocol !== undefined && input.protocol < MIN_RUNNER_PROTOCOL) {
    throw new ValidationError("This runner is too old; download the latest one", "machine.outdated");
  }
  const now = nowOf(deps);
  const ip = requester.ip.slice(0, 100);
  const [pending] = await deps.db
    .select({ n: count() })
    .from(machineDeviceCodes)
    .where(
      and(
        eq(machineDeviceCodes.requesterIp, ip),
        eq(machineDeviceCodes.status, "pending"),
        gt(machineDeviceCodes.expiresAt, now),
      ),
    );
  if (Number(pending?.n ?? 0) >= DEVICE_MAX_PENDING_PER_IP) throw new DeviceCodeLimitError();
  const deviceCode = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + DEVICE_CODE_TTL_MS);
  for (let attempt = 0; ; attempt++) {
    const userCode = generateUserCode();
    try {
      await deps.db.insert(machineDeviceCodes).values({
        deviceCodeHash: sha256Hex(deviceCode),
        userCode,
        name: cleanMachineName(input.name),
        os: OSES.find((o) => o === input.os) ?? "other",
        arch: input.arch.slice(0, 40),
        hostname: input.hostname.slice(0, 200),
        runnerVersion: input.version.slice(0, 40),
        ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
        ...(input.workspace !== undefined ? { workspace: input.workspace.slice(0, 500) } : {}),
        ...(input.exec !== undefined ? { execAllowed: input.exec } : {}),
        requesterIp: ip,
        approxLocation: requester.approxLocation?.slice(0, 120) || null,
        expiresAt,
        createdAt: now,
      });
      const base = deps.publicUrl.replace(/\/+$/, "");
      return {
        deviceCode,
        userCode,
        verificationUrl: `${base}/conectar?code=${userCode}`,
        expiresIn: DEVICE_CODE_TTL_MS / 1000,
        interval: DEVICE_POLL_INTERVAL_S,
      };
    } catch (error) {
      // Another pending code has the same user code (rare): draw again.
      if (!isUniqueViolation(error) || attempt >= 4) throw error;
    }
  }
}

export type DeviceTokenError = "authorization_pending" | "slow_down" | "access_denied" | "expired_token";

export type DeviceTokenResult =
  | { ok: true; token: string; machineId: string; name: string; org: { id: string; name: string } }
  | { ok: false; error: DeviceTokenError };

/**
 * `POST /api/machines/device/token` (no session): the computer's poll.
 * Pending until confirmed (`slow_down` when polled faster than the
 * interval), `access_denied` after "it wasn't me", `expired_token` after 10
 * minutes or once the token was taken. Confirmed: the machine's token, once.
 */
export async function pollDeviceToken(deps: DeviceDeps, deviceCode: string): Promise<DeviceTokenResult> {
  const now = nowOf(deps);
  const [row] = await deps.db
    .select()
    .from(machineDeviceCodes)
    .where(eq(machineDeviceCodes.deviceCodeHash, sha256Hex(deviceCode)));
  if (!row) return { ok: false, error: "expired_token" };
  if (row.status === "denied") return { ok: false, error: "access_denied" };
  if (row.status === "redeemed") return { ok: false, error: "expired_token" };
  if (row.expiresAt.getTime() <= now.getTime()) {
    // Confirmed but never collected: the machine made on confirm can't ever connect.
    if (row.status === "confirmed" && row.machineId) await dropUncollected(deps, row, now);
    return { ok: false, error: "expired_token" };
  }
  if (row.status === "pending") {
    const early =
      row.lastPolledAt !== null &&
      now.getTime() - row.lastPolledAt.getTime() < DEVICE_POLL_INTERVAL_S * 1000 - POLL_SLACK_MS;
    await deps.db
      .update(machineDeviceCodes)
      .set({ lastPolledAt: now })
      .where(eq(machineDeviceCodes.id, row.id))
      .catch(() => undefined);
    return { ok: false, error: early ? "slow_down" : "authorization_pending" };
  }
  // Confirmed: the token goes out once (two polls racing: one wins).
  const token = generateMachineToken();
  const issued = await deps.db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(machineDeviceCodes)
      .set({ status: "redeemed", lastPolledAt: now })
      .where(and(eq(machineDeviceCodes.id, row.id), eq(machineDeviceCodes.status, "confirmed")))
      .returning();
    if (!claimed?.machineId || !claimed.orgId) return null;
    const [machine] = await tx
      .update(machines)
      .set({ tokenHash: sha256Hex(token), updatedAt: now })
      .where(and(eq(machines.id, claimed.machineId), eq(machines.orgId, claimed.orgId), isNull(machines.deletedAt)))
      .returning();
    // Removed on the site before the computer collected it.
    if (!machine) return null;
    const [org] = await tx
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, machine.orgId));
    return { machine, org: org ?? { id: machine.orgId, name: "" } };
  });
  if (!issued) return { ok: false, error: "expired_token" };
  await recordAudit(deps.db, {
    orgId: issued.machine.orgId,
    actor: { type: "person", id: row.confirmedByUserId },
    action: "machine.paired",
    target: { type: "machine", id: issued.machine.id },
    details: { name: issued.machine.name, hostname: issued.machine.hostname, os: issued.machine.os },
  });
  return { ok: true, token, machineId: issued.machine.id, name: issued.machine.name, org: issued.org };
}

/** A machine whose code expired before the computer took its token: removed (it has no token to connect with). */
async function dropUncollected(deps: DeviceDeps, row: DeviceCodeRow, now: Date) {
  if (!row.machineId || !row.orgId) return;
  const [dropped] = await deps.db
    .update(machines)
    .set({ deletedAt: now, updatedAt: now })
    .where(
      and(
        eq(machines.id, row.machineId),
        eq(machines.orgId, row.orgId),
        isNull(machines.tokenHash),
        isNull(machines.deletedAt),
      ),
    )
    .returning({ id: machines.id });
  if (!dropped) return;
  await publishOrgEvent(deps.pubsub, {
    type: "org.broadcast",
    orgId: row.orgId,
    event: { type: "machine.deleted", machineId: row.machineId },
  });
}

/** A pending, unexpired code by what the person typed or followed; null otherwise. */
async function pendingCode(db: Database, userCode: string, now: Date) {
  const code = normalizeUserCode(userCode);
  if (code.length !== USER_CODE_LENGTH) return null;
  const [row] = await db
    .select()
    .from(machineDeviceCodes)
    .where(
      and(
        eq(machineDeviceCodes.userCode, code),
        eq(machineDeviceCodes.status, "pending"),
        gt(machineDeviceCodes.expiresAt, now),
      ),
    );
  return row ?? null;
}

const notFound = () =>
  new NotFoundError("This code is unknown or expired; start again on the computer", "machine.device_not_found");

/** What the confirm page shows (`GET /api/app/machines/device/{userCode}`), for any signed-in person. */
export async function getDeviceCode(deps: DeviceDeps, userCode: string) {
  const row = await pendingCode(deps.db, userCode, nowOf(deps));
  if (!row) throw notFound();
  return deviceCodeView(row);
}

export function deviceCodeView(row: DeviceCodeRow) {
  return {
    userCode: row.userCode,
    name: row.name,
    os: row.os,
    arch: row.arch,
    hostname: row.hostname,
    version: row.runnerVersion,
    approxLocation: row.approxLocation ?? null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

export type DeviceCodeView = ReturnType<typeof deviceCodeView>;

/**
 * `POST …/organizations/{orgId}/machines/device/{userCode}/confirm`: a member
 * who can post connects the computer to this organization. The machine is
 * made now (no token yet, no agents), the org's admins are notified, and the
 * computer gets its token on its next poll.
 */
export async function confirmDeviceCode(
  deps: DeviceDeps,
  actorId: string,
  orgId: string,
  userCode: string,
  input: { name?: string | null },
): Promise<MachineView> {
  const membership = await getMembership(deps.db, actorId, orgId);
  if (!membership) throw new ForbiddenError("You are not a member of this organization");
  if (!can(membership.role, "post")) {
    throw new ForbiddenError(
      "Only members who can post in the organization can connect a computer",
      "machine.forbidden",
    );
  }
  const now = nowOf(deps);
  const code = normalizeUserCode(userCode);
  const machine = await deps.db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(machineDeviceCodes)
      .set({ status: "confirmed", orgId, confirmedByUserId: actorId, decidedAt: now })
      .where(
        and(
          eq(machineDeviceCodes.userCode, code),
          eq(machineDeviceCodes.status, "pending"),
          gt(machineDeviceCodes.expiresAt, now),
        ),
      )
      .returning();
    if (!claimed) return null;
    const name = cleanMachineName(input.name) || claimed.name || claimed.hostname.slice(0, 80) || "Computer";
    const [row] = await tx
      .insert(machines)
      .values({
        orgId,
        name,
        pairedByUserId: actorId,
        hostname: claimed.hostname,
        os: claimed.os,
        arch: claimed.arch,
        runnerVersion: claimed.runnerVersion,
        ...(claimed.protocol !== null ? { protocol: claimed.protocol } : {}),
        ...(claimed.workspace !== null ? { workspace: claimed.workspace } : {}),
        ...(claimed.execAllowed !== null ? { execAllowed: claimed.execAllowed } : {}),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error("machine insert returned nothing");
    await tx.update(machineDeviceCodes).set({ machineId: row.id }).where(eq(machineDeviceCodes.id, claimed.id));
    return { row, ip: claimed.requesterIp, location: claimed.approxLocation };
  });
  if (!machine) throw notFound();
  const { row } = machine;
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "machine.connected",
    target: { type: "machine", id: row.id },
    details: {
      name: row.name,
      hostname: row.hostname,
      os: row.os,
      arch: row.arch,
      ip: machine.ip,
      ...(machine.location ? { location: machine.location } : {}),
    },
  });
  await publishOrgEvent(deps.pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "machine.paired", machineId: row.id, name: row.name },
  });
  await publishMachineAgentsChanged(deps.pubsub, orgId);
  await notifyMachineConnected(deps, row, actorId).catch(() => undefined);
  return machineView(deps.db, actorId, orgId, row.id);
}

/** `POST /api/app/machines/device/{userCode}/deny` ("Não fui eu"): the computer's next poll gets `access_denied`. */
export async function denyDeviceCode(deps: DeviceDeps, actorId: string, userCode: string) {
  const now = nowOf(deps);
  const [denied] = await deps.db
    .update(machineDeviceCodes)
    .set({ status: "denied", confirmedByUserId: actorId, decidedAt: now })
    .where(
      and(
        eq(machineDeviceCodes.userCode, normalizeUserCode(userCode)),
        eq(machineDeviceCodes.status, "pending"),
        gt(machineDeviceCodes.expiresAt, now),
      ),
    )
    .returning({ id: machineDeviceCodes.id });
  if (!denied) throw notFound();
}
