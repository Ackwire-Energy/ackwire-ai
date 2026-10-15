import {
  maskProvider,
  type PubSub,
  SandboxGoneError,
  type SandboxInfo,
  type SandboxProvider,
  type SandboxResources,
} from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema, sql } from "@agenteschat/db";
import { getAgent, getAgentCached } from "./agents";
import { recordAudit } from "./audit";
import { BudgetExceededError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import { agentBudgetState } from "./gateway";
import { can, requirePermission } from "./organizations";
import { enqueue } from "./outbox";
import type { ToolContext } from "./tools/types";
import { monthStartUtc } from "./usage";

const { sandboxes, orgSandboxSettings, sandboxUsageDays, usageRecords, agentBudgetPeriods } = schema;

/** The scope of the sandbox tools: never granted by default, and not covered by "all tools" (D30). */
export const SANDBOX_SCOPE = "sandbox:run";

export const SANDBOX_LIMITS = {
  maxTimeoutSeconds: 600,
  stdoutChars: 20_000,
  stderrChars: 8_000,
  fileReadChars: 40_000,
  maxFileBytes: 5 * 1024 * 1024,
  codeChars: 100_000,
  maxAllowDomains: 100,
};

export interface SandboxPricing {
  vcpuHourUsd: number;
  memoryGibHourUsd: number;
  diskGibHourUsd: number;
}

export interface SandboxDeps {
  db: Database;
  provider: SandboxProvider;
  pricing: SandboxPricing;
  autoStopMinutes: number;
  /** A stopped computer is archived (cheaper storage, files kept) after this many days; never deleted. */
  archiveAfterDays: number;
  now?: () => Date;
}

export type SandboxSettings = Omit<typeof orgSandboxSettings.$inferSelect, "orgId" | "updatedAt">;

export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {
  enabled: true,
  allowDomains: [],
  network: "blocked",
  execTimeoutSeconds: 60,
  dailyMinutes: 120,
  requireApproval: false,
};

/** The sandbox can't be used now (off, daily cap): the tool says why. */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

export async function getSandboxSettings(db: Database, orgId: string): Promise<SandboxSettings> {
  return (await settingsRow(db, orgId)).settings;
}

/** The settings and when they last changed (null = never set: the defaults). */
async function settingsRow(db: Database, orgId: string) {
  const [row] = await db.select().from(orgSandboxSettings).where(eq(orgSandboxSettings.orgId, orgId));
  if (!row) return { settings: { ...DEFAULT_SANDBOX_SETTINGS }, updatedAt: null as Date | null };
  const { orgId: _o, updatedAt, ...settings } = row;
  return { settings, updatedAt };
}

const DOMAIN = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,63}$/;

/** Org settings (admins, `configure`). Domains are checked; limits are clamped. */
export async function updateSandboxSettings(
  db: Database,
  actorId: string,
  orgId: string,
  patch: Partial<SandboxSettings>,
): Promise<SandboxSettings> {
  await requirePermission(db, actorId, orgId, "configure");
  const current = await getSandboxSettings(db, orgId);
  const allowDomains = patch.allowDomains
    ? [...new Set(patch.allowDomains.map((d) => d.trim().toLowerCase()).filter(Boolean))]
    : current.allowDomains;
  if (allowDomains.length > SANDBOX_LIMITS.maxAllowDomains) throw new ValidationError("At most 100 domains");
  const bad = allowDomains.find((d) => !DOMAIN.test(d));
  if (bad) throw new ValidationError(`Not a domain: ${bad} (use pypi.org or *.example.com)`);
  // The mode: given, or (old clients that only send domains) follows the list, unless it's open.
  const network =
    patch.network ??
    (patch.allowDomains !== undefined && current.network !== "open"
      ? allowDomains.length > 0
        ? "allowlist"
        : "blocked"
      : current.network);
  if (!["blocked", "allowlist", "open"].includes(network)) throw new ValidationError("Unknown network mode");
  if (network === "allowlist" && allowDomains.length === 0) {
    throw new ValidationError("Libere pelo menos um domínio, ou escolha sem internet ou internet liberada.");
  }
  const next: SandboxSettings = {
    enabled: patch.enabled ?? current.enabled,
    allowDomains,
    network,
    execTimeoutSeconds: Math.min(
      SANDBOX_LIMITS.maxTimeoutSeconds,
      Math.max(5, patch.execTimeoutSeconds ?? current.execTimeoutSeconds),
    ),
    dailyMinutes: Math.min(24 * 60, Math.max(0, patch.dailyMinutes ?? current.dailyMinutes)),
    requireApproval: patch.requireApproval ?? current.requireApproval,
  };
  await db
    .insert(orgSandboxSettings)
    .values({ orgId, ...next })
    .onConflictDoUpdate({ target: orgSandboxSettings.orgId, set: { ...next, updatedAt: new Date() } });
  await recordAudit(db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "sandbox.settings_updated",
    target: { type: "organization", id: orgId },
    details: { ...next },
  });
  return next;
}

