import type { KeyWrapper } from "@agenteschat/adapters";
import { and, asc, type Database, type Executor, eq, isNull, schema, sql } from "@agenteschat/db";
import { isKnownProvider, type ProviderId } from "@agenteschat/providers";
import { caches } from "./cache";
import { openSecret, sealSecret } from "./crypto";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { requirePermission } from "./organizations";

const { providerCredentials } = schema;

/** Associated data binding a sealed key to its organization and row. */
const aadFor = (orgId: string, credentialId: string) => `provider-credential|${orgId}|${credentialId}`;

/** Public view of a credential. The key itself is never returned by any API. */
export interface CredentialSummary {
  id: string;
  provider: ProviderId;
  label: string;
  keyHint: string;
  /** Last characters of the workspace id the key is scoped to, if one is set. */
  workspaceIdHint: string | null;
  /** The workspace's default key (used by agents without their own key, router, summaries). */
  isDefault?: boolean;
  createdAt: Date;
  revokedAt: Date | null;
}

const summary = (row: typeof providerCredentials.$inferSelect): CredentialSummary => ({
  id: row.id,
  provider: row.provider as ProviderId,
  label: row.label,
  keyHint: row.keyHint,
  workspaceIdHint: row.workspaceId ? row.workspaceId.slice(-6) : null,
  createdAt: row.createdAt,
  revokedAt: row.revokedAt,
});

function cleanWorkspaceId(id: string | null | undefined) {
  const v = id?.trim();
  if (!v) return null;
  if (!/^[A-Za-z0-9_-]{4,128}$/.test(v)) throw new ValidationError("workspaceId looks invalid");
  return v;
}

/** Stores an org's provider API key, encrypted (envelope encryption). */
export async function createCredential(
  db: Database,
  keyWrapper: KeyWrapper,
  actorId: string,
  orgId: string,
  input: {
    provider: ProviderId;
    label: string;
    apiKey: string;
    workspaceId?: string | null;
    /** OpenAI organization and project ids, when the key needs them. */
    organization?: string | null;
    project?: string | null;
    /** Make it the workspace's default key (onboarding does this in the same call). */
    makeDefault?: boolean;
  },
): Promise<CredentialSummary> {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  if (!isKnownProvider(input.provider)) throw new ValidationError(`Unknown provider ${input.provider}`);
  const apiKey = input.apiKey.trim();
  if (apiKey.length < 8) throw new ValidationError("apiKey looks too short");
  const id = crypto.randomUUID();
  const sealed = await sealSecret(keyWrapper, apiKey, aadFor(orgId, id));
  const row = await db.transaction(async (tx) => {
    const [r] = await tx
      .insert(providerCredentials)
      .values({
        id,
        orgId,
        provider: input.provider,
        label: input.label,
        secretCiphertext: sealed.ciphertext,
        wrappedDataKey: sealed.wrappedDataKey,
        kekId: sealed.kekId,
        keyHint: apiKey.slice(-4),
        workspaceId: cleanWorkspaceId(input.workspaceId),
        options: cleanOptions(input),
        createdByUserId: actorId,
      })
      .returning();
    if (input.makeDefault) await setDefault(tx, orgId, input.provider, id);
    return r;
  });
  if (!row) throw new Error("credential insert returned nothing");
  invalidateDefaults(orgId);
  return { ...summary(row), isDefault: input.makeDefault === true };
}

function cleanOptions(input: { organization?: string | null; project?: string | null }) {
  const out: { organization?: string; project?: string } = {};
  for (const key of ["organization", "project"] as const) {
    const v = input[key]?.trim();
    if (!v) continue;
    if (!/^[A-Za-z0-9_-]{3,128}$/.test(v)) throw new ValidationError(`${key} looks invalid`);
    out[key] = v;
  }
  return out;
}

/** Forgets which credential is each provider's default for an org (after any key or settings change). */
export function invalidateDefaults(orgId: string) {
  caches.credentials.deletePrefix(`${orgId}:default:`);
}

