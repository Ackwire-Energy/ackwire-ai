import { randomBytes } from "node:crypto";
import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { type AiStatusDeps, orgHasAi } from "./ai-status";
import { caches } from "./cache";
import { decodeCursor, encodeCursor } from "./cursor";
import { type EmailLocale, emailLocale, emailsByLocale, queueEmail } from "./email";
import { ConflictError } from "./errors";
import { publishOrgEvent } from "./events";
import { DEVICE_CODE_TTL_MS, generateUserCode } from "./machine-device";
import { cleanMachineName, type MachineRow, machineOnline, removeMachine, sha256Hex } from "./machines";
import { notifyComputerReady } from "./notification-producers";
import { OrgCursor, orgCreatedAtMs } from "./operator";
import { requirePermission, USER_LOCALES } from "./organizations";
import { assertCanWork, OrgPausedError, STANDING_COLUMNS } from "./standing";

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
export const PROVISIONING_REASONS = ["capacity"] as const;
export type ProvisioningReason = (typeof PROVISIONING_REASONS)[number];
export type MachineSpecs = { cpus: number; memoryGb: number; diskGb: number };
export type ProvisioningMode = "off" | "external";

/** A wait longer than this gets the ready email: a spare claimed in seconds doesn't. */
export const READY_EMAIL_AFTER_MS = 60_000;

type ProvisioningRow = typeof machineProvisioning.$inferSelect;

export interface ProvisioningDeps {
  db: Database;
  pubsub?: PubSub;
  /** The server sends email (`EmailSender.delivers`): the apps tell the owners the ready email will come. */
  emails?: boolean;
}

/** Only the computer's first hello says `ready`, and only removing that computer undoes it. */
const notReady = sql`${machineProvisioning.state} <> 'ready'`;

/** There is no approval step: an older provisioner's `approval` (and a row it wrote) reads as `capacity`. */
const currentReason = (reason: string | null | undefined): ProvisioningReason | null =>
  reason == null ? null : reason === "approval" ? "capacity" : (reason as ProvisioningReason);

/** How far a workspace's computer is; nothing reported yet reads as `preparing`. */
export function provisioningStatus(row: ProvisioningRow | null, orgCreatedAt: Date) {
  return {
    state: (row?.state ?? "preparing") as ProvisioningState,
    step: (row?.step ?? null) as ProvisioningStep | null,
    /** With `preparing`: what the computer is doing within its step, as the provisioner said it. */
    stage: row?.stage ?? null,
    reason: currentReason(row?.reason),
    /** When this state (and step or reason) began; null before anything was reported. */
    since: row?.since.toISOString() ?? null,
    /** When people started waiting: the computer's last removal, else the workspace's creation. */
    requestedAt: (row?.requestedAt ?? orgCreatedAt).toISOString(),
    /** With `preparing`: when it should be ready; a time already past means any moment now. */
    expectedReadyAt: row?.expectedReadyAt?.toISOString() ?? null,
    specs: row?.specs ?? null,
  };
}

/**
 * How long the time left holds still after a report that moved the ready time later within a stage. A part running
 * past its time moves the provisioner's ready time later with the clock, one report at a time: counted down in
 * between, the time left would come back up at every report. A provisioner whose time keeps moving reports again
 * within this, so the time left stays as it said; one whose time stopped moving is counted down from then on.
 */
const STEADY_MS = 60_000;

/**
 * What the apps show (`GET …/computer-setup`, `machine.provisioning`): the status, the seconds left and the
 * seconds since `requestedAt`, both counted here (a wrong clock on someone's device doesn't matter), and
 * whether the owners get the ready email. After a report that moved the ready time later within a stage, the
 * seconds left are the ones it gave, still for `secondsSteady` of them, and counted down after that.
 */
function setupStatus(row: ProvisioningRow | null, orgCreatedAt: Date, emails: boolean, now = Date.now()) {
  const readyAt = row?.expectedReadyAt ?? null;
  const given = row?.delayedAt?.getTime() ?? now;
  const countsFrom = row?.delayedAt ? given + STEADY_MS : now;
  return {
    ...provisioningStatus(row, orgCreatedAt),
    secondsLeft: readyAt ? Math.round((readyAt.getTime() - given - Math.max(0, now - countsFrom)) / 1000) : null,
    secondsSteady: readyAt ? Math.round(Math.max(0, countsFrom - now) / 1000) : null,
    secondsWaited: Math.round((now - (row?.requestedAt ?? orgCreatedAt).getTime()) / 1000),
    notifyByEmail: emails,
  };
}