/** Cost in nano-USD of `seconds` of a sandbox with these resources. */
export function sandboxCostNanoUsd(seconds: number, r: SandboxResources, p: SandboxPricing) {
  const perHour = r.cpu * p.vcpuHourUsd + r.memoryGiB * p.memoryGibHourUsd + r.diskGiB * p.diskGibHourUsd;
  return Math.ceil((seconds / 3600) * perHour * 1e9);
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** One computer per agent: the same machine (and `/workspace`) in every conversation. */
export const computerKey = (agentId: string) => `agent:${agentId}`;

type SandboxRow = typeof sandboxes.$inferSelect;

/**
 * Refuses before anything runs: sandbox off for the org, the org's daily
 * minutes used up, or the agent's monthly budget can't cover `seconds`.
 */
async function checkLimits(deps: SandboxDeps, ctx: ToolContext, settings: SandboxSettings, seconds: number) {
  const now = deps.now?.() ?? new Date();
  if (!settings.enabled)
    throw new SandboxUnavailableError("The agents' computers are turned off for this organization.");
  const [day] = await deps.db
    .select({ seconds: sandboxUsageDays.seconds })
    .from(sandboxUsageDays)
    .where(and(eq(sandboxUsageDays.orgId, ctx.orgId), eq(sandboxUsageDays.day, dayOf(now))));
  if ((day?.seconds ?? 0) >= settings.dailyMinutes * 60) {
    throw new SandboxUnavailableError(
      `The organization used its ${settings.dailyMinutes} computer minutes for today; it resets at 00:00 UTC.`,
    );
  }
  const agent = await getAgentCached(deps.db, ctx.orgId, ctx.agentId);
  if (!agent) throw new NotFoundError("Agent not found");
  if (agent.monthlyBudgetNanoUsd !== null) {
    const state = await agentBudgetState(deps.db, ctx.orgId, ctx.agentId, now);
    const estimate = sandboxCostNanoUsd(seconds, { cpu: 1, memoryGiB: 1, diskGiB: 3 }, deps.pricing);
    if (state.spentNanoUsd + state.reservedNanoUsd + estimate > agent.monthlyBudgetNanoUsd) {
      throw new BudgetExceededError(agent.id, state.spentNanoUsd, agent.monthlyBudgetNanoUsd);
    }
  }
}

async function liveComputer(db: Database, orgId: string, agentId: string) {
  const [row] = await db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.orgId, orgId), eq(sandboxes.key, computerKey(agentId)), isNull(sandboxes.deletedAt)));
  return row ?? null;
}

type Previous = "running" | "stopped" | "new" | "recreated";

/**
 * The agent's computer, running: started again if it stopped or was
 * archived, created on first use. Only when the provider lost it is a new
 * (empty) one made, and the caller is told (`recreated`).
 */
