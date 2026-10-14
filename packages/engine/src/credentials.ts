import type { KeyWrapper } from "@agenteschat/adapters";
import { and, asc, type Database, eq, isNull, schema } from "@agenteschat/db";
import { isKnownProvider, type ProviderId } from "@agenteschat/providers";
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
  createdAt: Date;
  revokedAt: Date | null;
}

const summary = (row: typeof providerCredentials.$inferSelect): CredentialSummary => ({
  id: row.id,
  provider: row.provider as ProviderId,
  label: row.label,
  keyHint: row.keyHint,
  createdAt: row.createdAt,
  revokedAt: row.revokedAt,
});

/** Stores an org's provider API key, encrypted (envelope encryption). */
export async function createCredential(
  db: Database,
  keyWrapper: KeyWrapper,
  actorId: string,
  orgId: string,
  input: { provider: ProviderId; label: string; apiKey: string },
): Promise<CredentialSummary> {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  if (!isKnownProvider(input.provider)) throw new ValidationError(`Unknown provider ${input.provider}`);
  const apiKey = input.apiKey.trim();
  if (apiKey.length < 8) throw new ValidationError("apiKey looks too short");
  const id = crypto.randomUUID();
  const sealed = await sealSecret(keyWrapper, apiKey, aadFor(orgId, id));
  const [row] = await db
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
      createdByUserId: actorId,
    })
    .returning();
  if (!row) throw new Error("credential insert returned nothing");
  return summary(row);
}

export async function listCredentials(db: Database, actorId: string, orgId: string): Promise<CredentialSummary[]> {
  await requirePermission(db, actorId, orgId, "manage_credentials");
  const rows = await db
    .select()
    .from(providerCredentials)
    .where(eq(providerCredentials.orgId, orgId))
    .orderBy(asc(providerCredentials.createdAt));
  return rows.map(summary);
}

/** Revoked keys stay stored (usage records point at them) but can no longer be decrypted for calls. */
export async function revokeCredential(db: Database, actorId: string, orgId: string, credentialId: string) {
  await requirePermission(db, actorId, orgId, "manage_credentials");
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
): Promise<{ provider: ProviderId; apiKey: string } | null> {
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
  if (!row) return null;
  const apiKey = await openSecret(
    keyWrappers,
    { ciphertext: row.secretCiphertext, wrappedDataKey: row.wrappedDataKey, kekId: row.kekId },
    aadFor(orgId, row.id),
  );
  return { provider: row.provider as ProviderId, apiKey };
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
  input: { apiKey: string; label?: string },
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
  return summary(row);
}

/**
 * Deletes a credential for good (the sealed key is gone). Refused while
 * agents use it: they would silently fall back to the platform key.
 */
export async function deleteCredential(db: Database, actorId: string, orgId: string, credentialId: string) {
  await requirePermission(db, actorId, orgId, "manage_credentials");
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
