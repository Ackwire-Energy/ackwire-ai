import { randomBytes } from "node:crypto";
import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { caches } from "./cache";
import { decodeCursor, encodeCursor } from "./cursor";
import { ConflictError } from "./errors";
import { publishOrgEvent } from "./events";
import { DEVICE_CODE_TTL_MS, generateUserCode } from "./machine-device";
import { cleanMachineName, type MachineRow, machineOnline, removeMachine, sha256Hex } from "./machines";
import { notifyComputerReady } from "./notification-producers";
import { OrgCursor, orgCreatedAtMs } from "./operator";
import { requirePermission } from "./organizations";
import { assertCanWork } from "./standing";

const { organizations, organizationMembers, users, machines, machineProvisioning, machineDeviceCodes, agents } = schema;

/**
 * The workspace's own computer, from a provisioner the operator runs (ADR 0056 §10), with
 * `MACHINE_PROVISIONING=external`. Pulled, never pushed: every active workspace without a ready computer is
 * a request the provisioner lists; it says how far it is (`setProvisioning`) and asks for a single-use code
 * (`issueManagedMachine`) that the computer redeems through the device-code flow (`pollDeviceToken`), so the
 * computer's own token never passes through the provisioner. That computer's first hello makes it ready
 * and gives it the workspace's agents that have no computer.
 */

export const PROVISIONING_STATES = ["preparing", "waiting", "problem", "ready"] as const;
export type ProvisioningState = (typeof PROVISIONING_STATES)[number];
export const PROVISIONING_STEPS = ["reserving", "starting", "installing", "connecting"] as const;
export type ProvisioningStep = (typeof PROVISIONING_STEPS)[number];
export const PROVISIONING_REASONS = ["approval", "capacity"] as const;
export type ProvisioningReason = (typeof PROVISIONING_REASONS)[number];
export type MachineSpecs = { cpus: number; memoryGb: number; diskGb: number };
export type ProvisioningMode = "off" | "external";

type ProvisioningRow = typeof machineProvisioning.$inferSelect;

/** Only the computer's first hello says `ready`, and only removing that computer undoes it. */
const notReady = sql`${machineProvisioning.state} <> 'ready'`;

/** How far a workspace's computer is; nothing reported yet reads as `preparing`. */
export function provisioningStatus(row: ProvisioningRow | null) {
  return {
    state: (row?.state ?? "preparing") as ProvisioningState,
    step: (row?.step ?? null) as ProvisioningStep | null,
    reason: (row?.reason ?? null) as ProvisioningReason | null,
    /** When this state (and step or reason) began; null before anything was reported. */
    since: row?.since.toISOString() ?? null,
    etaSeconds: row?.etaSeconds ?? null,
    specs: row?.specs ?? null,
  };
}

/** `machine.provisioning` to the workspace's members: what `GET …/computer-setup` would say now. */
async function publishProvisioning(
  pubsub: PubSub | undefined,
  orgId: string,
  row: ProvisioningRow | null,
  machineId: string | null,
) {
  await publishOrgEvent(pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "machine.provisioning", ...provisioningStatus(row), machineId },
  });
}

/**
 * Workspaces waiting for their computer, oldest first, in keyset pages: active ones (one on hold or
 * suspended is never listed) whose computer isn't ready. Empty unless provisioning is external.
 */