/** Makes a key its provider's default (and the legacy single default), in the caller's transaction. */
async function setDefault(tx: Executor, orgId: string, provider: string, credentialId: string) {
  const patch = sql`coalesce(${schema.organizationSettings.defaultCredentialIds}, '{}'::jsonb) || jsonb_build_object(${provider}::text, ${credentialId}::text)`;
  await tx
    .insert(schema.organizationSettings)
    .values({ orgId, defaultCredentialId: credentialId, defaultCredentialIds: { [provider]: credentialId } })
    .onConflictDoUpdate({
      target: schema.organizationSettings.orgId,
      set: { defaultCredentialId: credentialId, defaultCredentialIds: patch, updatedAt: new Date() },
    });
}

/** "Make default": a key becomes its provider's default for the workspace (admins). */
export async function makeDefaultCredential(db: Database, actorId: string, orgId: string, credentialId: string) {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  const [row] = await db
    .select()
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.id, credentialId),
        eq(providerCredentials.orgId, orgId),
        isNull(providerCredentials.revokedAt),
      ),
    );
  if (!row) throw new NotFoundError("Credential not found");
  await setDefault(db, orgId, row.provider, credentialId);
  invalidateDefaults(orgId);
  return { ...summary(row), isDefault: true };
}

/** The workspace's default keys: per provider, plus the legacy single default. */
export async function defaultCredentials(db: Database, orgId: string) {
  const [row] = await db
    .select({
      id: schema.organizationSettings.defaultCredentialId,
      ids: schema.organizationSettings.defaultCredentialIds,
    })
    .from(schema.organizationSettings)
    .where(eq(schema.organizationSettings.orgId, orgId));
  return { legacy: row?.id ?? null, perProvider: (row?.ids ?? {}) as Partial<Record<string, string>> };
}

/** The workspace's default credential id (legacy single default), if one is set. */
export async function defaultCredentialId(db: Database, orgId: string) {
  return (await defaultCredentials(db, orgId)).legacy;
}

/** Removing a default key would leave its provider without one: refuse until another is the default. */
async function refuseIfDefault(db: Database, orgId: string, credentialId: string) {
  const d = await defaultCredentials(db, orgId);
  if (d.legacy === credentialId || Object.values(d.perProvider).includes(credentialId)) {
    throw new ConflictError("This is the workspace's default key. Make another key the default first.");
  }
}

export async function listCredentials(db: Database, actorId: string, orgId: string): Promise<CredentialSummary[]> {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  const [rows, defaults] = await Promise.all([
    db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.orgId, orgId))
      .orderBy(asc(providerCredentials.createdAt)),
    defaultCredentials(db, orgId),
  ]);
  const isDefault = (r: typeof providerCredentials.$inferSelect) =>
    defaults.perProvider[r.provider] ? defaults.perProvider[r.provider] === r.id : defaults.legacy === r.id;
  return rows.map((r) => ({ ...summary(r), isDefault: isDefault(r) }));
}

/** Revoked keys stay stored (usage records point at them) but can no longer be decrypted for calls. */
export async function revokeCredential(db: Database, actorId: string, orgId: string, credentialId: string) {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  await refuseIfDefault(db, orgId, credentialId);
  const [row] = await db
    .update(providerCredentials)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(providerCredentials.id, credentialId),
        eq(providerCredentials.orgId, orgId),
        isNull(providerCredentials.revokedAt),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError("Credential not found");
  caches.credentials.delete(`${orgId}:${credentialId}`);
  invalidateDefaults(orgId);
}

/**
 * Decrypts a credential for a model call. Backend-only: the Model Gateway is
 * its only caller. Org-scoped: a credential id from another org is not found.
 */
export async function decryptCredential(
  db: Database,
  keyWrappers: KeyWrapper[],
  orgId: string,
  credentialId: string,
): Promise<{
  provider: ProviderId;
  apiKey: string;
  workspaceId?: string;
  options?: { organization?: string; project?: string };
} | null> {
  // The row (ciphertext) is cached; the key is decrypted per call and never cached.
  const row = (await caches.credentials.getOrLoad(`${orgId}:${credentialId}`, async () => {
    const [r] = await db
      .select()
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.id, credentialId),
          eq(providerCredentials.orgId, orgId),
          isNull(providerCredentials.revokedAt),
        ),
      );
    return r ?? null;
  })) as typeof providerCredentials.$inferSelect | null;
  if (!row) return null;
  const apiKey = await openSecret(
    keyWrappers,
    { ciphertext: row.secretCiphertext, wrappedDataKey: row.wrappedDataKey, kekId: row.kekId },
    aadFor(orgId, row.id),
  );
  return {
    provider: row.provider as ProviderId,
    apiKey,
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    options: row.options ?? {},
  };
}