/** `machine.provisioning` to the workspace's members: what `GET …/computer-setup` would say now. */
async function publishProvisioning(
  deps: ProvisioningDeps,
  orgId: string,
  row: ProvisioningRow | null,
  machineId: string | null,
) {
  const [org] = await deps.db
    .select({ createdAt: organizations.createdAt })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  if (!org) return;
  await publishOrgEvent(deps.pubsub, {
    type: "org.broadcast",
    orgId,
    event: { type: "machine.provisioning", ...setupStatus(row, org.createdAt, deps.emails === true), machineId },
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
        provisioning: r.provisioning ? provisioningStatus(r.provisioning, r.createdAt) : null,
      };
    }),
    next: rows.length > query.limit && last ? encodeCursor([last.createdAt.toISOString(), last.orgId]) : null,
  };
}

export interface ProvisioningInput {
  state: Exclude<ProvisioningState, "ready">;
  /** Kept with `preparing` only. */
  step?: ProvisioningStep | null;
  /**
   * Kept with `preparing` only: what the computer is doing within its step (`updating`, `apps`…). Any word is kept:
   * the apps read one they don't know as its step.
   */
  stage?: string | null;
  /** Kept with `waiting` only; `approval` reads as `capacity`. */
  reason?: ProvisioningReason | "approval" | null;
  /** Kept with `preparing` only: when it should be ready. A time already past means any moment now. */
  expectedReadyAt?: Date | null;
  /** An older provisioner's countdown, read as that many seconds from now. */
  etaSeconds?: number | null;
  /** Kept from before when not given. */
  specs?: MachineSpecs | null;
}

/** How far ahead of this server's clock the provisioner's may run: its "now" can arrive that far in the future. */
const CLOCK_SKEW_MS = 15_000;

/**
 * When a report says it should be ready. While the last part runs over its estimate the provisioner keeps
 * sending the time of sending ("any moment now"): a time that is now by its clock never replaces a stored one
 * already past, so how long ago the first one was tells "almost ready" from "taking a little longer".
 */
function readyTime(input: ProvisioningInput, stored: Date | null, now: Date): Date | null {
  const reported =
    input.expectedReadyAt ?? (input.etaSeconds == null ? null : new Date(now.getTime() + input.etaSeconds * 1000));
  if (!reported) return null;
  const overdue = stored !== null && stored.getTime() <= now.getTime();
  return overdue && reported.getTime() <= now.getTime() + CLOCK_SKEW_MS ? stored : reported;
}

/**
 * The provisioner says how far the workspace's computer is; its members see it live (`machine.provisioning`)
 * when something they see changed. `ready` is not the provisioner's to say: it comes with the computer's
 * first hello, and stays until that computer is removed (`ConflictError` meanwhile). A wait said to take
 * over a minute (a ready time that far ahead, `waiting` or `problem`) promises the owners the ready email,
 * until it is ready. Only an active workspace waits for one (`OrgPausedError` otherwise): a report sent as it
 * was held would say again that a computer is on its way (`forgetProvisioning`). False: no such workspace.
 */
export async function setProvisioning(
  deps: ProvisioningDeps,
  orgId: string,
  input: ProvisioningInput,
): Promise<boolean> {
  const { db } = deps;
  // Read here, not from the 5 s cache: a hold set in another process a moment ago counts.
  const [org] = await db.select(STANDING_COLUMNS).from(organizations).where(eq(organizations.id, orgId));
  if (!org) return false;
  if (org.state !== "active") throw new OrgPausedError(org);
  const [before] = await db.select().from(machineProvisioning).where(eq(machineProvisioning.orgId, orgId));
  const now = new Date();
  const step = input.state === "preparing" ? (input.step ?? null) : null;
  const stage = input.state === "preparing" ? (input.stage ?? null) : null;
  const reason = input.state === "waiting" ? currentReason(input.reason) : null;
  const same = before?.state === input.state && before.step === step && currentReason(before.reason) === reason;
  const expectedReadyAt = input.state === "preparing" ? readyTime(input, before?.expectedReadyAt ?? null, now) : null;
  // Within one step and stage, a ready time moved later is a part running long (STEADY_MS); one left where it was
  // keeps counting down as it did.
  const was = same && before?.stage === stage ? before.expectedReadyAt?.getTime() : undefined;
  const at = expectedReadyAt?.getTime();
  const delayedAt =
    was === undefined || at === undefined || at < was ? null : at > was ? now : (before?.delayedAt ?? null);
  const long =
    input.state !== "preparing" ||
    (expectedReadyAt !== null && expectedReadyAt.getTime() - now.getTime() > READY_EMAIL_AFTER_MS);
  const next = {
    state: input.state,
    step,
    stage,
    reason,
    expectedReadyAt,
    delayedAt,
    emailWhenReady: long || before?.emailWhenReady === true,
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
  const moved = before?.expectedReadyAt?.getTime() !== row.expectedReadyAt?.getTime();
  // A new stage is told without restarting `since`: the step is still the same one.
  if (!same || before?.stage !== row.stage || moved || !Bun.deepEquals(before?.specs ?? null, row.specs)) {
    const [managed] = await db
      .select({ id: machines.id })
      .from(machines)
      .where(and(eq(machines.orgId, orgId), eq(machines.kind, "managed"), isNull(machines.deletedAt)));
    await publishProvisioning(deps, orgId, row, managed?.id ?? null);
  }
  return true;
}

/**
 * The workspace's computer's name until someone renames it, in its first owner's language: what the apps call
 * it (mirrors `computerSetup.title` in packages/i18n). A name like any computer's, so every message that names
 * it says a computer, never the bare workspace.
 */
export const managedMachineName = (orgName: string, locale: EmailLocale) =>
  cleanMachineName(locale === "en" ? `${orgName}'s computer` : `Computador da ${orgName}`);

/** The workspace was renamed: its computer, still under the name it got for the old one, takes the new one. */
export async function followWorkspaceName(db: Executor, orgId: string, from: string, to: string) {
  for (const locale of USER_LOCALES) {
    const [old, next] = [managedMachineName(from, locale), managedMachineName(to, locale)];
    if (old === next) continue;
    await db
      .update(machines)
      .set({ name: next, updatedAt: new Date() })
      .where(
        and(
          eq(machines.orgId, orgId),
          eq(machines.kind, "managed"),
          eq(machines.name, old),
          isNull(machines.deletedAt),
        ),
      );
  }
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
  const [owner] = await db
    .select({ locale: users.locale })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, "owner")))
    .orderBy(asc(organizationMembers.createdAt))
    .limit(1);
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
        name: name || managedMachineName(org.name, emailLocale(owner?.locale)),
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
 * working, its socket closes, its agents are left with no computer, and an active workspace is back to waiting
 * for one from now (a request again); one held or suspended waits for none until it is active again. False: the
 * workspace has no such managed computer.
 */
