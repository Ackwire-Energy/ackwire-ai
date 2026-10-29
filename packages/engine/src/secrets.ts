import type { PubSub, SecretRequest } from "@agenteschat/adapters";
import { parseSecretBox, SECRET_NAME, type SecretTarget, secretAad } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, isNull, lt, schema, sql } from "@agenteschat/db";
import { getAgentCached } from "./agents";
import { recordAudit } from "./audit";
import { isAgentOnlyDm } from "./dms";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent } from "./events";
import { enqueue } from "./outbox";
import { personBehindCall } from "./requester";
import {
  type ComputerHandle,
  requireComputerManager,
  type SandboxDeps,
  withConnectedMachine,
  withSandbox,
} from "./sandbox";
import type { ToolContext } from "./tools/types";

const { secretRequests, agentRuns } = schema;

export type SecretRequestRow = typeof secretRequests.$inferSelect;

export const REQUEST_SECRET_TOOL = "request_secret";
/** How long a request waits for the person before the run goes on without it. */
export const SECRET_TTL_MS = 15 * 60_000;
/** Pending requests one run may have at a time. */
export const MAX_PENDING_SECRETS = 3;

/** What the app renders (`meta.secretRequest`, `secret.requested` / `secret.updated`). Never the value. */
export interface SecretRequestView {
  id: string;
  agentId: string;
  channelId: string;
  threadId: string | null;
  messageId: string | null;
  requestedForUserId: string;
  name: string;
  purpose: string;
  target: SecretTarget;
  /** For a browser password: the only site it may be typed on (`https://host`). */
  site: string | null;
  /** The connected machine that holds it (ADR 0025). */
  machineId: string | null;
  /** Only useful while pending: the browser seals the value to it. */
  publicKey: string | null;
  status: "pending" | "delivered" | "declined" | "expired" | "canceled";
  expiresAt: string;
  deliveredAt: string | null;
  removed: boolean;
}

const targetOf = (row: Pick<SecretRequestRow, "targetKind" | "targetPath">): SecretTarget =>
  row.targetKind === "file" && row.targetPath ? { kind: "file", path: row.targetPath } : { kind: "env" };

/** Pending but past its deadline counts as expired (the worker closes it within a minute). */
function statusOf(row: SecretRequestRow, now = new Date()): SecretRequestView["status"] {
  if (row.status === "pending" && row.expiresAt <= now) return "expired";
  return row.status;
}

export function secretRequestView(row: SecretRequestRow): SecretRequestView {
  const status = statusOf(row);
  return {
    id: row.id,
    agentId: row.agentId,
    channelId: row.channelId,
    threadId: row.threadId,
    messageId: row.messageId,
    requestedForUserId: row.requestedForUserId,
    name: row.name,
    purpose: row.purpose,
    target: targetOf(row),
    site: row.site,
    machineId: row.machineId,
    publicKey: status === "pending" ? row.publicKey : null,
    status,
    expiresAt: row.expiresAt.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    removed: row.removedAt !== null,
  };
}

/** What the model hears back once the request is closed. Never the value. */
export function secretResult(row: SecretRequestRow | undefined): { content: string; isError?: boolean } {
  if (!row) return { content: "The secret request is gone.", isError: true };
  const where =
    row.targetKind === "file"
      ? `written to ${row.targetPath} (mode 600)`
      : `available as the environment variable ${row.name} in your commands`;
  switch (row.status) {
    case "delivered":
      return {
        content: `${row.name} was delivered to your computer: ${where}. Use it by name; never print, echo or show its value (outputs show it as [secret:${row.name}]).`,
      };
    case "declined":
      return {
        content: `The person declined to give ${row.name}. Don't ask again in this conversation; say what you can do without it.`,
      };
    case "canceled":
      return { content: `The request for ${row.name} was canceled.`, isError: true };
    default:
      return {
        content: `No one gave ${row.name} within 15 minutes. Say what you still need; you may ask again if the person wants.`,
      };
  }
}

