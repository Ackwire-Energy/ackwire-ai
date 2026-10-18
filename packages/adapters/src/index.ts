import type { BlobStore } from "./blob";
import type { EmailSender } from "./email";
import type { KeyWrapper, PlatformCredentials } from "./keys";
import type { MailAdapters } from "./mail";
import type { Presence } from "./presence";
import type { PubSub } from "./pubsub";
import type { PushSender } from "./push";
import type { RateLimiter } from "./rate-limiter";
import type { SandboxProvider } from "./sandbox";
import type { SearchIndexResolver } from "./search";

export * from "./blob";
export * from "./blob-postgres";
export * from "./command-policy";
export * from "./composio";
export * from "./email";
export * from "./imap";
export * from "./keys";
export * from "./machine-protocol";
export * from "./mail";
export * from "./mail-fake";
export * from "./mail-presets";
export * from "./presence";
export * from "./pubsub";
export * from "./push";
export * from "./rate-limiter";
export * from "./s3";
export * from "./s3-fake";
export * from "./sandbox";
export * from "./search";
export * from "./secret-box";

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
  /** Transactional email (sent from the `email.send` outbox job). */
  email: EmailSender;
  /**
   * Platform file storage (our bucket, or Postgres without one). Orgs with
   * their own bucket are resolved on top of it by the engine.
   */
  platformBlobs: BlobStore;
  /** Where agents run code (D30): Daytona in the Cloud; null/absent = the sandbox tools are off. */
  sandbox?: SandboxProvider | null;
  /** Push to the phone app (`push.send` outbox job, ADR 0035); null/absent = no push. */
  push?: PushSender | null;
  /** People's mailboxes for agents (ADR 0038); absent = no email connectors. */
  mail?: MailAdapters;
}
