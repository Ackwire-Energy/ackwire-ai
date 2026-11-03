/**
 * Real-time fan-out between server instances (docs/adr/0010-realtime.md).
 * Core: in-memory (one process) or Postgres LISTEN/NOTIFY (several replicas).
 * Cloud may register Redis pub/sub. Postgres stays the source of truth: only
 * already-committed facts and ephemeral stream deltas travel here.
 */
export interface RealtimeEvent {
  type: string;
  [key: string]: unknown;
}

export type Unsubscribe = () => void;

export interface PubSub {
  publish(topic: string, event: RealtimeEvent): Promise<void>;
  /** Handlers run for events published by any instance, including this one. */
  subscribe(topic: string, handler: (event: RealtimeEvent) => void): Unsubscribe;
  close?(): Promise<void>;
}

/** Topic of everything happening in one channel. */
export const channelTopic = (channelId: string) => `channel:${channelId}`;

/** Server-side: every `user.typing`, also published on its channel's topic (an agent's quiet window, ADR 0112). */
export const typingTopic = "typing";

/** Server-side organization events (membership changes). Never forwarded to clients as is. */
export const orgTopic = (orgId: string) => `org:${orgId}`;

/** Events for one person in one organization (approvals waiting for them, DMs). */
export const userTopic = (orgId: string, userId: string) => `user:${orgId}:${userId}`;

/** Server-side: each new message's channel, for the unread marks of its members' sockets. Never forwarded as is. */
export const chatActivityTopic = "chat-activity";

/** Server-side signal that one upload to the Drive finished (`upload_file`, ADR 0025). Never forwarded to clients. */
export const uploadTopic = (uploadId: string) => `upload:${uploadId}`;

/** Server-side: a request (`machine_rpc` row) for a machine whose socket this replica holds (ADR 0025). */
export const machineRpcTopic = (replicaId: string) => `machine-rpc:${replicaId}`;

/** Server-side: the reply to one `machine_rpc` row is written. */
export const machineRpcReplyTopic = (rpcId: string) => `machine-rpc-reply:${rpcId}`;

/** Server-side: the `brain.event` frames of one run's brain turn on a connected computer (ADR 0032). */
export const brainTopic = (runId: string) => `brain:${runId}`;

function deliver(handlers: Set<(event: RealtimeEvent) => void> | undefined, event: RealtimeEvent) {
  for (const handler of handlers ?? []) {
    try {
      handler(event);
    } catch {
      // One broken subscriber must not stop the others.
    }
  }
}

class Registry {
  readonly topics = new Map<string, Set<(event: RealtimeEvent) => void>>();
  add(topic: string, handler: (event: RealtimeEvent) => void): Unsubscribe {
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
      if (set.size === 0) this.topics.delete(topic);
    };
  }
}

/** Single-process pub/sub. Default for tests and single-instance self-host. */
export function createMemoryPubSub(): PubSub {
  const registry = new Registry();
  return {
    async publish(topic, event) {
      deliver(registry.topics.get(topic), structuredClone(event));
    },
    subscribe: (topic, handler) => registry.add(topic, handler),
  };
}

/** Minimal LISTEN/NOTIFY surface, implemented by postgres.js (prod) and PGlite (tests). */
export interface PgNotifier {
  listen(channel: string, onPayload: (payload: string) => void): Promise<() => Promise<void>>;
  notify(channel: string, payload: string): Promise<void>;
  /** Several notifications in one statement (one round trip), in order. Optional. */
  notifyMany?(channel: string, payloads: string[]): Promise<void>;
}

/** Postgres rejects NOTIFY payloads of 8000 bytes or more. */
export const MAX_NOTIFY_BYTES = 7900;

export class PayloadTooLargeError extends Error {
  constructor(bytes: number) {
    super(`pub/sub payload is ${bytes} bytes; the limit is ${MAX_NOTIFY_BYTES}. Publish ids, not documents.`);
    this.name = "PayloadTooLargeError";
  }
}

const PG_CHANNEL = "agenteschat_events";

/**
 * Pub/sub over Postgres LISTEN/NOTIFY: one NOTIFY channel, topic inside the
 * payload. Works across replicas with no extra infrastructure. Payloads must
 * stay small (ids and short deltas), see `MAX_NOTIFY_BYTES`.
 */
export async function createPostgresPubSub(notifier: PgNotifier): Promise<PubSub> {
  const registry = new Registry();
  const unlisten = await notifier.listen(PG_CHANNEL, (payload) => {
    try {
      const { t, e } = JSON.parse(payload) as { t: string; e: RealtimeEvent };
      deliver(registry.topics.get(t), e);
    } catch {
      // Ignore malformed payloads from other software on the same channel.
    }
  });
  // Publishing doesn't wait for the database: events queue in order and go out
  // together in one statement per tick (a remote database costs one round trip
  // per batch, not per event). Delivery stays best effort, as before.
  let queue: string[] = [];
  let flushing: Promise<void> = Promise.resolve();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const batch = queue;
    queue = [];
    if (batch.length === 0) return;
    flushing = flushing
      .then(async () => {
        if (notifier.notifyMany && batch.length > 1) await notifier.notifyMany(PG_CHANNEL, batch);
        else for (const payload of batch) await notifier.notify(PG_CHANNEL, payload);
      })
      .catch(() => {});
  };
  return {
    async publish(topic, event) {
      const payload = JSON.stringify({ t: topic, e: event });
      const bytes = Buffer.byteLength(payload);
      if (bytes > MAX_NOTIFY_BYTES) throw new PayloadTooLargeError(bytes);
      queue.push(payload);
      if (!scheduled) {
        scheduled = true;
        setTimeout(flush, 0); // after awaited publishes of this tick have queued too
      }
    },
    subscribe: (topic, handler) => registry.add(topic, handler),
    close: async () => {
      flush();
      await flushing;
      await unlisten();
    },
  };
}

/** Adapts a postgres.js client (`createDatabase().client`). */
export function postgresJsNotifier(client: {
  listen(channel: string, fn: (payload: string) => void): Promise<{ unlisten(): Promise<void> }>;
  notify(channel: string, payload: string): Promise<unknown>;
  unsafe?(query: string, params: string[]): Promise<unknown>;
}): PgNotifier {
  return {
    async listen(channel, onPayload) {
      const sub = await client.listen(channel, onPayload);
      return () => sub.unlisten();
    },
    async notify(channel, payload) {
      await client.notify(channel, payload);
    },
    async notifyMany(channel, payloads) {
      if (!client.unsafe) {
        for (const p of payloads) await client.notify(channel, p);
        return;
      }
      const calls = payloads.map((_, i) => `pg_notify($1, $${i + 2})`).join(", ");
      await client.unsafe(`select ${calls}`, [channel, ...payloads]);
    },
  };
}