async function acquire(
  deps: SandboxDeps,
  orgId: string,
  agentId: string,
  settings: SandboxSettings & { updatedAt?: Date | null },
  actor: { type: "agent" | "person"; id: string },
  onStep?: (step: "creating" | "preparing") => void | Promise<void>,
): Promise<{ row: SandboxRow; info: SandboxInfo; previous: Previous }> {
  const { db, provider } = deps;
  const key = computerKey(agentId);
  const live = await liveComputer(db, orgId, agentId);
  let lost = false;
  // A row without a provider id is a computer being created (`POST …/computer/start`): fill it in.
  const placeholder = live && !live.providerId ? live : null;
  if (live && !placeholder) {
    await onStep?.("preparing");
    try {
      const before = await provider.get(live.providerId);
      const wasRunning = before?.state === "started";
      let info = await provider.ensureStarted(live.providerId);
      if (!wasRunning) {
        await db.update(sandboxes).set({ status: "running", updatedAt: new Date() }).where(eq(sandboxes.id, live.id));
      }
      // The org changed its network setting since this computer last got it: apply it now, in place.
      const stale =
        live.network !== settings.network ||
        (settings.updatedAt && (!live.networkAppliedAt || live.networkAppliedAt < settings.updatedAt));
      if (stale) info = { ...info, network: await applyNetwork(deps, live, settings) };
      return { row: live, info, previous: wasRunning ? "running" : "stopped" };
    } catch (error) {
      if (!(error instanceof SandboxGoneError)) throw error;
      lost = true;
      await db
        .update(sandboxes)
        .set({ status: "deleted", deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(sandboxes.id, live.id));
    }
  }
  await onStep?.("creating");
  const info = await provider.create({
    key: `${orgId}:${key}`,
    labels: { "agentes.org": orgId, "agentes.agent": agentId },
    allowDomains: settings.allowDomains,
    network: settings.network,
    autoStopMinutes: deps.autoStopMinutes,
    autoArchiveMinutes: deps.archiveAfterDays * 24 * 60,
  });
  const machine = {
    provider: provider.id,
    providerId: info.id,
    networkAppliedAt: new Date(),
    status: "running",
    lastError: null,
    network: info.network,
    cpu: Math.round(info.resources.cpu),
    memoryGib: Math.round(info.resources.memoryGiB),
    diskGib: Math.round(info.resources.diskGiB),
  };
  const [row] = placeholder
    ? await db
        .update(sandboxes)
        .set({ ...machine, updatedAt: new Date() })
        .where(eq(sandboxes.id, placeholder.id))
        .returning()
    : await db
        .insert(sandboxes)
        .values({ orgId, agentId, key, ...machine })
        .onConflictDoNothing()
        .returning();
  if (!row) {
    // Another run of this agent created it at the same time: use that one.
    await provider.destroy(info.id).catch(() => undefined);
    return acquire(deps, orgId, agentId, settings, actor);
  }
  await recordAudit(db, {
    orgId,
    actor,
    action: lost ? "sandbox.recreated" : "sandbox.created",
    target: { type: "sandbox", id: row.id },
    details: { provider: provider.id, network: info.network, agentId },
  });
  return { row, info, previous: lost ? "recreated" : "new" };
}

/** Applies the org's network mode to a running computer and records it. */
async function applyNetwork(
  deps: Pick<SandboxDeps, "db" | "provider">,
  row: SandboxRow,
  settings: SandboxSettings,
): Promise<SandboxInfo["network"]> {
  const applied = await deps.provider.setNetwork(row.providerId, settings.network, settings.allowDomains);
  await deps.db
    .update(sandboxes)
    .set({ network: applied, networkAppliedAt: new Date(), updatedAt: new Date() })
    .where(eq(sandboxes.id, row.id));
  return applied;
}

/**
 * After the org changes its network setting: every running computer gets it
 * now (Daytona changes it in place, no restart, files untouched); stopped or
 * archived ones get it the next time they start.
 */
export async function applyOrgNetwork(deps: Pick<SandboxDeps, "db" | "provider">, orgId: string) {
  const { settings } = await settingsRow(deps.db, orgId);
  const rows = await deps.db
    .select()
    .from(sandboxes)
    .where(and(eq(sandboxes.orgId, orgId), isNull(sandboxes.deletedAt)));
  let applied = 0;
  let later = 0;
  for (const row of rows) {
    if (!row.providerId) continue;
    const info = await deps.provider.get(row.providerId).catch(() => null);
    if (info?.state !== "started") {
      later++;
      continue;
    }
    try {
      await applyNetwork(deps, row, settings);
      applied++;
    } catch {
      later++;
    }
  }
  return { applied, later };
}

/** Told to the agent (and so to the people) when the provider lost the computer and a new one was made. */
export const RECREATED_NOTICE =
  "Note: your computer was lost by the provider and a new, empty one was created; files from before are gone. Tell the people you're working with.";

/**
 * Records computer time like a model call: a usage row (`sandbox`) with
 * org and agent, the agent's monthly counter, the computer's own total and
 * the org's day. Billed time is the call itself plus the idle time the
 * computer stayed up since its last use (until it auto-stopped).
 */
async function charge(deps: SandboxDeps, ctx: ToolContext, row: SandboxRow, info: SandboxInfo, seconds: number) {
  const now = deps.now?.() ?? new Date();
  const cost = sandboxCostNanoUsd(seconds, info.resources, deps.pricing);
  await deps.db.insert(usageRecords).values({
    orgId: ctx.orgId,
    agentId: ctx.agentId,
    kind: "sandbox",
    runId: ctx.runId,
    credentialId: null,
    provider: row.provider,
    model: "sandbox",
    requestedModel: "sandbox",
    inputTokens: 0,
    outputTokens: 0,
    costNanoUsd: cost,
    billedTo: "org",
    createdAt: now,
  });
  await deps.db
    .insert(agentBudgetPeriods)
    .values({
      orgId: ctx.orgId,
      agentId: ctx.agentId,
      periodStart: monthStartUtc(now).toISOString().slice(0, 10),
      spentNanoUsd: cost,
    })
    .onConflictDoUpdate({
      target: [agentBudgetPeriods.agentId, agentBudgetPeriods.periodStart],
      set: { spentNanoUsd: sql`${agentBudgetPeriods.spentNanoUsd} + ${cost}`, updatedAt: now },
    });
  await deps.db
    .update(sandboxes)
    .set({
      billedSeconds: sql`${sandboxes.billedSeconds} + ${seconds}`,
      costNanoUsd: sql`${sandboxes.costNanoUsd} + ${cost}`,
      status: "running",
      lastUsedAt: now,
      updatedAt: now,
    })
    .where(eq(sandboxes.id, row.id));
  await deps.db
    .insert(sandboxUsageDays)
    .values({ orgId: ctx.orgId, day: dayOf(now), seconds, costNanoUsd: cost })
    .onConflictDoUpdate({
      target: [sandboxUsageDays.orgId, sandboxUsageDays.day],
      set: {
        seconds: sql`${sandboxUsageDays.seconds} + ${seconds}`,
        costNanoUsd: sql`${sandboxUsageDays.costNanoUsd} + ${cost}`,
      },
    });
  return cost;
}

/**
 * Runs `fn` on the agent's computer, after the limits, and charges the
 * time. `budgetSeconds` is the most the call may take (its timeout).
 * `onNotice` hears about a recreated computer.
 */
export async function withSandbox<T>(
  deps: SandboxDeps,
  ctx: ToolContext,
  budgetSeconds: number,
  fn: (sandboxId: string) => Promise<T>,
  onNotice?: (notice: string) => void,
): Promise<T> {
  const { settings, updatedAt } = await settingsRow(deps.db, ctx.orgId);
  await checkLimits(deps, ctx, settings, budgetSeconds);
  const clock = () => (deps.now?.() ?? new Date()).getTime();
  const { row, info, previous } = await acquire(
    deps,
    ctx.orgId,
    ctx.agentId,
    { ...settings, updatedAt },
    {
      type: "agent",
      id: ctx.agentId,
    },
  );
  if (previous === "recreated") onNotice?.(RECREATED_NOTICE);
  const started = clock();
  const idleCap = deps.autoStopMinutes * 60;
  const sinceLast = Math.max(0, Math.round((started - row.lastUsedAt.getTime()) / 1000));
  // Up since its last use: that gap; it had auto-stopped: the idle tail before stopping.
  const idle = previous === "running" ? Math.min(sinceLast, idleCap) : previous === "stopped" ? idleCap : 0;
  try {
    return await fn(info.id);
  } finally {
    const used = Math.max(1, Math.ceil((clock() - started) / 1000));
    await charge(deps, ctx, row, info, used + idle).catch(() => undefined);
  }
}

export type ComputerStatus = "starting" | "running" | "stopping" | "stopped" | "archived" | "error" | "none";

/** `GET …/agents/{id}/computer`, exactly what the app shows. */
export interface AgentComputerView {
  status: ComputerStatus;
  diskUsedGib: number;
  costMonthUsd: number;
  createdAt: string | null;
  lastUsedAt: string | null;
  network?: "blocked" | "allowlist" | "open" | "provider-default";
  error?: { message: string };
}

/** The agent's owner or an admin (`manage_agents`). */
async function requireComputerManager(db: Database, actorId: string, orgId: string, agentId: string) {
  const membership = await requirePermission(db, actorId, orgId, "read");
  const agent = await getAgent(db, orgId, agentId);
  if (!agent || agent.archivedAt) throw new NotFoundError("Agent not found");
  if (!can(membership.role, "manage_agents") && agent.ownerUserId !== actorId) {
    throw new ForbiddenError("Only an admin or the agent's owner can manage its computer");
  }
}

const STATUS: Record<string, ComputerStatus> = {
  started: "running",
  creating: "starting",
  starting: "starting",
  stopped: "stopped",
  archived: "archived",
  error: "error",
};

/**
 * `agent.computer { agentId, status, step?, error? }` to the organization
 * (every member can see its agents), on each change.
 */
export async function publishComputerEvent(
  pubsub: PubSub | undefined,
  orgId: string,
  event: { agentId: string; status: ComputerStatus; step?: "creating" | "preparing" | "ready"; error?: string },
) {
  await publishOrgEvent(pubsub, {
    type: "org.broadcast",
    orgId,
    event: {
      type: "agent.computer",
      agentId: event.agentId,
      status: event.status,
      ...(event.step ? { step: event.step } : {}),
      ...(event.error ? { error: { message: event.error } } : {}),
    },
  });
}

async function computerView(
  deps: Pick<SandboxDeps, "db" | "provider">,
  orgId: string,
  agentId: string,
  row: SandboxRow | null,
): Promise<AgentComputerView> {
  const [spent] = await deps.db
    .select({ total: sql<string>`coalesce(sum(${usageRecords.costNanoUsd}), 0)` })
    .from(usageRecords)
    .where(
      and(
        eq(usageRecords.orgId, orgId),
        eq(usageRecords.agentId, agentId),
        eq(usageRecords.kind, "sandbox"),
        sql`${usageRecords.createdAt} >= ${monthStartUtc(new Date()).toISOString()}::timestamptz`,
      ),
    );
  const costMonthUsd = Number(spent?.total ?? 0) / 1e9;
  if (!row) return { status: "none", diskUsedGib: 0, costMonthUsd, createdAt: null, lastUsedAt: null };
  const base = {
    diskUsedGib: Math.round((row.diskUsedMib / 1024) * 100) / 100,
    costMonthUsd,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt.toISOString(),
    network: row.network as AgentComputerView["network"],
  };
  // Work in progress (a job is on it) or a failed start: answer from the row, no provider call.
  if (row.status === "starting" || row.status === "stopping" || row.status === "error" || !row.providerId) {
    const status = (row.providerId ? row.status : row.status === "error" ? "error" : "starting") as ComputerStatus;
    return { ...base, status, ...(row.lastError ? { error: { message: row.lastError } } : {}) };
  }
  const info = await deps.provider.get(row.providerId).catch(() => null);
  const status: ComputerStatus = info ? (STATUS[info.state] ?? "stopped") : "none";
  let diskMib = row.diskUsedMib;
  if (info?.state === "started") {
    // Measured while it runs (cheap), kept for when it's stopped.
    const du = await deps.provider
      .exec(row.providerId, { command: "du -sm . 2>/dev/null | cut -f1", timeoutSeconds: 15 })
      .catch(() => null);
    const mib = Number(du?.stdout.trim());
    if (du && Number.isFinite(mib)) {
      diskMib = Math.round(mib);
      await deps.db.update(sandboxes).set({ diskUsedMib: diskMib }).where(eq(sandboxes.id, row.id));
    }
  }
  if (status !== row.status && status !== "none") {
    await deps.db.update(sandboxes).set({ status, updatedAt: new Date() }).where(eq(sandboxes.id, row.id));
  }
  return { ...base, diskUsedGib: Math.round((diskMib / 1024) * 100) / 100, status };
}

export async function getAgentComputer(
  deps: Pick<SandboxDeps, "db" | "provider">,
  actorId: string,
  orgId: string,
  agentId: string,
) {
  await requireComputerManager(deps.db, actorId, orgId, agentId);
  return computerView(deps, orgId, agentId, await liveComputer(deps.db, orgId, agentId));
}

/**
 * Turns the computer on (creating it the first time) without waiting: marks
 * it `starting`, queues `sandbox.start` and returns. Progress comes as
 * `agent.computer` events.
 */
export async function startAgentComputer(
  deps: Pick<SandboxDeps, "db"> & { pubsub?: PubSub },
  actorId: string,
  orgId: string,
  agentId: string,
): Promise<{ status: ComputerStatus }> {
  await requireComputerManager(deps.db, actorId, orgId, agentId);
  const settings = await getSandboxSettings(deps.db, orgId);
  if (!settings.enabled) throw new ValidationError("The agents' computers are turned off for this organization.");
  const live = await liveComputer(deps.db, orgId, agentId);
  if (live?.status === "running") return { status: "running" };
  if (live?.status === "starting") return { status: "starting" };
  await deps.db.transaction(async (tx) => {
    if (live) {
      await tx
        .update(sandboxes)
        .set({ status: "starting", lastError: null, updatedAt: new Date() })
        .where(eq(sandboxes.id, live.id));
    } else {
      await tx
        .insert(sandboxes)
        .values({
          orgId,
          agentId,
          key: computerKey(agentId),
          provider: "",
          providerId: "",
          status: "starting",
          cpu: 0,
          memoryGib: 0,
          diskGib: 0,
        })
        .onConflictDoNothing();
    }
    await enqueue(tx, {
      orgId,
      kind: "sandbox.start",
      payload: { agentId, actorId },
      dedupeKey: `sandbox.start:${agentId}:${Date.now()}`,
      maxAttempts: 1,
    });
  });
  await publishComputerEvent(deps.pubsub, orgId, {
    agentId,
    status: "starting",
    step: live ? "preparing" : "creating",
  });
  return { status: "starting" };
}

/** Job `sandbox.start`: the provider work behind `startAgentComputer`. Failures land on the row as `error`. */
export async function runComputerStart(
  deps: SandboxDeps & { pubsub?: PubSub },
  orgId: string,
  agentId: string,
  actorId: string,
) {
  const { settings, updatedAt } = await settingsRow(deps.db, orgId);
  try {
    const { row } = await acquire(
      deps,
      orgId,
      agentId,
      { ...settings, updatedAt },
      { type: "person", id: actorId },
      (step) => publishComputerEvent(deps.pubsub, orgId, { agentId, status: "starting", step }),
    );
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "sandbox.started",
      target: { type: "sandbox", id: row.id },
      details: { agentId },
    });
    await publishComputerEvent(deps.pubsub, orgId, { agentId, status: "running", step: "ready" });
  } catch (error) {
    const message = maskProvider(error instanceof Error ? error.message : String(error)).slice(0, 500);
    const live = await liveComputer(deps.db, orgId, agentId);
    if (live) {
      await deps.db
        .update(sandboxes)
        .set({ status: "error", lastError: message, updatedAt: new Date() })
        .where(eq(sandboxes.id, live.id));
    }
    await publishComputerEvent(deps.pubsub, orgId, { agentId, status: "error", error: message });
  }
}