export async function syncSecretMessage(db: Executor, row: SecretRequestRow) {
  if (!row.messageId) return;
  await db
    .update(schema.messages)
    .set({
      meta: sql`jsonb_set(${schema.messages.meta}, '{secretRequest}', ${JSON.stringify(secretRequestView(row))}::jsonb)`,
    })
    .where(and(eq(schema.messages.id, row.messageId), eq(schema.messages.orgId, row.orgId)));
}

export async function publishSecret(
  pubsub: PubSub | undefined,
  row: SecretRequestRow,
  type: "secret.requested" | "secret.updated",
) {
  await publishChannelEvent(pubsub, {
    type,
    channelId: row.channelId,
    threadId: row.threadId,
    secretRequest: secretRequestView(row),
  });
}

const resumeJob = (row: SecretRequestRow) => ({
  orgId: row.orgId,
  kind: "agent_run.execute",
  payload: { runId: row.runId },
  dedupeKey: `agent_run.execute:${row.runId}:secret:${row.id}`,
  maxAttempts: 4,
});

/** One secret action on the computer: the runner keeps the key and the value (runner protocol 3, ADR 0027). */
export async function secretOnComputer(
  computer: ComputerHandle,
  request: SecretRequest,
): Promise<{ publicKey?: string; size?: number }> {
  return computer.provider.secret(computer.id, request);
}

/** Files on the agent's computers that hold secrets: the file tools refuse them. */
export async function secretFilePaths(db: Database, orgId: string, agentId: string, machineId: string) {
  const rows = await db
    .select({ path: secretRequests.targetPath })
    .from(secretRequests)
    .where(
      and(
        eq(secretRequests.orgId, orgId),
        eq(secretRequests.agentId, agentId),
        eq(secretRequests.status, "delivered"),
        eq(secretRequests.targetKind, "file"),
        isNull(secretRequests.removedAt),
        eq(secretRequests.machineId, machineId),
      ),
    );
  return rows.flatMap((r) => (r.path ? [r.path] : []));
}

/** The run's context, rebuilt for actions people take on a request (deliver, remove). */
async function runContext(db: Database, row: SecretRequestRow): Promise<ToolContext> {
  const [run] = await db
    .select({ threadRootId: agentRuns.threadRootId, triggerMessageId: agentRuns.triggerMessageId })
    .from(agentRuns)
    .where(eq(agentRuns.id, row.runId));
  return {
    db,
    orgId: row.orgId,
    agentId: row.agentId,
    runId: row.runId,
    channelId: row.channelId,
    threadRootId: run?.threadRootId ?? row.channelId,
    triggerMessageId: run?.triggerMessageId ?? row.channelId,
  };
}

/** The same computer that made the key, or a clear refusal (the agent was moved meanwhile). */
async function onRequestComputer<T>(
  deps: SandboxDeps,
  row: SecretRequestRow,
  fn: (computer: ComputerHandle) => Promise<T>,
): Promise<T> {
  const ctx = await runContext(deps.db, row);
  // A browser password (ADR 0040) lives on the machine its browser runs on, whether or not the org runs code there.
  if (row.site && row.machineId) {
    if (!deps.machines)
      throw new ConflictError("Connected computers are not available on this server", "secret.computer_changed");
    const agent = await getAgentCached(deps.db, row.orgId, row.agentId);
    return withConnectedMachine(
      deps.machines.hub,
      ctx,
      { machineId: row.machineId, handle: agent?.handle ?? "agent", ...(agent?.name ? { name: agent.name } : {}) },
      fn,
    );
  }
  return withSandbox(deps, ctx, async (computer) => {
    if (computer.machineId !== row.machineId) {
      throw new ConflictError("The agent changed computers since it asked. Ask it again.", "secret.computer_changed");
    }
    return fn(computer);
  });
}

async function loadForRequester(db: Database, actorId: string, orgId: string, requestId: string) {
  const [row] = await db
    .select()
    .from(secretRequests)
    .where(and(eq(secretRequests.id, requestId), eq(secretRequests.orgId, orgId)));
  // Someone else's request doesn't exist for you.
  if (!row || row.requestedForUserId !== actorId) throw new NotFoundError("Secret request not found");
  return row;
}