/**
 * Replaces the key of a credential, keeping its id (agents keep pointing at
 * it). The old ciphertext is overwritten; usage history is untouched.
 */
export async function rotateCredential(
  db: Database,
  keyWrapper: KeyWrapper,
  actorId: string,
  orgId: string,
  credentialId: string,
  input: {
    apiKey: string;
    label?: string;
    workspaceId?: string | null;
    organization?: string | null;
    project?: string | null;
  },
): Promise<CredentialSummary> {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  const apiKey = input.apiKey.trim();
  if (apiKey.length < 8) throw new ValidationError("apiKey looks too short");
  const sealed = await sealSecret(keyWrapper, apiKey, aadFor(orgId, credentialId));
  const [row] = await db
    .update(providerCredentials)
    .set({
      secretCiphertext: sealed.ciphertext,
      wrappedDataKey: sealed.wrappedDataKey,
      kekId: sealed.kekId,
      keyHint: apiKey.slice(-4),
      ...(input.label ? { label: input.label } : {}),
      ...(input.workspaceId !== undefined ? { workspaceId: cleanWorkspaceId(input.workspaceId) } : {}),
      ...(input.organization !== undefined || input.project !== undefined ? { options: cleanOptions(input) } : {}),
    })
    .where(
      and(
        eq(providerCredentials.id, credentialId),
        eq(providerCredentials.orgId, orgId),
        isNull(providerCredentials.revokedAt),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError("Credential not found");
  caches.credentials.delete(`${orgId}:${credentialId}`);
  invalidateDefaults(orgId);
  return summary(row);
}

/**
 * Deletes a credential for good (the sealed key is gone). Refused while
 * agents use it: they would silently fall back to the platform key.
 */
export async function deleteCredential(db: Database, actorId: string, orgId: string, credentialId: string) {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  await refuseIfDefault(db, orgId, credentialId);
  const users = await db
    .select({ handle: schema.agents.handle })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.orgId, orgId),
        eq(schema.agents.credentialId, credentialId),
        isNull(schema.agents.archivedAt),
      ),
    );
  if (users.length > 0) {
    throw new ConflictError(
      `In use by ${users.map((u) => `@${u.handle}`).join(", ")}. Point them at another key first.`,
    );
  }
  const deleted = await db
    .delete(providerCredentials)
    .where(and(eq(providerCredentials.id, credentialId), eq(providerCredentials.orgId, orgId)))
    .returning({ id: providerCredentials.id });
  if (deleted.length === 0) throw new NotFoundError("Credential not found");
  caches.credentials.delete(`${orgId}:${credentialId}`);
  invalidateDefaults(orgId);
}

/** How many active agents use each credential. */
export async function credentialUsage(db: Database, orgId: string) {
  const rows = await db
    .select({ credentialId: schema.agents.credentialId })
    .from(schema.agents)
    .where(and(eq(schema.agents.orgId, orgId), isNull(schema.agents.archivedAt)));
  const counts = new Map<string, number>();
  for (const r of rows) if (r.credentialId) counts.set(r.credentialId, (counts.get(r.credentialId) ?? 0) + 1);
  return counts;
}

/** Providers this org can call: it has an active key of its own, or the platform offers one. */
export async function availableProviders(
  db: Database,
  orgId: string,
  platform: {
    available?(orgId: string, provider: string): Promise<boolean>;
    resolve(orgId: string, provider: string): Promise<unknown>;
  },
  providers: string[],
) {
  const rows = await db
    .select({ provider: providerCredentials.provider })
    .from(providerCredentials)
    .where(and(eq(providerCredentials.orgId, orgId), isNull(providerCredentials.revokedAt)));
  const own = new Set(rows.map((r) => r.provider));
  const out = new Map<string, { own: boolean; platform: boolean }>();
  for (const p of providers) {
    const viaPlatform = platform.available
      ? await platform.available(orgId, p)
      : (await platform.resolve(orgId, p)) !== null;
    out.set(p, { own: own.has(p), platform: viaPlatform });
  }
  return out;
}
