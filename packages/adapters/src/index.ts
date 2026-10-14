import type { KeyWrapper, PlatformCredentials } from "./keys";
import type { Presence } from "./presence";
import type { PubSub } from "./pubsub";
import type { RateLimiter } from "./rate-limiter";
import type { SearchIndexResolver } from "./search";

export * from "./keys";
export * from "./presence";
export * from "./pubsub";
export * from "./rate-limiter";
export * from "./search";

/**
 * Infrastructure the core talks to through interfaces, so each edition can
 * plug its own implementation (docs/planejamento.md D18a). The server builds
 * core defaults, then applies each module's overrides in order.
 */
export interface Adapters {
  search: SearchIndexResolver;
  pubsub: PubSub;
  presence: Presence;
  rateLimiter: RateLimiter;
  keyWrapper: KeyWrapper;
  /** Extra wrappers that can only unwrap (old keys during rotation). */
  legacyKeyWrappers: KeyWrapper[];
  platformCredentials: PlatformCredentials;
}