export async function getSecretRequest(db: Database, actorId: string, orgId: string, requestId: string) {
  return secretRequestView(await loadForRequester(db, actorId, orgId, requestId));
}

/**
 * The person sends the sealed value (`box`): we hand it to the computer in
 * memory, store nothing of it, and resume the run with only the metadata.
 */
export async function deliverSecret(
  deps: SandboxDeps & { pubsub?: PubSub },
  actorId: string,
  orgId: string,
  requestId: string,
  rawBox: unknown,
): Promise<SecretRequestView> {
  const row = await loadForRequester(deps.db, actorId, orgId, requestId);
  if (statusOf(row) !== "pending") throw new ConflictError("This request was already answered or expired");
  const box = parseSecretBox(rawBox);
  if (!box) throw new ValidationError("Invalid secret box");
  const target = targetOf(row);
  const aad = secretAad({ requestId: row.id, orgId, name: row.name, target });
  const reply = await onRequestComputer(deps, row, (computer) =>
    secretOnComputer(computer, { action: "deliver", requestId: row.id, name: row.name, target, aad, box }),
  );
  const now = new Date();
  const delivered = await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(secretRequests)
      .set({ status: "delivered", deliveredAt: now, deliveredSize: reply.size ?? null })
      .where(and(eq(secretRequests.id, row.id), eq(secretRequests.status, "pending")))
      .returning();
    if (!updated) return null;
    // The computer now holds this value under that name: older deliveries of it were replaced.
    await tx
      .update(secretRequests)
      .set({ removedAt: now })
      .where(
        and(
          eq(secretRequests.orgId, orgId),
          eq(secretRequests.agentId, row.agentId),
          eq(secretRequests.name, row.name),
          eq(secretRequests.status, "delivered"),
          isNull(secretRequests.removedAt),
          row.machineId ? eq(secretRequests.machineId, row.machineId) : isNull(secretRequests.machineId),
          sql`${secretRequests.id} <> ${row.id}`,
        ),
      );
    await syncSecretMessage(tx, updated);
    await enqueue(tx, resumeJob(updated));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "secret.delivered",
      target: { type: "agent", id: row.agentId },
      details: { requestId: row.id, name: row.name, target, machineId: row.machineId, size: reply.size ?? null },
    });
    return updated;
  });
  if (!delivered) throw new ConflictError("This request was already answered or expired");
  await publishSecret(deps.pubsub, delivered, "secret.updated");
  return secretRequestView(delivered);
}

/** The person says no: the run goes on without it; the computer forgets the key (best effort). */
export async function declineSecret(
  deps: { db: Database; pubsub?: PubSub; sandbox?: SandboxDeps | null },
  actorId: string,
  orgId: string,
  requestId: string,
): Promise<SecretRequestView> {
  const row = await loadForRequester(deps.db, actorId, orgId, requestId);
  const declined = await deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(secretRequests)
      .set({ status: "declined" })
      .where(
        and(
          eq(secretRequests.id, row.id),
          eq(secretRequests.status, "pending"),
          sql`${secretRequests.expiresAt} > now()`,
        ),
      )
      .returning();
    if (!updated) return null;
    await syncSecretMessage(tx, updated);
    await enqueue(tx, resumeJob(updated));
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "secret.declined",
      target: { type: "agent", id: row.agentId },
      details: { requestId: row.id, name: row.name },
    });
    return updated;
  });
  if (!declined) throw new ConflictError("This request was already answered or expired");
  await publishSecret(deps.pubsub, declined, "secret.updated");
  const sandbox = deps.sandbox;
  if (sandbox) {
    await onRequestComputer(sandbox, declined, (c) =>
      secretOnComputer(c, { action: "discard", requestId: declined.id }),
    ).catch(() => undefined);
  }
  return secretRequestView(declined);
}