/** Stops it without waiting (`stopping`, job `sandbox.stop`); files stay, and the next use starts it again. */
export async function stopAgentComputer(
  deps: Pick<SandboxDeps, "db"> & { pubsub?: PubSub },
  actorId: string,
  orgId: string,
  agentId: string,
): Promise<{ status: ComputerStatus }> {
  await requireComputerManager(deps.db, actorId, orgId, agentId);
  const row = await liveComputer(deps.db, orgId, agentId);
  if (!row?.providerId) throw new NotFoundError("This agent has no computer yet");
  await deps.db.transaction(async (tx) => {
    await tx.update(sandboxes).set({ status: "stopping", updatedAt: new Date() }).where(eq(sandboxes.id, row.id));
    await enqueue(tx, {
      orgId,
      kind: "sandbox.stop",
      payload: { agentId, actorId },
      dedupeKey: `sandbox.stop:${agentId}:${Date.now()}`,
      maxAttempts: 1,
    });
  });
  await publishComputerEvent(deps.pubsub, orgId, { agentId, status: "stopping" });
  return { status: "stopping" };
}

/** Job `sandbox.stop`. */
export async function runComputerStop(
  deps: Pick<SandboxDeps, "db" | "provider"> & { pubsub?: PubSub },
  orgId: string,
  agentId: string,
  actorId: string,
) {
  const row = await liveComputer(deps.db, orgId, agentId);
  if (!row?.providerId) return;
  try {
    await deps.provider.stop(row.providerId);
    await deps.db.update(sandboxes).set({ status: "stopped", updatedAt: new Date() }).where(eq(sandboxes.id, row.id));
    await recordAudit(deps.db, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "sandbox.stopped",
      target: { type: "sandbox", id: row.id },
      details: { agentId },
    });
    await publishComputerEvent(deps.pubsub, orgId, { agentId, status: "stopped" });
  } catch (error) {
    const message = maskProvider(error instanceof Error ? error.message : String(error)).slice(0, 500);
    await deps.db
      .update(sandboxes)
      .set({ status: "error", lastError: message, updatedAt: new Date() })
      .where(eq(sandboxes.id, row.id));
    await publishComputerEvent(deps.pubsub, orgId, { agentId, status: "error", error: message });
  }
}

/** Deletes the computer and every file on it. */
export async function deleteAgentComputer(
  deps: Pick<SandboxDeps, "db" | "provider"> & { pubsub?: PubSub },
  actorId: string,
  orgId: string,
  agentId: string,
) {
  await requireComputerManager(deps.db, actorId, orgId, agentId);
  const row = await liveComputer(deps.db, orgId, agentId);
  if (!row) throw new NotFoundError("This agent has no computer");
  if (row.providerId) await deps.provider.destroy(row.providerId);
  await deps.db
    .update(sandboxes)
    .set({ status: "deleted", deletedAt: new Date(), updatedAt: new Date() })
    .where(eq(sandboxes.id, row.id));
  await recordAudit(deps.db, {
    orgId,
    actor: { type: "person", id: actorId },
    action: "sandbox.deleted",
    target: { type: "sandbox", id: row.id },
    details: { agentId },
  });
  await publishComputerEvent(deps.pubsub, orgId, { agentId, status: "none" });
}

/** Keeps the start and end of long output, cutting the middle. */
export function truncateOutput(text: string, max: number) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n[… ${text.length - max} characters cut …]\n${text.slice(-tail)}`;
}
