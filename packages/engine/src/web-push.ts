import { generateVapidKeys, type KeyWrapper, type VapidKeys } from "@agenteschat/adapters";
import { and, type Database, eq, isNull, schema } from "@agenteschat/db";
import { openSecret, type SealedSecret, sealSecret } from "./crypto";

const { instancePush } = schema;

/**
 * This installation's VAPID key pair for Web Push (ADR 0071): made the first time it's needed and kept
 * in `instance_push` (row 1), the private key sealed with the installation's key. Env vars, when both
 * are set, pin a pair instead (never stored). If the stored key can't be opened anymore
 * (`AGENTES_SECRET` changed), a new pair replaces it: subscriptions made for the old one are refused by
 * their push service and deleted on the next send, and pages subscribe again with the new public key.
 */

const VAPID_AAD = "instance_push:vapid";

export interface VapidConfig {
  PUBLIC_URL: string;
  EMAIL_FROM?: string;
  WEB_PUSH_VAPID_PUBLIC_KEY?: string;
  WEB_PUSH_VAPID_PRIVATE_KEY?: string;
}

/**
 * Who runs this server, as push services want it (RFC 8292 §2.1): `PUBLIC_URL` when it is https, else
 * `mailto:` the sender address when there is one, else `PUBLIC_URL` as it is.
 */
export function vapidSubject(config: Pick<VapidConfig, "PUBLIC_URL" | "EMAIL_FROM">): string {
  if (config.PUBLIC_URL.startsWith("https://")) return config.PUBLIC_URL.replace(/\/+$/, "");
  const from = config.EMAIL_FROM?.trim() ?? "";
  // `Name <ops@example.com>` or a bare address.
  const address = /<([^<>\s]+@[^<>\s]+)>/.exec(from)?.[1] ?? from;
  if (/^[^\s@<>]+@[^\s@<>]+$/.test(address)) return `mailto:${address}`;
  return config.PUBLIC_URL.replace(/\/+$/, "");
}

/** One stored pair per database, per process (the pair changes only when the key that seals it does). */
const cache = new WeakMap<Database, Promise<{ publicKey: string; privateKey: string }>>();

/** Gets or makes this installation's VAPID key pair (cached per process). `wrappers[0]` seals a new one. */
export async function vapidKeys(db: Database, wrappers: KeyWrapper[], config: VapidConfig): Promise<VapidKeys> {
  const subject = vapidSubject(config);
  if (config.WEB_PUSH_VAPID_PUBLIC_KEY && config.WEB_PUSH_VAPID_PRIVATE_KEY) {
    return { publicKey: config.WEB_PUSH_VAPID_PUBLIC_KEY, privateKey: config.WEB_PUSH_VAPID_PRIVATE_KEY, subject };
  }
  let pending = cache.get(db);
  if (!pending) {
    pending = storedVapidKeys(db, wrappers);
    cache.set(db, pending);
    // A failure (database down) is tried again on the next call.
    pending.catch(() => cache.delete(db));
  }
  return { ...(await pending), subject };
}

async function storedVapidKeys(db: Database, wrappers: KeyWrapper[]) {
  const sealer = wrappers[0];
  if (!sealer) throw new Error("no key wrapper to seal the VAPID key with");
  await db.insert(instancePush).values({ id: 1 }).onConflictDoNothing();
  // Several replicas may race to make the pair: each replaces only what it read, and a loser reads the winner's.
  for (let attempt = 0; attempt < 3; attempt++) {
    const [row] = await db
      .select({ publicKey: instancePush.vapidPublicKey, privateKey: instancePush.vapidPrivateKey })
      .from(instancePush)
      .where(eq(instancePush.id, 1));
    if (row?.publicKey && row.privateKey) {
      const opened = await openStored(wrappers, row.privateKey);
      if (opened) return { publicKey: row.publicKey, privateKey: opened };
    }
    const fresh = generateVapidKeys();
    const sealed = JSON.stringify(await sealSecret(sealer, fresh.privateKey, VAPID_AAD));
    const replaced = await db
      .update(instancePush)
      .set({ vapidPublicKey: fresh.publicKey, vapidPrivateKey: sealed, updatedAt: new Date() })
      .where(
        and(
          eq(instancePush.id, 1),
          row?.publicKey ? eq(instancePush.vapidPublicKey, row.publicKey) : isNull(instancePush.vapidPublicKey),
        ),
      )
      .returning({ id: instancePush.id });
    if (replaced.length > 0) return fresh;
  }
  throw new Error("couldn't store this installation's VAPID key");
}

/** The stored private key, or null when it can't be opened (another `AGENTES_SECRET`, a damaged value). */
async function openStored(wrappers: KeyWrapper[], stored: string): Promise<string | null> {
  try {
    return await openSecret(wrappers, JSON.parse(stored) as SealedSecret, VAPID_AAD);
  } catch {
    return null;
  }
}
