/**
 * A Vault source (ADR 0135): where the values of some Vault items live. The built-in source (Postgres, sealed with
 * the installation's key wrapper, ADR 0007) lives in the engine; 1Password and Bitwarden are adapters here, and a
 * module can add more through `AgentesModule.adapters()` (`vaultSources`, merged by kind).
 *
 * Nothing outside a source knows which one it is: access, history, the box to the computer and the runner's checks
 * are the same for every item. A source only connects, lists metadata and resolves one value when asked.
 *
 * Rules every source keeps (a shared contract test runs them):
 * - `list` returns metadata only. A password, a key or anything secret never appears in a `VaultSourceItem`.
 * - `reveal` returns one value for one field of one item and keeps nothing.
 * - Every failure is a `VaultSourceError` with a code. A provider's own message is never stored or shown: it may
 *   carry a token.
 * - `connect` validates what the person typed and returns what to keep, split into `config` (shown on screen) and
 *   `secret` (sealed at rest by the engine, never returned to a client).
 */
import type { VaultMatch } from "./site";

export type VaultItemKind = "login" | "key" | "contact";

/** A field a source can resolve. */
export type VaultSecretField = "password" | "key";

/** One field of the connect form. Labels come from i18n (`vault.source.<kind>.field.<id>`), `label` is English. */
export interface VaultConnectField {
  id: string;
  kind: "text" | "secret" | "url" | "email" | "choice";
  /** English label, used when the app has no translation (a module's own source). */
  label: string;
  required: boolean;
  placeholder?: string;
  /** For `choice`: the values, each with an English label. */
  choices?: { value: string; label: string }[];
  /** Default value shown in the form. */
  initial?: string;
}

/** What the app shows to connect a source. Every word has an i18n key; the English text is the fallback. */
export interface VaultSourceDescriptor {
  kind: string;
  /** Brand name, never translated (`1Password`, `Bitwarden`). */
  name: string;
  /** Item kinds this source can hold. */
  kinds: VaultItemKind[];
  /** The numbered steps of the connect card, in English (i18n: `vault.source.<kind>.step.<n>`). */
  steps: string[];
  fields: VaultConnectField[];
  /** A warning shown above the form (English; i18n `vault.source.<kind>.warning`), or none. */
  warning?: string;
  /** Where the person creates what the steps ask for, if anywhere. */
  helpUrl?: string;
}

/** What a source keeps for one connection, as the engine hands it back (the secret already unsealed). */
export interface VaultConnection {
  id: string;
  orgId: string;
  config: Record<string, string>;
  secret: Record<string, string>;
}

/** One item as a source lists it. Metadata only. */
export interface VaultSourceItem {
  /** The item's id in the source, stable across syncs. */
  ref: string;
  kind: VaultItemKind;
  title: string;
  /** Login: the HTTPS websites it may fill, with the source's own match ("never" websites left out). */
  websites?: { url: string; match: VaultMatch }[];
  username?: string;
  /** Key: the environment variable name (`UPPER_SNAKE`), when the source says or the title is one. */
  keyName?: string;
  /** A short description people wrote (never a secret field). */
  description?: string;
  /** When the source last changed it, if it says (ISO). */
  updatedAt?: string;
}

export type VaultSourceErrorCode =
  | "auth_failed"
  | "locked"
  | "many_vaults"
  | "no_vault"
  | "folder_missing"
  | "not_found"
  | "rate_limited"
  | "unreachable"
  | "unsupported"
  | "invalid_input";

/** A failure a person or an agent can act on. `message` is ours (English), never the provider's text. */
export class VaultSourceError extends Error {
  constructor(
    readonly code: VaultSourceErrorCode,
    message: string,
    /** When to try again, for `rate_limited` (ISO). */
    readonly retryAt?: string,
  ) {
    super(message);
    this.name = "VaultSourceError";
  }
}

export interface VaultConnectResult {
  /** What the connection reads, for people: a vault's or a folder's name. */
  label: string;
  config: Record<string, string>;
  secret: Record<string, string>;
}

export interface VaultSource {
  readonly kind: string;
  describe(): VaultSourceDescriptor;
  /** Validates `input` against the provider and returns what to keep. Throws `VaultSourceError`. */
  connect(input: Record<string, string>, signal?: AbortSignal): Promise<VaultConnectResult>;
  /** Every item the connection reads, metadata only. Throws `VaultSourceError`. */
  list(connection: VaultConnection, signal?: AbortSignal): Promise<VaultSourceItem[]>;
  /** One value, read now and kept nowhere. Throws `VaultSourceError` (`not_found` when the item or field is gone). */
  reveal(connection: VaultConnection, ref: string, field: VaultSecretField, signal?: AbortSignal): Promise<string>;
}

/** Sources by kind, as the engine receives them (the built-in one is the engine's own). */
export type VaultSources = Record<string, VaultSource>;
