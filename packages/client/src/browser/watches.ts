/**
 * Who watches which agent's browser on one realtime socket (ADR 0040 §7).
 * Several views of the same agent (the card on its message, the bar, the full
 * live view) share one `browser.watch`: it goes out when the first one starts,
 * and `browser.unwatch` only a moment after the last one leaves, so a
 * re-render or a remount (React's StrictMode, a list that re-keys) doesn't
 * stop and start the stream on the computer.
 */

/** How long after the last view leaves before `browser.unwatch` (a view coming back meanwhile keeps it). */
export const BROWSER_UNWATCH_DELAY_MS = 1500;

export interface BrowserWatcher {
  /** One view of this agent's browser starts; call the result when it leaves. */
  acquire(agentId: string): () => void;
  /** Watch again now (the server dropped the watch: a retry after `reconnecting`, an ended stream). */
  rewatch(agentId: string): void;
}

export interface BrowserWatches extends BrowserWatcher {
  /** After the socket (re)opened: every agent someone is looking at is watched again (the server forgot them). */
  resumeAll(): void;
  /** Agents watched now (tests, debugging). */
  watching(): string[];
}

export function createBrowserWatches(options: {
  send(frame: { type: "browser.watch" | "browser.unwatch"; agentId: string }): void;
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void };
  unwatchDelayMs?: number;
}): BrowserWatches {
  const timers = options.timers ?? {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  const delay = options.unwatchDelayMs ?? BROWSER_UNWATCH_DELAY_MS;
  const entries = new Map<string, { count: number; leaving: unknown }>();
  return {
    acquire(agentId) {
      const entry = entries.get(agentId);
      if (entry) {
        entry.count++;
        // Back before the unwatch went out: the watch on the server still holds.
        if (entry.leaving !== null) {
          timers.clearTimeout(entry.leaving);
          entry.leaving = null;
        }
      } else {
        entries.set(agentId, { count: 1, leaving: null });
        options.send({ type: "browser.watch", agentId });
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const e = entries.get(agentId);
        if (!e) return;
        e.count--;
        if (e.count > 0) return;
        e.leaving = timers.setTimeout(() => {
          const now = entries.get(agentId);
          if (!now || now.count > 0) return;
          entries.delete(agentId);
          options.send({ type: "browser.unwatch", agentId });
        }, delay);
      };
    },
    rewatch(agentId) {
      const e = entries.get(agentId);
      if (e && e.count > 0) options.send({ type: "browser.watch", agentId });
    },
    resumeAll() {
      for (const [agentId, e] of entries) if (e.count > 0) options.send({ type: "browser.watch", agentId });
    },
    watching: () => [...entries.entries()].filter(([, e]) => e.count > 0).map(([id]) => id),
  };
}
