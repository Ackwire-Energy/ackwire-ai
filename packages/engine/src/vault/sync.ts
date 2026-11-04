/**
 * Reading a connection's items into the Vault (ADR 0135): its source lists metadata (never a value), and each item
 * becomes a row keyed by (connection, the source's id). New ones follow the connection's access; ones the source no
 * longer lists are marked missing (nobody uses them until they come back). A refusal (`VaultSourceError`) leaves the
 * items as they were and goes on the connection (`status` `error`, `errorCode`), never the source's own words.
 *
 * Every connection is read again every 10 minutes (`enqueueVaultSyncs`, one job per connection and window), except
 * one whose sign-in was refused: trying again with the same credentials could lock its account, so it waits for a
 * person to reconnect it.
 */
import {
  isReservedSecretName,
  SECRET_NAME,
  VaultSourceError,
  type VaultSourceItem,
  vaultOrigin,
} from "@agenteschat/adapters";
import { and, type Database, eq, inArray, isNull, lt, not, notInArray, or, schema, sql } from "@agenteschat/db";
import { UUID } from "../authority";
import { SealedValueError } from "../crypto";
import { publishVaultChanged } from "../events";
import { enqueue } from "../outbox";
import { closedOrg } from "../standing";
import type { ConnectionRow } from "./access";
import { sourceCall, sourceConnection, sourceOf } from "./seal";
import {
  VAULT_ITEM_KINDS,
  VAULT_LIMITS,
  VAULT_MAX_ITEMS,
  type VaultDeps,
  type VaultItemKind,
  vaultNow,
} from "./service";

const { organizations, vaultConnections, vaultItems } = schema;

/** Outbox job: read one connection's items again (`{ connectionId }`). */
export const VAULT_SYNC_JOB = "vault.sync";
/** How often each connection is read again. */
export const VAULT_SYNC_EVERY_MS = 10 * 60_000;
/** Refusals that wait for a person to reconnect instead of being tried again. */
const WAITS_FOR_PERSON = ["auth_failed", "locked"];

const hostOf = (origin: string) => new URL(origin).host;

/** A row's columns from one listed item; null when it can't be kept (an unknown kind, no id). */
function rowOf(connection: ConnectionRow, item: VaultSourceItem) {
  const kind = item.kind as VaultItemKind;
  if (!VAULT_ITEM_KINDS.includes(kind) || !item.ref || item.ref.length > 512) return null;
  const site = (item.websites ?? [])
    .map((w) => ({ origin: vaultOrigin(w.url), match: w.match === "site" ? "site" : "exact" }))
    .find((w) => w.origin !== null);
  const keyName = kind === "key" && item.keyName?.trim() ? item.keyName.trim() : null;
  return {
    orgId: connection.orgId,
    kind,
    connectionId: connection.id,
    externalRef: item.ref,
    ownerUserId: connection.ownerUserId,
    title: (item.title ?? "").trim().slice(0, VAULT_LIMITS.title) || (site?.origin ? hostOf(site.origin) : "Untitled"),
    description: (item.description ?? "").trim().slice(0, VAULT_LIMITS.description),
    website: kind === "login" ? (site?.origin ?? null) : null,
    match: kind === "login" ? (site?.match ?? "exact") : "exact",
    username: kind === "login" ? (item.username ?? "").trim().slice(0, VAULT_LIMITS.username) || null : null,
    keyName: keyName && SECRET_NAME.test(keyName) && !isReservedSecretName(keyName) ? keyName : null,
    accessFromConnection: true,
    missing: false,
  };
}

/** Why a connection failed, as a code people can act on. A seal that no longer opens means: connect it again. */
const failureOf = (error: unknown) =>
  error instanceof VaultSourceError
    ? error
    : error instanceof SealedValueError
      ? new VaultSourceError("auth_failed", "Connect it again.")
      : new VaultSourceError("unreachable", "Couldn't reach the password manager.");

/**
 * Reads one connection now. Returns the row as it ends and, when the source refused, why (also on the row). Never
 * throws for a source's refusal.
 */