export async function revokeManagedMachine(deps: ProvisioningDeps, orgId: string, machineId: string) {
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
  const now = new Date();
  const waiting = {
    state: "preparing",
    step: null,
    stage: null,
    reason: null,
    expectedReadyAt: null,
    delayedAt: null,
    requestedAt: now,
    emailWhenReady: false,
    specs: null,
    since: now,
    updatedAt: now,
  };
  await removeMachine(deps, machine, { type: "system", id: null }, async (tx) => {
    await supersedeCodes(tx, machine.id, now);
    const [org] = await tx
      .select({ state: organizations.standing })
      .from(organizations)
      .where(eq(organizations.id, orgId));
    if (org?.state !== "active") {
      await tx.delete(machineProvisioning).where(eq(machineProvisioning.orgId, orgId));
      return;
    }
    await tx
      .insert(machineProvisioning)
      .values({ orgId, ...waiting })
      .onConflictDoUpdate({ target: machineProvisioning.orgId, set: waiting });
  });
  const [row] = await deps.db.select().from(machineProvisioning).where(eq(machineProvisioning.orgId, orgId));
  await publishProvisioning(deps, orgId, row ?? null, null);
  return true;
}

/**
 * The workspace left `active` (held, suspended, ended): it is no request (`listMachineRequests`), so what the
 * provisioner last said of its computer goes, and its people aren't told one is on its way. A ready computer
 * stays ready. Once active again it is a request like any other.
 */
export async function forgetProvisioning(deps: ProvisioningDeps, orgId: string) {
  const gone = await deps.db
    .delete(machineProvisioning)
    .where(and(eq(machineProvisioning.orgId, orgId), notReady))
    .returning({ orgId: machineProvisioning.orgId });
  if (gone.length === 0) return;
  const [managed] = await deps.db
    .select({ id: machines.id })
    .from(machines)
    .where(and(eq(machines.orgId, orgId), eq(machines.kind, "managed"), isNull(machines.deletedAt)));
  await publishProvisioning(deps, orgId, null, managed?.id ?? null);
}

/** What the ready email needs besides the database (the server sends email). */
export interface ReadyEmailDeps {
  publicUrl: string;
  /** What `orgHasAi` reads: the email's first step is connecting an AI while no agent has one. */
  gateway: AiStatusDeps["gateway"];
  machines: AiStatusDeps["machines"];
}

/**
 * What the ready email says, read before the transaction that queues it (`orgHasAi` asks the computers).
 * Null: nothing to send now, because the computer is ready already (a reconnect), the workspace isn't active
 * (its agents can't take a first task), or it has no owner.
 */
