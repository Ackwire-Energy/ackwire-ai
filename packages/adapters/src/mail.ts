/**
 * People's mailboxes for agents (ADR 0038). The engine owns accounts, scopes,
 * per-call checks and approvals; these interfaces only reach a mailbox.
 *
 * - `MailConnector.open` gives a `MailProvider` for one account: Gmail and
 *   Outlook through Composio (`via = composio`), anything else over IMAP/SMTP
 *   (`via = imap`).
 * - `MailPoller` (IMAP only) lists messages that arrived since the last check.
 * - `ComposioClient` is the Composio-specific part (connect links, connected
 *   accounts, triggers, webhooks).
 *
 * Every text field coming out of a mailbox is untrusted: the engine wraps it
 * before a model sees it.
 */

export interface MailAddress {
  name?: string;
  /** Lowercase. */
  address: string;
}

export type MailFolderRole = "inbox" | "sent" | "drafts" | "trash" | "archive" | "spam" | "all";

export interface MailFolder {
  /** What the provider takes back (IMAP path, Gmail label id, Graph folder id). */
  id: string;
  /** Shown to people and the model. */
  name: string;
  role?: MailFolderRole;
}

export interface MailSummary {
  /** The provider's id for this message (IMAP: `folder:uidValidity:uid`). Stable while the message exists. */
  id: string;
  threadId?: string;
  folder?: string;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  /** ISO 8601. */
  date: string;
  /** Up to ~200 characters of plain text. */
  snippet: string;
  unread: boolean;
  flagged?: boolean;
  hasAttachments: boolean;
}

export interface MailAttachment {
  /** What `MailProvider.attachment` takes back. */
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface MailMessage extends MailSummary {
  /** Plain text (HTML converted), quoted history kept. */
  text: string;
  replyTo: MailAddress[];
  /**
   * Where the server delivered it (`Delivered-To`, `X-Original-To`), when it
   * says: the alias a message reached even when `To` doesn't show it (Bcc,
   * lists). Lowercase.
   */
  deliveredTo?: string[];
  /** RFC 5322 `Message-ID` and `References`, for threading replies. */
  messageIdHeader?: string;
  references?: string[];
  attachments: MailAttachment[];
}

export interface MailQuery {
  /** Folder id; absent = the inbox. */
  folder?: string;
  /** Address or `@domain`. */
  from?: string;
  to?: string;
  subject?: string;
  /** Free text in the body or subject. */
  text?: string;
  /** ISO date (inclusive). */
  since?: string;
  before?: string;
  unreadOnly?: boolean;
  /** Default 20, max 50. Newest first. */
  limit?: number;
}

export interface OutgoingMail {
  /** An address of this mailbox (alias); absent = the mailbox address. */
  from?: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  /** Reply in the thread of this message (provider id): threading headers, same thread. */
  inReplyTo?: string;
  /** Forward this message (provider id): its text quoted below, its attachments attached. */
  forwardOf?: string;
}

export interface MailProvider {
  listFolders(): Promise<MailFolder[]>;
  search(query: MailQuery): Promise<MailSummary[]>;
  read(id: string): Promise<MailMessage>;
  attachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ filename: string; contentType: string; data: Uint8Array }>;
  /** Saves a draft (never sends). */
  createDraft(mail: OutgoingMail): Promise<{ id: string }>;
  /** Sends, and keeps a copy in the sent folder when the protocol doesn't (IMAP). */
  send(mail: OutgoingMail): Promise<{ id: string | null }>;
  move(id: string, folder: string): Promise<void>;
  setFlags(id: string, flags: { read?: boolean; flagged?: boolean }): Promise<void>;
  archive(id: string): Promise<void>;
  trash(id: string): Promise<void>;
  /** Releases connections (IMAP). */
  close(): Promise<void>;
}

/** What a connector needs to reach one mailbox (secrets already opened by the engine). */
export interface MailAccountRef {
  id: string;
  orgId: string;
  provider: "gmail" | "outlook" | "imap";
  via: "composio" | "imap";
  address: string;
  /** Composio connected account id. */
  externalAccountId?: string | null;
  /** Composio user id the connected account belongs to. */
  externalUserId?: string | null;
  imap?: {
    host: string;
    port: number;
    smtpHost: string;
    smtpPort: number;
    username: string;
    password: string;
    sentFolder?: string | null;
  };
}

