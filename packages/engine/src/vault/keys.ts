/**
 * Several keys in one save (ADR 0144 §11): what an imported .env file becomes. The app reads the file and sends
 * names and values; this checks each as a single key is checked, then writes them all or none. A name already saved
 * in the scope is left as it is unless the person asked to replace it, and then only its value changes: its access
 * and its note stay. Values are sealed before the transaction and appear in no audit row, use, event or error.
 */
import { and, eq, isNull, schema } from "@agenteschat/db";
import { recordAudit } from "../audit";
import { ConflictError, ValidationError } from "../errors";
import { publishVaultChanged } from "../events";
import { cleanAccess, type ItemRow } from "./access";
import {
  assertRoom,
  cleanKeyName,
  cleanScope,
  cleanSecret,
  keyHintOf,
  teamNeedsPermission,
  vaultViewer,
} from "./items";
import { sealItemValue } from "./seal";
import {
  VAULT_LIMITS,
  type VaultDeps,
  type VaultKeysImportInput,
  type VaultKeysImportResult,
  vaultNow,
} from "./service";

const { vaultItems, vaultUses } = schema;

export async function importVaultKeys(
  deps: VaultDeps,
  userId: string,
  orgId: string,
  input: VaultKeysImportInput,
): Promise<VaultKeysImportResult> {
  const { db } = deps;
  const viewer = await vaultViewer(db, userId, orgId);
  const scope = cleanScope(input.scope);
  if (scope === "team" && !viewer.manages) throw teamNeedsPermission();
  const ownerUserId = scope === "personal" ? userId : null;
  const max = VAULT_LIMITS.importKeys;
  if (!Array.isArray(input.keys) || input.keys.length === 0)
    throw new ValidationError("Nothing to save", "vault.no_value");
  if (input.keys.length > max) throw new ValidationError(`At most ${max} keys at once`, "vault.too_many_keys", { max });
  // A name sent twice keeps its last value, as in the file it came from.
  const wanted = new Map<string, { secret: string; replace: boolean }>();
  for (const key of input.keys)
    wanted.set(cleanKeyName(key.keyName), { secret: cleanSecret(key.secret, "key"), replace: key.replace === true });
  const access = await cleanAccess(db, orgId, scope, input.access);

  const saved = new Map<string, ItemRow>();
  for (const row of await db
    .select()
    .from(vaultItems)
    .where(
      and(
        eq(vaultItems.orgId, orgId),
        eq(vaultItems.kind, "key"),
        isNull(vaultItems.connectionId),
        ownerUserId ? eq(vaultItems.ownerUserId, ownerUserId) : isNull(vaultItems.ownerUserId),
      ),
    ))
    if (row.keyName) saved.set(row.keyName, row);

  const now = vaultNow(deps);
  const added: (typeof vaultItems.$inferInsert)[] = [];
  const replaced: { item: ItemRow; set: Partial<typeof vaultItems.$inferInsert> }[] = [];
  let skipped = 0;
  for (const [keyName, { secret, replace }] of wanted) {
    const item = saved.get(keyName);
    if (item && !replace) skipped++;
    else if (item) {
      const sealed = await sealItemValue(deps, item, item.secretVersion + 1, secret);
      replaced.push({ item, set: { ...sealed, keyHint: keyHintOf(secret), previousSecrets: [], updatedAt: now } });
    } else {
      const id = Bun.randomUUIDv7();
      added.push({
        id,
        orgId,
        kind: "key",
        ownerUserId,
        title: keyName,
        keyName,
        keyHint: keyHintOf(secret),
        ...(await sealItemValue(deps, { orgId, id, ownerUserId }, 1, secret)),
        ...access,
        createdByUserId: userId,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  const result = { added: added.length, replaced: replaced.length, skipped };
  if (added.length === 0 && replaced.length === 0) return result;

  await assertRoom(db, orgId, added.length);
  await db.transaction(async (tx) => {
    if (added.length > 0) await tx.insert(vaultItems).values(added);
    for (const { item, set } of replaced) {
      const [done] = await tx
        .update(vaultItems)
        .set(set)
        .where(
          and(
            eq(vaultItems.orgId, orgId),
            eq(vaultItems.id, item.id),
            eq(vaultItems.secretVersion, item.secretVersion),
          ),
        )
        .returning({ id: vaultItems.id });
      if (!done) throw new ConflictError("Some keys changed meanwhile. Import again.", "vault.changed_meanwhile");
    }
    await tx
      .insert(vaultUses)
      .values([
        ...added.map((row) => ({ orgId, itemId: row.id as string, action: "create", userId, createdAt: now })),
        ...replaced.map(({ item }) => ({ orgId, itemId: item.id, action: "edit", userId, createdAt: now })),
      ]);
    await recordAudit(tx, {
      orgId,
      actor: { type: "person", id: userId },
      action: "vault.keys_imported",
      target: { type: "vault", id: null },
      details: { scope, ...result },
    });
  });
  await publishVaultChanged(deps.pubsub, orgId);
  return result;
}
