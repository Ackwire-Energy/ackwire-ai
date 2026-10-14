export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
}

/**
 * Throttling for our own endpoints (posting messages, WebSocket frames).
 * Sign-in has its own limiter inside Better Auth. Core: in-memory fixed
 * window, per process. Cloud: Redis.
 */
export interface RateLimiter {
  consume(key: string, rule: { limit: number; windowMs: number }): Promise<RateLimitResult>;
}

export function createMemoryRateLimiter(now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    async consume(key, rule) {
      const t = now();
      let w = windows.get(key);
      if (!w || w.resetAt <= t) {
        w = { count: 0, resetAt: t + rule.windowMs };
        windows.set(key, w);
      }
      w.count++;
      if (windows.size > 50_000) {
        for (const [k, v] of windows) if (v.resetAt <= t) windows.delete(k);
      }
      return {
        allowed: w.count <= rule.limit,
        remaining: Math.max(0, rule.limit - w.count),
        resetAt: new Date(w.resetAt),
      };
    },
  };
}
