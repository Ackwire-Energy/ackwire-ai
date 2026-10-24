/**
 * Per-process caches for data read on every run but rarely changed (agent
 * config, org settings, channel rows and members, scopes, connections,
 * credential rows). Short TTL so other replicas' writes show up quickly;
 * writes in this process invalidate at once. Decrypted secrets are never
 * cached, only database rows.
 */
let enabled = false;

/**
 * Caching is off unless the server turns it on (`enableCaches()`): tests write
 * the database directly and expect every read to see it.
 */
export function enableCaches(on = true) {
  enabled = on;
  if (!on) clearCaches();
}

export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expires: number }>();
  constructor(
    private readonly ttlMs: number,
    private readonly max = 5000,
  ) {}

  get(key: string): V | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expires < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V) {
    if (this.entries.size >= this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  delete(key: string) {
    this.entries.delete(key);
  }

  /** Drops every key starting with `prefix` (e.g. everything of one org). */
  deletePrefix(prefix: string) {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }

  /** Returns the cached value or loads, caches and returns it (`undefined`/null results are cached too). */
  async getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    if (!enabled) return load();
    const hit = this.entries.get(key);
    if (hit && hit.expires >= Date.now()) return hit.value;
    const value = await load();
    this.set(key, value);
    return value;
  }
}

const TTL_MS = 30_000;

/** The engine's caches, keyed `orgId:id`. Invalidated by the functions that write them. */
export const caches = {
  agents: new TtlCache<unknown>(TTL_MS),
  orgs: new TtlCache<unknown>(TTL_MS),
  channels: new TtlCache<unknown>(TTL_MS),
  channelMembers: new TtlCache<unknown>(TTL_MS),
  scopes: new TtlCache<unknown>(TTL_MS),
  connections: new TtlCache<unknown>(TTL_MS),
  credentials: new TtlCache<unknown>(TTL_MS),
  /** Whether an org has any active context item (skips memory retrieval for empty orgs). */
  contextPresence: new TtlCache<unknown>(TTL_MS),
  /** Whether a thread's context range from another channel is still visible to everyone in the thread. */
  rangeVisible: new TtlCache<unknown>(TTL_MS),
  /** A person's time zone in an org, else the org's (`orgId:userId`): the "Now" block of every run. */
  zones: new TtlCache<unknown>(TTL_MS),
};

/** Forgets everything about an org (used after broad changes and in tests). */
export function invalidateOrg(orgId: string) {
  for (const c of Object.values(caches)) c.deletePrefix(`${orgId}:`);
}

export function clearCaches() {
  for (const c of Object.values(caches)) c.clear();
}