/** Closes requests past their deadline and resumes their runs (worker, every minute). */
export async function expireSecretRequests(deps: { db: Database; pubsub?: PubSub }, now = new Date()) {
  const expired = await deps.db.transaction(async (tx) => {
    const rows = await tx
      .update(secretRequests)
      .set({ status: "expired" })
      .where(and(eq(secretRequests.status, "pending"), lt(secretRequests.expiresAt, now)))
      .returning();
    for (const row of rows) {
      await syncSecretMessage(tx, row);
      await enqueue(tx, resumeJob(row));
      await recordAudit(tx, {
        orgId: row.orgId,
        actor: { type: "system", id: null },
        action: "secret.expired",
        target: { type: "agent", id: row.agentId },
        details: { requestId: row.id, name: row.name },
      });
    }
    return rows;
  });
  for (const row of expired) await publishSecret(deps.pubsub, row, "secret.updated");
  return expired.length;
}

/** A run canceled while waiting: its requests close too. */
export async function cancelSecretRequests(tx: Executor, runId: string) {
  return tx
    .update(secretRequests)
    .set({ status: "canceled" })
    .where(and(eq(secretRequests.runId, runId), eq(secretRequests.status, "pending")))
    .returning();
}

export interface AgentSecretView {
  name: string;
  target: SecretTarget;
  machineId: string | null;
  deliveredAt: string;
  deliveredByUserId: string;
}

/** The secrets on the agent's computers (names only), for its owner and admins. */
export async function listAgentSecrets(db: Database, actorId: string, orgId: string, agentId: string) {
  await requireComputerManager(db, actorId, orgId, agentId);
  const rows = await db
    .select()
    .from(secretRequests)
    .where(
      and(
        eq(secretRequests.orgId, orgId),
        eq(secretRequests.agentId, agentId),
        eq(secretRequests.status, "delivered"),
        isNull(secretRequests.removedAt),
      ),
    );
  return rows
    .map(
      (r): AgentSecretView => ({
        name: r.name,
        target: targetOf(r),
        machineId: r.machineId,
        deliveredAt: (r.deliveredAt ?? r.createdAt).toISOString(),
        deliveredByUserId: r.requestedForUserId,
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Deletes a secret from the agent's computer (and its file); the rows stay for the record. */
export async function removeAgentSecret(
  deps: SandboxDeps,
  actorId: string,
  orgId: string,
  agentId: string,
  name: string,
  machineId: string | null,
) {
  await requireComputerManager(deps.db, actorId, orgId, agentId);
  if (!SECRET_NAME.test(name)) throw new ValidationError("Invalid secret name");
  const live = await deps.db
    .select()
    .from(secretRequests)
    .where(
      and(
        eq(secretRequests.orgId, orgId),
        eq(secretRequests.agentId, agentId),
        eq(secretRequests.name, name),
        eq(secretRequests.status, "delivered"),
        isNull(secretRequests.removedAt),
        machineId ? eq(secretRequests.machineId, machineId) : isNull(secretRequests.machineId),
      ),
    );
  const latest = live.at(-1);
  if (!latest) throw new NotFoundError("Secret not found");
  // On the computer first: if it can't be reached, the secret is still listed (and still there).
  await onRequestComputer(deps, latest, (c) => secretOnComputer(c, { action: "remove", name }));
  const now = new Date();
  await deps.db.transaction(async (tx) => {
    for (const r of live) {
      await tx.update(secretRequests).set({ removedAt: now }).where(eq(secretRequests.id, r.id));
    }
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: actorId },
      action: "secret.removed",
      target: { type: "agent", id: agentId },
      details: { name, machineId },
    });
  });
}

/**
 * Who a secret may be asked of: the person behind the run (`authority.ts`), where they read the card.
 * Nobody for a routine's or an unattended run, nor in an agents' DM (no person reads the card there).
 */
export async function requesterOfRun(ctx: ToolContext): Promise<string | null> {
  const [here] = await ctx.db
    .select({ kind: schema.channels.kind, dmKey: schema.channels.dmKey })
    .from(schema.channels)
    .where(and(eq(schema.channels.orgId, ctx.orgId), eq(schema.channels.id, ctx.channelId)));
  if (!here || isAgentOnlyDm(here)) return null;
  return personBehindCall(ctx);
}
