/**
 * The Vault as the apps see it (ADR 0135). Never a password or a key: only `reveal` answers with one, to a person
 * who manages the item, and that is recorded as a use.
 */

export type VaultItemKind = "login" | "key" | "contact";
export type VaultScope = "personal" | "team";
export type VaultMatch = "exact" | "site";

/** Who has access to an item (or the default of a connection's items). */
export interface VaultAccess {
  /** Team items: everyone in the workspace. Ignored for personal items. */
  everyone: boolean;
  roleIds: string[];
  userIds: string[];
  /** Every agent may use it (for a personal item: any agent, when its owner is the one asking). */
  allAgents: boolean;
  agentIds: string[];
}

export interface VaultContactFields {
  fullName?: string;
  company?: string;
  /** CPF, CNPJ, VAT or any tax id. */
  document?: string;
  email?: string;
  phone?: string;
  address?: string;
  address2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

export interface VaultItem {
  id: string;
  kind: VaultItemKind;
  scope: VaultScope;
  /** Owner of a personal item. */
  ownerUserId: string | null;
  title: string;
  description: string;
  /** Login: `https://host[:port]`. */
  website: string | null;
  match: VaultMatch;
  username: string | null;
  /** Key: the variable name. */
  keyName: string | null;
  /** Key: the last 4 characters, to tell keys apart. */
  keyHint: string | null;
  /** Login or key: a value is saved. */
  hasSecret: boolean;
  contact: VaultContactFields | null;
  /** null = built-in. */
  connectionId: string | null;
  /** The source's brand name when external (`1Password`). */
  sourceName: string | null;
  /** External items follow their connection's access until someone changes theirs. */
  accessFromConnection: boolean;
  /** The access that applies now (the connection's when `accessFromConnection`). */
  access: VaultAccess;
  /** Gone from its source at the last sync. */
  missing: boolean;
  createdByUserId: string | null;
  createdByAgentId: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** What the viewer may do with it. */
  can: { edit: boolean; reveal: boolean; delete: boolean };
}

export type VaultUseAction = "fill" | "key" | "read" | "show" | "copy" | "create" | "edit";

export interface VaultUse {
  id: string;
  action: VaultUseAction;
  agentId: string | null;
  /** The person who showed, copied, created or edited it. */
  userId: string | null;
  /** The person an agent worked for. */
  onBehalfOfUserId: string | null;
  /** A routine's name when a routine was behind it. */
  routineName: string | null;
  /** Where a login was typed (`https://host`). */
  origin: string | null;
  at: string;
}

export interface VaultItemDetail extends VaultItem {
  uses: VaultUse[];
}

export type VaultConnectionStatus = "ready" | "error" | "syncing";

export interface VaultConnection {
  id: string;
  kind: string;
  /** Brand name (`1Password`). */
  name: string;
  scope: VaultScope;
  ownerUserId: string | null;
  /** What it reads (a vault's or a folder's name). */
  label: string;
  /** Non-secret settings shown on screen (server address, folder…). */
  config: Record<string, string>;
  /** Default access of its items. */
  access: VaultAccess;
  status: VaultConnectionStatus;
  /** A `VaultSourceErrorCode` when `status` is `error`. */
  errorCode: string | null;
  itemCount: number;
  syncedAt: string | null;
  can: { edit: boolean };
}

export interface VaultConnectField {
  id: string;
  kind: "text" | "secret" | "url" | "email" | "choice";
  label: string;
  required: boolean;
  placeholder?: string;
  choices?: { value: string; label: string }[];
  initial?: string;
}

export interface VaultSourceInfo {
  kind: string;
  name: string;
  kinds: VaultItemKind[];
  steps: string[];
  fields: VaultConnectField[];
  warning?: string;
  helpUrl?: string;
}

export interface VaultOverview {
  items: VaultItem[];
  connections: VaultConnection[];
  sources: VaultSourceInfo[];
  /** The viewer may create team items and team connections (`manage_credentials`). */
  canManageTeam: boolean;
}

export interface VaultItemInput {
  kind: VaultItemKind;
  scope: VaultScope;
  title: string;
  description?: string;
  website?: string;
  match?: VaultMatch;
  username?: string;
  /** Login password or key value. */
  secret?: string;
  keyName?: string;
  contact?: VaultContactFields;
  access?: VaultAccess;
}

export interface VaultItemPatch {
  title?: string;
  description?: string;
  website?: string;
  match?: VaultMatch;
  username?: string;
  /** A new value; absent keeps the saved one. */
  secret?: string;
  keyName?: string;
  contact?: VaultContactFields;
  access?: VaultAccess;
  /** External items: go back to the connection's access. */
  accessFromConnection?: boolean;
}

export interface VaultImportResult {
  added: number;
  updated: number;
  skipped: { reason: "duplicate" | "not_https" | "no_password" | "invalid"; count: number }[];
  /** The file's format, as recognized. */
  format: "chrome" | "1password" | "bitwarden" | "generic";
}

export interface VaultConnectInput {
  kind: string;
  scope: VaultScope;
  input: Record<string, string>;
  access?: VaultAccess;
}

export interface VaultConnectionPatch {
  access?: VaultAccess;
  /** New credentials (reconnect). */
  input?: Record<string, string>;
}

/** "Save to the Vault" on a secret request's card, sent after the box was delivered. */
export interface SecretToVaultInput {
  value: string;
  /**
   * Logins: the username the person kept on the card ("" = none, even when the agent suggested one). Absent: the
   * request's own. The cards always send it for a site's password.
   */
  username?: string;
  scope: VaultScope;
  allAgents: boolean;
  agentIds: string[];
}
