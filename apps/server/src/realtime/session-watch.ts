import type { PubSub, Unsubscribe } from "@agenteschat/adapters";
import { and, type Database, gt, inArray, schema } from "@agenteschat/db";
import { SESSION_ENDED, sessionTopic } from "../auth";
import type { Logger } from "../logger";

/** How often open sockets' sessions are looked up again, for endings no event announced. */
export const SESSION_RECHECK_MS = 60_000;

/**
 * A person's socket lives only as long as the session it was opened with. Better Auth announces a session
 * that ended (sign-out, "sign out everywhere", a password reset, a deleted user) on `sessionTopic`, and the
 * sockets bound to it close at once, on every replica. Endings no event announces (a session that expired,
 * rows deleted outside Better Auth) are caught by one lookup of every watched session each
 * `SESSION_RECHECK_MS`, against the database rather than the signed cookie cache.
 */
export function createSessionWatch(deps: { db: Database; pubsub: PubSub; log?: Logger; recheckMs?: number }) {
  const watched = new Map<string, Set<() => void>>();
  let timer: ReturnType<typeof setInterval> | null = null;

  const end = (sessionId: string) => {
    const ends = watched.get(sessionId);
    if (!ends) return;
    watched.delete(sessionId);
    for (const fn of ends) fn();
  };

  async function sweep() {
    const ids = [...watched.keys()];
    if (ids.length === 0) return;
    const { sessions } = schema;
    const alive = new Set<string>();
    for (let i = 0; i < ids.length; i += 500) {
      const rows = await deps.db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(inArray(sessions.id, ids.slice(i, i + 500)), gt(sessions.expiresAt, new Date())));
      for (const row of rows) alive.add(row.id);
    }
    for (const id of ids) if (!alive.has(id)) end(id);
  }

  return {
    /** Calls `onEnd` once the session is gone. The returned function stops watching (the socket closed). */
    watch(userId: string, sessionId: string, onEnd: () => void): Unsubscribe {
      let done = false;
      const fire = () => {
        if (done) return;
        done = true;
        off();
        // Outside the publisher's call stack (in-memory pub/sub delivers synchronously).
        queueMicrotask(onEnd);
      };
      const off = deps.pubsub.subscribe(sessionTopic(userId), (event) => {
        if (event.type === SESSION_ENDED && event.sessionId === sessionId) end(sessionId);
      });
      const ends = watched.get(sessionId) ?? new Set();
      ends.add(fire);
      watched.set(sessionId, ends);
      if (!timer) {
        timer = setInterval(() => {
          sweep().catch((error) => deps.log?.warn("session recheck failed", { error: String(error) }));
        }, deps.recheckMs ?? SESSION_RECHECK_MS);
        timer.unref?.();
      }
      return () => {
        done = true;
        off();
        const set = watched.get(sessionId);
        set?.delete(fire);
        if (set?.size === 0) watched.delete(sessionId);
        if (watched.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
    /** One recheck now (tests). */
    sweep,
  };
}

export type SessionWatch = ReturnType<typeof createSessionWatch>;