export async function listMachineRequests(
  db: Database,
  mode: ProvisioningMode,
  query: { limit: number; cursor?: string },
) {
  if (mode !== "external") return { requests: [], next: null };
  const after = query.cursor ? decodeCursor(query.cursor, OrgCursor) : null;
  const rows = await db
    .select({
      orgId: organizations.id,
      orgName: organizations.name,
      createdAt: orgCreatedAtMs,
      provisioning: machineProvisioning,
    })
    .from(organizations)
    .leftJoin(machineProvisioning, eq(machineProvisioning.orgId, organizations.id))
    .where(
      and(
        eq(organizations.standing, "active"),
        sql`${machineProvisioning.state} is distinct from 'ready'`,
        after
          ? sql`(${orgCreatedAtMs}, ${organizations.id}) > (${after[0]}::timestamptz, ${after[1]}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(orgCreatedAtMs), asc(organizations.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const owners = page.length
    ? await db
        .select({ orgId: organizationMembers.orgId, userId: users.id, email: users.email })
        .from(organizationMembers)
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .where(
          and(
            inArray(
              organizationMembers.orgId,
              page.map((r) => r.orgId),
            ),
            eq(organizationMembers.role, "owner"),
          ),
        )
        .orderBy(asc(organizationMembers.createdAt))
    : [];
  const last = page.at(-1);
  return {
    requests: page.map((r) => {
      const owner = owners.find((o) => o.orgId === r.orgId);
      return {
        orgId: r.orgId,
        orgName: r.orgName,
        createdAt: r.createdAt,
        /** Its first owner. */
        owner: owner ? { userId: owner.userId, email: owner.email } : null,
        /** What the provisioner last said; null before anything. */
        provisioning: r.provisioning ? provisioningStatus(r.provisioning) : null,
      };
    }),
    next: rows.length > query.limit && last ? encodeCursor([last.createdAt.toISOString(), last.orgId]) : null,
  };
}

export interface ProvisioningInput {
  state: Exclude<ProvisioningState, "ready">;
  /** Kept with `preparing` only. */
  step?: ProvisioningStep | null;
  /** Kept with `waiting` only. */
  reason?: ProvisioningReason | null;
  etaSeconds?: number | null;
  /** Kept from before when not given. */
  specs?: MachineSpecs | null;
}

/**
 * The provisioner says how far the workspace's computer is; its members see it live (`machine.provisioning`)
 * when something they see changed. `ready` is not the provisioner's to say: it comes with the computer's
 * first hello, and stays until that computer is removed (`ConflictError` meanwhile). False: no such workspace.
 */
export async function setProvisioning(
  deps: { db: Database; pubsub?: PubSub },
  orgId: string,
  input: ProvisioningInput,
): Promise<boolean> {
  const { db } = deps;
  const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgId));
  if (!org) return false;
  const [before] = await db.select().from(machineProvisioning).where(eq(machineProvisioning.orgId, orgId));
  const now = new Date();
  const step = input.state === "preparing" ? (input.step ?? null) : null;
  const reason = input.state === "waiting" ? (input.reason ?? null) : null;
  const same = before?.state === input.state && before.step === step && before.reason === reason;
  const next = {
    state: input.state,
    step,
    reason,
    etaSeconds: input.etaSeconds ?? null,
    specs: input.specs ?? before?.specs ?? null,
    since: same && before ? before.since : now,
    updatedAt: now,
  };
  const [row] = await db
    .insert(machineProvisioning)
    .values({ orgId, ...next })
    .onConflictDoUpdate({ target: machineProvisioning.orgId, set: next, setWhere: notReady })
    .returning();
  if (!row) {
    throw new ConflictError(
      "This workspace's computer is ready: remove it first (DELETE …/machines/{machineId}) to prepare another one",
      "provisioning.ready",
    );
  }
  if (!same || before?.etaSeconds !== row.etaSeconds || !Bun.deepEquals(before?.specs ?? null, row.specs)) {
    const [managed] = await db
      .select({ id: machines.id })
      .from(machines)
      .where(and(eq(machines.orgId, orgId), eq(machines.kind, "managed"), isNull(machines.deletedAt)));
    await publishProvisioning(deps.pubsub, orgId, row, managed?.id ?? null);
  }
  return true;
}

/** Codes issued for this computer and not redeemed yet stop working (a poll with one gets `access_denied`). */
async function supersedeCodes(tx: Executor, machineId: string, now: Date) {
  await tx
    .update(machineDeviceCodes)
    .set({ status: "denied", decidedAt: now })
    .where(and(eq(machineDeviceCodes.machineId, machineId), eq(machineDeviceCodes.status, "confirmed")));
}

/**
 * The workspace's computer and a code for it to connect with: the managed machine row (one per workspace,
 * made the first time, the same row every time after, brought back when it was removed) and a confirmed
 * device code for it, single use, `DEVICE_CODE_TTL_MS`. The computer redeems it like any other
 * (`POST /api/machines/device/token`); an earlier code still unused stops working. Only for an active
 * workspace (`OrgPausedError` otherwise). Null: no such workspace.
 */
export async function issueManagedMachine(
  deps: { db: Database; now?: () => Date },
  orgId: string,
  input: { name?: string | null } = {},
) {
  const { db } = deps;
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org) return null;
  await assertCanWork(db, orgId);
  const now = deps.now?.() ?? new Date();
  const enrollCode = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + DEVICE_CODE_TTL_MS);
  const name = cleanMachineName(input.name);
  const machineId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(machines)
      .values({
        orgId,
        kind: "managed",
        name: name || cleanMachineName(org.name) || "Computer",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: machines.orgId,
        targetWhere: sql`${machines.kind} = 'managed'`,
        set: { deletedAt: null, previousAgentIds: [], ...(name ? { name } : {}), updatedAt: now },
      })
      .returning({ id: machines.id, name: machines.name });
    if (!row) throw new Error("managed machine upsert returned nothing");
    await supersedeCodes(tx, row.id, now);
    await tx.insert(machineDeviceCodes).values({
      orgId,
      deviceCodeHash: sha256Hex(enrollCode),
      userCode: generateUserCode(),
      status: "confirmed",
      name: row.name,
      machineId: row.id,
      // An expired code never takes the row with it (`pollDeviceToken` keeps a machine coming back as itself).
      previousMachineId: row.id,
      decidedAt: now,
      expiresAt,
      createdAt: now,
    });
    return row.id;
  });
  return { machineId, enrollCode, expiresAt };
}

/**
 * The workspace's computers as the provisioner sees them: every machine still in it, with no secret and
 * nothing of what is on them. Null: no such workspace.
 */
export async function operatorMachines(db: Database, orgId: string) {
  const [org] = await db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, orgId));
  if (!org) return null;
  const rows = await db
    .select()
    .from(machines)
    .where(and(eq(machines.orgId, orgId), isNull(machines.deletedAt)))
    .orderBy(asc(machines.createdAt));
  return rows.map((m) => ({
    id: m.id,
    kind: m.kind,
    managed: m.kind === "managed",
    name: m.name,
    online: machineOnline(m),
    lastSeenAt: m.lastSeenAt,
    runnerVersion: m.runnerVersion,
    protocol: m.protocol,
  }));
}

/**
 * Takes the workspace's computer away (the provisioner wipes or retires it): its token and unused codes stop
 * working, its socket closes, its agents are left with no computer, and the workspace is back to waiting for
 * one (a request again while it is active). False: the workspace has no such managed computer.
 */
export async function revokeManagedMachine(deps: { db: Database; pubsub?: PubSub }, orgId: string, machineId: string) {
  const [machine] = await deps.db
    .select()
    .from(machines)
    .where(
      and(
        eq(machines.orgId, orgId),
        eq(machines.id, machineId),
        eq(machines.kind, "managed"),
        isNull(machines.deletedAt),
      ),
    );
  if (!machine) return false;
  await removeMachine(deps, machine, { type: "system", id: null }, async (tx) => {
    await supersedeCodes(tx, machine.id, new Date());
    await tx.delete(machineProvisioning).where(eq(machineProvisioning.orgId, orgId));
  });
  await publishProvisioning(deps.pubsub, orgId, null, null);
  return true;
}

/**
 * A managed computer said hello (the hub calls this for every machine). The first time since it was issued
 * it becomes the workspace's ready computer: the agents with no computer get it (later reconnects leave
 * whatever people chose since), its members hear it, and its owners are told.
 */
export async function onManagedMachineHello(
  deps: { db: Database; pubsub?: PubSub },
  machine: Pick<MachineRow, "id" | "orgId" | "name" | "kind">,
) {
  if (machine.kind !== "managed") return;
  const { orgId } = machine;
  const now = new Date();
  const ready = { state: "ready", step: null, reason: null, etaSeconds: null, since: now, updatedAt: now };
  const done = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(machineProvisioning)
      .values({ orgId, ...ready })
      .onConflictDoUpdate({ target: machineProvisioning.orgId, set: ready, setWhere: notReady })
      .returning();
    if (!row) return null;
    const given = await tx
      .update(agents)
      .set({ machineId: machine.id, updatedAt: now })
      .where(and(eq(agents.orgId, orgId), isNull(agents.machineId), isNull(agents.archivedAt)))
      .returning({ id: agents.id });
    return { row, agentIds: given.map((a) => a.id) };
  });
  if (!done) return;
  for (const agentId of done.agentIds) {
    caches.agents.delete(`${orgId}:${agentId}`);
    await publishOrgEvent(deps.pubsub, {
      type: "org.broadcast",
      orgId,
      event: {
        type: "agent.computer",
        agentId,
        target: { kind: "machine", machineId: machine.id, name: machine.name, online: true },
      },
    });
  }
  await publishProvisioning(deps.pubsub, orgId, done.row, machine.id);
  await notifyComputerReady(deps, machine, now).catch(() => {});
}

/** Whether the workspace's computer is on its way (reported, not ready): agents say so instead of "no computer". */
export async function computerPreparing(db: Database, orgId: string) {
  const [row] = await db
    .select({ state: machineProvisioning.state })
    .from(machineProvisioning)
    .where(eq(machineProvisioning.orgId, orgId));
  return Boolean(row && row.state !== "ready");
}

/**
 * `GET …/computer-setup` (every member): `pair` when people connect their own computers; `external`, how
 * far the workspace's computer is and, once issued, its machine id.
 */
export async function computerSetup(db: Database, mode: ProvisioningMode, actorId: string, orgId: string) {
  await requirePermission(db, actorId, orgId, "read");
  if (mode !== "external") {
    return {
      mode: "pair" as const,
      state: null,
      step: null,
      reason: null,
      since: null,
      etaSeconds: null,
      specs: null,
      machineId: null,
    };
  }
  const [row] = await db
    .select({ provisioning: machineProvisioning, machineId: machines.id })
    .from(organizations)
    .leftJoin(machineProvisioning, eq(machineProvisioning.orgId, organizations.id))
    .leftJoin(
      machines,
      and(eq(machines.orgId, organizations.id), eq(machines.kind, "managed"), isNull(machines.deletedAt)),
    )
    .where(eq(organizations.id, orgId));
  return {
    mode: "external" as const,
    ...provisioningStatus(row?.provisioning ?? null),
    machineId: row?.machineId ?? null,
  };
}