async function readyEmailDraft(db: Database, email: ReadyEmailDeps, orgId: string) {
  const [org] = await db
    .select({
      name: organizations.name,
      createdAt: organizations.createdAt,
      standing: organizations.standing,
      state: machineProvisioning.state,
    })
    .from(organizations)
    .leftJoin(machineProvisioning, eq(machineProvisioning.orgId, organizations.id))
    .where(eq(organizations.id, orgId));
  if (!org || org.state === "ready" || org.standing !== "active") return null;
  const owners = await db
    .select({ email: users.email, locale: users.locale })
    .from(organizationMembers)
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, "owner")));
  if (owners.length === 0) return null;
  const [agent] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), isNull(agents.archivedAt)))
    .limit(1);
  // Not known now: the step that connects an AI stays in, rather than the computer's ready going unsaid.
  const hasAi = await orgHasAi({ db, gateway: email.gateway, machines: email.machines }, orgId).catch(() => false);
  return { org, owners, hasAgents: Boolean(agent), needsAi: !hasAi, publicUrl: email.publicUrl };
}

/**
 * The ready email to the workspace's owners, each group in its language, once per ready (the notification's
 * group key), in the transaction that makes the computer ready: when they were told to expect it, or the
 * wait from `requested_at` (else the workspace's creation) took over a minute.
 */
async function queueReadyEmail(
  tx: Executor,
  draft: NonNullable<Awaited<ReturnType<typeof readyEmailDraft>>>,
  row: ProvisioningRow,
  machineId: string,
  readyAt: Date,
) {
  const waited = readyAt.getTime() - (row.requestedAt ?? draft.org.createdAt).getTime();
  if (!row.emailWhenReady && waited <= READY_EMAIL_AFTER_MS) return;
  const groups = emailsByLocale(
    draft.owners.map((o) => ({ email: o.email, locale: emailLocale(o.locale) })),
    `computer_ready:${machineId}:${readyAt.getTime()}`,
  );
  for (const group of groups) {
    await queueEmail(tx, {
      orgId: row.orgId,
      key: group.key,
      to: group.to,
      template: {
        kind: "computer_ready",
        locale: group.locale,
        orgName: draft.org.name,
        specs: row.specs ?? null,
        needsAi: draft.needsAi,
        hasAgents: draft.hasAgents,
        url: `${draft.publicUrl.replace(/\/$/, "")}/org/${row.orgId}`,
      },
    });
  }
}

/**
 * A managed computer said hello (the hub calls this for every machine). The first time since it was issued
 * it becomes the workspace's ready computer: the agents with no computer get it (later reconnects leave
 * whatever people chose since), its members hear it, and its owners are told (and emailed after a long
 * wait, when the server sends email: `readyEmail`).
 */
export async function onManagedMachineHello(
  deps: { db: Database; pubsub?: PubSub; readyEmail?: ReadyEmailDeps | null },
  machine: Pick<MachineRow, "id" | "orgId" | "name" | "kind">,
) {
  if (machine.kind !== "managed") return;
  const { orgId } = machine;
  const draft = deps.readyEmail ? await readyEmailDraft(deps.db, deps.readyEmail, orgId) : null;
  const now = new Date();
  const ready = {
    state: "ready",
    step: null,
    stage: null,
    reason: null,
    expectedReadyAt: null,
    delayedAt: null,
    since: now,
    updatedAt: now,
  };
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
    // The owners were told it would come: it goes out with the ready, or neither happens and the next hello
    // tries both again.
    if (draft) await queueReadyEmail(tx, draft, row, machine.id, now);
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
  const { readyEmail, ...rest } = deps;
  await publishProvisioning({ ...rest, emails: Boolean(readyEmail) }, orgId, done.row, machine.id);
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
 * far the workspace's computer is and, once issued, its machine id. `emails`: the server sends email.
 */
export async function computerSetup(
  db: Database,
  mode: ProvisioningMode,
  actorId: string,
  orgId: string,
  emails = false,
) {
  await requirePermission(db, actorId, orgId, "read");
  if (mode !== "external") {
    return {
      mode: "pair" as const,
      state: null,
      step: null,
      stage: null,
      reason: null,
      since: null,
      requestedAt: null,
      expectedReadyAt: null,
      specs: null,
      secondsLeft: null,
      secondsSteady: null,
      secondsWaited: null,
      notifyByEmail: false,
      machineId: null,
    };
  }
  const [row] = await db
    .select({ provisioning: machineProvisioning, machineId: machines.id, createdAt: organizations.createdAt })
    .from(organizations)
    .leftJoin(machineProvisioning, eq(machineProvisioning.orgId, organizations.id))
    .leftJoin(
      machines,
      and(eq(machines.orgId, organizations.id), eq(machines.kind, "managed"), isNull(machines.deletedAt)),
    )
    .where(eq(organizations.id, orgId));
  return {
    mode: "external" as const,
    ...setupStatus(row?.provisioning ?? null, row?.createdAt ?? new Date(), emails),
    machineId: row?.machineId ?? null,
  };
}