export interface MailConnector {
  open(account: MailAccountRef): Promise<MailProvider>;
}

/** The credentials were refused (wrong or revoked password, expired OAuth): the account needs reconnecting. */
export class MailAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailAuthError";
  }
}

/** Any other mailbox failure; `retryable` for timeouts, throttling and 5xx. */
export class MailError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MailError";
  }
}

export interface MailPollState {
  lastUid: number;
  uidValidity: number;
}

/** IMAP: messages that arrived in a folder since `state` (null = start from now, return nothing). */
export interface MailPoller {
  newMessages(
    account: MailAccountRef,
    folder: string,
    state: MailPollState | null,
    options?: { limit?: number },
  ): Promise<{ messages: MailSummary[]; state: MailPollState }>;
}

/** IMAP: checks the login and both servers before an account is saved; finds the sent folder. */
export interface MailConnectionTester {
  test(account: MailAccountRef): Promise<{ ok: true; sentFolder: string | null } | { ok: false; error: MailTestError }>;
}

/** Why a connection test failed (the web app explains each in the person's language). */
export type MailTestError = "auth" | "imap_unreachable" | "smtp_unreachable" | "tls" | "blocked_host" | "unknown";

/** A known IMAP/SMTP provider (the person only picks it and pastes an app password). */
export interface MailPreset {
  id: string;
  label: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** The login is the full address (most) or only the part before @. */
  username: "address" | "local";
  /** Where to create an app password (shown as a link). */
  appPasswordUrl: string | null;
}

/** Composio (Gmail and Outlook): the account lives there; we keep its id. */
export type ComposioToolkit = "gmail" | "outlook";

export interface ComposioClient {
  /** A link the person opens to connect; Composio redirects to `callbackUrl` after. */
  createConnectLink(input: {
    toolkit: ComposioToolkit;
    /** Our Composio user id (`org_<orgId>`). */
    userId: string;
    callbackUrl: string;
  }): Promise<{ connectedAccountId: string; redirectUrl: string }>;
  /**
   * State of a connected account and its mailbox address, when active (`userId`: the one it was linked for).
   * The address is read with a profile tool call, which Composio bills; `readAddress: false` skips it.
   */
  getConnectedAccount(
    id: string,
    userId: string,
    options?: { readAddress?: boolean },
  ): Promise<{ status: "active" | "pending" | "failed" | "expired"; address: string | null }>;
  /** Also revokes the grant at Google/Microsoft, unless `revoke: false` (Composio only forgets the account). */
  deleteConnectedAccount(id: string, options?: { revoke?: boolean }): Promise<void>;
  /** A "new message" trigger on the account; `query` is a Gmail search (Outlook: filtered on our side). */
  createMailTrigger(input: {
    toolkit: ComposioToolkit;
    connectedAccountId: string;
    userId: string;
    query: string | null;
  }): Promise<{ triggerId: string }>;
  deleteTrigger(triggerId: string): Promise<void>;
  /** Checks a webhook's signature (Standard Webhooks HMAC) and parses it. */
  verifyWebhook(headers: Headers, rawBody: string): ComposioWebhookEvent;
}

export type ComposioWebhookEvent =
  | { type: "mail.received"; triggerId: string; connectedAccountId: string; message: MailSummary }
  | { type: "account.expired"; connectedAccountId: string }
  | { type: "trigger.disabled"; triggerId: string }
  | { type: "other" };

/** A webhook whose signature doesn't verify. */
export class ComposioSignatureError extends Error {
  constructor() {
    super("Invalid Composio webhook signature");
    this.name = "ComposioSignatureError";
  }
}

/** The mail adapters the server wires (each absent when not configured). */
export interface MailAdapters {
  /** Gmail and Outlook through Composio; null = Composio not configured. */
  composio: { client: ComposioClient; connector: MailConnector } | null;
  /** Any IMAP/SMTP server; null = off. */
  imap: { connector: MailConnector; poller: MailPoller; tester: MailConnectionTester; presets: MailPreset[] } | null;
}
