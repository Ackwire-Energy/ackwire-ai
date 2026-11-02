import type { KeyWrapper, RelayCredentials } from "@agenteschat/adapters";
import { type Database, eq, schema } from "@agenteschat/db";
import { openSecret, type SealedSecret, sealSecret } from "./crypto";

const { instancePush } = schema;

/** Binds the sealed relay secret to its column, so it can't be swapped for another sealed value. */
const RELAY_SECRET_AAD = "instance_push:relay";

/**
 * This installation's credentials at the push relay (ADR 0123), in the `instance_push` row (id 1). The
 * secret is sealed with the installation's key: `wrappers()` gives the current key wrappers, the first
 * one sealing (read on each call, since modules may replace them after boot). Credentials from another
 * relay (`url` changed) or that no longer open (`AGENTES_SECRET` changed) read as none, so the sender
 * registers again.
 */
export function relayCredentials(db: Database, wrappers: () => KeyWrapper[], url: string): RelayCredentials {
  return {
    async get() {
      const [row] = await db
        .select({
          relayUrl: instancePush.relayUrl,
          relayInstanceId: instancePush.relayInstanceId,
          relaySecret: instancePush.relaySecret,
        })
        .from(instancePush)
        .where(eq(instancePush.id, 1))
        .limit(1);
      if (!row || row.relayUrl !== url || !row.relayInstanceId || !row.relaySecret) return null;
      try {
        const secret = await openSecret(wrappers(), JSON.parse(row.relaySecret) as SealedSecret, RELAY_SECRET_AAD);
        return { instanceId: row.relayInstanceId, secret };
      } catch {
        return null;
      }
    },
    async save(credentials) {
      const [sealer] = wrappers();
      if (!sealer) throw new Error("no key wrapper to seal the push relay's secret");
      const sealed = JSON.stringify(await sealSecret(sealer, credentials.secret, RELAY_SECRET_AAD));
      const values = {
        relayUrl: url,
        relayInstanceId: credentials.instanceId,
        relaySecret: sealed,
        updatedAt: new Date(),
      };
      await db
        .insert(instancePush)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: instancePush.id, set: values });
    },
    async clear() {
      await db
        .update(instancePush)
        .set({ relayUrl: null, relayInstanceId: null, relaySecret: null, updatedAt: new Date() })
        .where(eq(instancePush.id, 1));
    },
  };
}
