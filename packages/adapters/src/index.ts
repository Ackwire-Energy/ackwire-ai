import type { BlobStore } from "./blob";
import type { DatabaseDriver } from "./database";
import type { EmailSender } from "./email";
import type { HumanCheck } from "./human-check";
import type { KeyWrapper, PlatformCredentials } from "./keys";
import type { MailAdapters } from "./mail";
import type { Presence } from "./presence";
import type { PubSub } from "./pubsub";
import type { PushSender } from "./push";
import type { RateLimiter } from "./rate-limiter";
import type { SandboxProvider } from "./sandbox";
import type { SearchIndexResolver } from "./search";
import type { WebPushSender } from "./web-push";

export * from "./blob";
export * from "./blob-disk";
export * from "./blob-postgres";
export * from "./command-policy";
export * from "./composio";
export * from "./database";
export * from "./email";
export * from "./human-check";
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
export * from "./redact";
export * from "./s3";
export * from "./s3-fake";
export * from "./sandbox";
export * from "./search";
export * from "./secret-box";
export * from "./web-push";

/**
 * Infrastructure the core talks to through interfaces, so each edition can
 * plug its own implementation (ADR 0002). The server builds
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
   * Platform file storage (our bucket, a folder on disk, or Postgres). Orgs with
   * their own bucket are resolved on top of it by the engine.
   */
  platformBlobs: BlobStore;
  /** Where agents run code (ADR 0021): Daytona in the Cloud; null/absent = the sandbox tools are off. */
  sandbox?: SandboxProvider | null;
  /** Push to the phone app (`push.send` outbox job, ADR 0035); null/absent = no push. */
  push?: PushSender | null;
  /** Web Push to browsers (`push.send` outbox job, ADR 0071); null/absent = browsers get no push. */
  webPush?: WebPushSender | null;
  /** People's mailboxes for agents (ADR 0038); absent = no email connectors. */
  mail?: MailAdapters;
  /** People's Postgres databases for agents (ADR 0039); null/absent = no database connector. */
  databases?: DatabaseDriver | null;
  /** A bot check before public forms (ADR 0075): Turnstile when both of its keys are set; null/absent = none. */
  humanCheck?: HumanCheck | null;
}