export async function syncConnectionRow(
  deps: Pick<VaultDeps, "db" | "keyWrappers" | "sources" | "pubsub" | "now">,
  connection: ConnectionRow,
): Promise<{ row: ConnectionRow; error: VaultSourceError | null }> {
  const { db } = deps;
  const where = and(eq(vaultConnections.orgId, connection.orgId), eq(vaultConnections.id, connection.id));
  const ended = async (set: Partial<typeof vaultConnections.$inferInsert>, error: VaultSourceError | null) => {
    const [row] = await db
      .update(vaultConnections)
      .set({ ...set, updatedAt: vaultNow(deps) })
      .where(where)
      .returning();
    await publishVaultChanged(deps.pubsub, connection.orgId);
    return { row: row ?? { ...connection, ...set }, error } as { row: ConnectionRow; error: VaultSourceError | null };
  };

  const source = sourceOf(deps.sources, connection.kind);
  if (!source) {
    const error = new VaultSourceError("unsupported", "This server can't read this password manager any more.");
    return ended({ status: "error", errorCode: error.code }, error);
  }
  await db.update(vaultConnections).set({ status: "syncing" }).where(where);
  let listed: VaultSourceItem[];
  try {
    const opened = await sourceConnection(deps, connection);
    listed = await sourceCall((signal) => source.list(opened, signal));
  } catch (error) {
    const failure = failureOf(error);
    return ended({ status: "error", errorCode: failure.code }, failure);
  }

  const now = vaultNow(deps);
  const byRef = new Map<string, NonNullable<ReturnType<typeof rowOf>>>();
  for (const item of listed) {
    const row = rowOf(connection, item);
    if (row && !byRef.has(row.externalRef)) byRef.set(row.externalRef, row);
  }
  // The workspace's cap counts every item; this connection may fill what the others leave.
  const [{ others } = { others: 0 }] = await db
    .select({ others: sql<number>`count(*)::int` })
    .from(vaultItems)
    .where(
      and(
        eq(vaultItems.orgId, connection.orgId),
        or(isNull(vaultItems.connectionId), sql`${vaultItems.connectionId} <> ${connection.id}`),
      ),
    );
  const rows = [...byRef.values()].slice(0, Math.max(0, VAULT_MAX_ITEMS - others));
  const refs = rows.map((r) => r.externalRef);

  await db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += 200) {
      await tx
        .insert(vaultItems)
        .values(rows.slice(i, i + 200).map((r) => ({ ...r, createdAt: now, updatedAt: now })))
        .onConflictDoUpdate({
          target: [vaultItems.connectionId, vaultItems.externalRef],
          set: {
            kind: sql`excluded.kind`,
            title: sql`excluded.title`,
            website: sql`excluded.website`,
            match: sql`excluded.match`,
            username: sql`excluded.username`,
            // A variable name a person set here stays; a description too (both are theirs to edit, ADR 0135).
            keyName: sql`coalesce(${vaultItems.keyName}, excluded.key_name)`,
            missing: false,
            updatedAt: now,
          },
          setWhere: sql`(${vaultItems.kind}, ${vaultItems.title}, ${vaultItems.website}, ${vaultItems.match},
            ${vaultItems.username}, ${vaultItems.missing}) is distinct from
            (excluded.kind, excluded.title, excluded.website, excluded.match, excluded.username, false)
            or (${vaultItems.keyName} is null and excluded.key_name is not null)`,
        });
    }
    await tx
      .update(vaultItems)
      .set({ missing: true, updatedAt: now })
      .where(
        and(
          eq(vaultItems.orgId, connection.orgId),
          eq(vaultItems.connectionId, connection.id),
          eq(vaultItems.missing, false),
          refs.length > 0 ? notInArray(vaultItems.externalRef, refs) : undefined,
        ),
      );
  });
  return ended({ status: "ready", errorCode: null, syncedAt: now }, null);
}

/**
 * Queues a read of every connection last read more than 10 minutes ago, once per connection and 10-minute window
 * (the window in its dedupe key). Left out: closed workspaces, refused sign-ins waiting for a person, and personal
 * connections whose owner is no longer a member.
 */
export async function enqueueVaultSyncs(db: Database, now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - VAULT_SYNC_EVERY_MS);
  const due = await db
    .select({ id: vaultConnections.id, orgId: vaultConnections.orgId })
    .from(vaultConnections)
    .innerJoin(organizations, eq(organizations.id, vaultConnections.orgId))
    .where(
      and(
        not(closedOrg),
        or(isNull(vaultConnections.syncedAt), lt(vaultConnections.syncedAt, before)),
        or(
          sql`${vaultConnections.status} <> 'error'`,
          isNull(vaultConnections.errorCode),
          not(inArray(vaultConnections.errorCode, WAITS_FOR_PERSON)),
        ),
        or(
          isNull(vaultConnections.ownerUserId),
          sql`exists (select 1 from organization_members m
            where m.org_id = ${vaultConnections.orgId} and m.user_id = ${vaultConnections.ownerUserId})`,
        ),
      ),
    );
  const window = Math.floor(now.getTime() / VAULT_SYNC_EVERY_MS);
  for (const connection of due) {
    await enqueue(db, {
      orgId: connection.orgId,
      kind: VAULT_SYNC_JOB,
      payload: { connectionId: connection.id },
      dedupeKey: `${VAULT_SYNC_JOB}:${connection.id}:${window}`,
      maxAttempts: 1,
    });
  }
  return due.length;
}

/** The job: reads one connection of the workspace again, if it is still there. A refusal stays on the connection. */
export async function runVaultSync(deps: VaultDeps, orgId: string, connectionId: string): Promise<void> {
  if (!UUID.test(connectionId)) return;
  const [row] = await deps.db
    .select()
    .from(vaultConnections)
    .where(and(eq(vaultConnections.orgId, orgId), eq(vaultConnections.id, connectionId)));
  if (!row) return;
  await syncConnectionRow(deps, row);
}
