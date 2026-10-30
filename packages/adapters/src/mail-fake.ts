import {
  type ComposioClient,
  ComposioSignatureError,
  type ComposioToolkit,
  type ComposioWebhookEvent,
  type MailAccountRef,
  MailAuthError,
  type MailConnectionTester,
  type MailConnector,
  type MailFolder,
  type MailMessage,
  type MailPoller,
  type MailPollState,
  type MailProvider,
  type MailQuery,
  type MailSummary,
  type MailTestError,
  type OutgoingMail,
} from "./mail";

/**
 * In-memory fakes of the mail adapters (ADR 0038) for tests: no network.
 * They record what the engine asked for so tests can assert on it.
 */

const lower = (s: string | undefined) => (s ?? "").toLowerCase();

/** A fake mailbox (one for every account opened through the connector). */
export function createFakeMailConnector(
  options: { folders?: MailFolder[]; messages?: (Partial<MailMessage> & { id: string })[] } = {},
) {
  const folders: MailFolder[] = options.folders ?? [
    { id: "INBOX", name: "INBOX", role: "inbox" },
    { id: "Sent", name: "Sent", role: "sent" },
    { id: "Archive", name: "Archive", role: "archive" },
    { id: "Trash", name: "Trash", role: "trash" },
    { id: "Clients", name: "Clients" },
  ];
  const messages = new Map<string, MailMessage>();
  const state = {
    folders,
    messages,
    opened: [] as MailAccountRef[],
    sent: [] as OutgoingMail[],
    drafts: [] as OutgoingMail[],
    moves: [] as { id: string; folder: string }[],
    flags: [] as { id: string; read?: boolean; flagged?: boolean }[],
    archived: [] as string[],
    trashed: [] as string[],
    attachments: new Map<string, { filename: string; contentType: string; data: Uint8Array }>(),
    /** Thrown by every call while set (e.g. a `MailAuthError`). */
    failWith: null as Error | null,
    closed: 0,
  };

  /** Adds (or replaces) a message; missing fields get defaults. */
  const add = (m: Partial<MailMessage> & { id: string }) => {
    const full: MailMessage = {
      id: m.id,
      threadId: m.threadId,
      folder: m.folder ?? "INBOX",
      from: m.from === undefined ? { address: "someone@example.com" } : m.from,
      to: m.to ?? [{ address: "me@example.com" }],
      cc: m.cc ?? [],
      subject: m.subject ?? "",
      date: m.date ?? new Date().toISOString(),
      snippet: m.snippet ?? (m.text ?? "").slice(0, 200),
      unread: m.unread ?? true,
      flagged: m.flagged ?? false,
      hasAttachments: (m.attachments?.length ?? 0) > 0,
      text: m.text ?? "",
      replyTo: m.replyTo ?? [],
      ...(m.deliveredTo ? { deliveredTo: m.deliveredTo } : {}),
      messageIdHeader: m.messageIdHeader ?? `<${m.id}@example.com>`,
      references: m.references ?? [],
      attachments: m.attachments ?? [],
    };
    messages.set(full.id, full);
    return full;
  };
  for (const m of options.messages ?? []) add(m);

  const summary = (m: MailMessage): MailSummary => {
    const {
      text: _t,
      replyTo: _r,
      deliveredTo: _d,
      messageIdHeader: _h,
      references: _refs,
      attachments: _a,
      ...rest
    } = m;
    return rest;
  };
  const guard = () => {
    if (state.failWith) throw state.failWith;
  };
  const get = (id: string) => {
    const m = messages.get(id);
    if (!m) throw new Error(`No message ${id}`);
    return m;
  };

  const provider: MailProvider = {
    async listFolders() {
      guard();
      return folders;
    },
    async search(q: MailQuery) {
      guard();
      const folder = q.folder ?? "INBOX";
      const matches = [...messages.values()].filter((m) => {
        if (m.folder !== folder) return false;
        const from = lower(m.from?.address);
        if (q.from && !(q.from.startsWith("@") ? from.endsWith(lower(q.from)) : from === lower(q.from))) return false;
        if (q.to && !m.to.some((a) => a.address === lower(q.to))) return false;
        if (q.subject && !lower(m.subject).includes(lower(q.subject))) return false;
        if (q.text && !`${lower(m.subject)} ${lower(m.text)}`.includes(lower(q.text))) return false;
        if (q.since && m.date < q.since) return false;
        if (q.before && m.date >= q.before) return false;
        if (q.unreadOnly && !m.unread) return false;
        return true;
      });
      matches.sort((a, b) => b.date.localeCompare(a.date));
      return matches.slice(0, Math.min(q.limit ?? 20, 50)).map(summary);
    },
    async read(id) {
      guard();
      return get(id);
    },
    async attachment(messageId, attachmentId) {
      guard();
      get(messageId);
      const a = state.attachments.get(`${messageId}/${attachmentId}`);
      if (!a) throw new Error(`No attachment ${attachmentId}`);
      return a;
    },
    async createDraft(mail) {
      guard();
      state.drafts.push(mail);
      return { id: `draft-${state.drafts.length}` };
    },
    async send(mail) {
      guard();
      state.sent.push(mail);
      return { id: `sent-${state.sent.length}` };
    },
    async move(id, folder) {
      guard();
      get(id).folder = folder;
      state.moves.push({ id, folder });
    },
    async setFlags(id, flags) {
      guard();
      const m = get(id);
      if (flags.read !== undefined) m.unread = !flags.read;
      if (flags.flagged !== undefined) m.flagged = flags.flagged;
      state.flags.push({ id, ...flags });
    },
    async archive(id) {
      guard();
      get(id).folder = "Archive";
      state.archived.push(id);
    },
    async trash(id) {
      guard();
      get(id).folder = "Trash";
      state.trashed.push(id);
    },
    async close() {
      state.closed++;
    },
  };

  const connector: MailConnector = {
    async open(account) {
      state.opened.push(account);
      return provider;
    },
  };
  return { connector, provider, state, add };
}

export type FakeMailConnector = ReturnType<typeof createFakeMailConnector>;

/**
 * A fake IMAP poller: each folder holds messages with UIDs. A null state
 * starts from now (returns nothing); a different `uidValidity` resets the
 * same way, like a real server whose folder was rebuilt.
 */
export function createFakeMailPoller(options: { uidValidity?: number } = {}) {
  const state = {
    uidValidity: options.uidValidity ?? 1,
    folders: new Map<string, { uid: number; message: MailSummary }[]>(),
    calls: [] as { account: MailAccountRef; folder: string; state: MailPollState | null }[],
    failWith: null as Error | null,
  };
  const listOf = (folder: string) => {
    let list = state.folders.get(folder);
    if (!list) {
      list = [];
      state.folders.set(folder, list);
    }
    return list;
  };
  /** A new message arrives in `folder` (UIDs grow). */
  const deliver = (folder: string, message: MailSummary) => {
    const list = listOf(folder);
    const uid = (list.at(-1)?.uid ?? 0) + 1;
    list.push({ uid, message });
    return uid;
  };
  const poller: MailPoller = {
    async newMessages(account, folder, from, opts) {
      state.calls.push({ account, folder, state: from });
      if (state.failWith) throw state.failWith;
      const list = listOf(folder);
      const top = list.at(-1)?.uid ?? 0;
      const now = { lastUid: top, uidValidity: state.uidValidity };
      if (!from || from.uidValidity !== state.uidValidity) return { messages: [], state: now };
      const fresh = list.filter((m) => m.uid > from.lastUid).slice(0, opts?.limit ?? 50);
      const last = fresh.at(-1)?.uid ?? from.lastUid;
      return { messages: fresh.map((m) => m.message), state: { lastUid: last, uidValidity: state.uidValidity } };
    },
  };
  return { poller, state, deliver };
}

/** A fake connection tester: answers `result` (default ok) and records the accounts it saw. */
export function createFakeMailTester(
  result: { ok: true; sentFolder: string | null } | { ok: false; error: MailTestError } = {
    ok: true,
    sentFolder: "Sent",
  },
) {
  const state = { result, calls: [] as MailAccountRef[] };
  const tester: MailConnectionTester = {
    async test(account) {
      state.calls.push(account);
      return state.result;
    },
  };
  return { tester, state };
}

/** The signature header value the fake Composio client accepts. */
export const FAKE_COMPOSIO_SIGNATURE = "v1,test-signature";

/**
 * A fake Composio client: connected accounts in memory (status and address
 * settable), triggers recorded, webhooks are JSON `ComposioWebhookEvent`s
 * signed with `webhook-signature: FAKE_COMPOSIO_SIGNATURE`.
 */
export function createFakeComposioClient() {
  const state = {
    accounts: new Map<
      string,
      {
        toolkit: ComposioToolkit;
        userId: string;
        status: "active" | "pending" | "failed" | "expired";
        address: string | null;
      }
    >(),
    links: [] as { toolkit: ComposioToolkit; userId: string; callbackUrl: string; connectedAccountId: string }[],
    deletedAccounts: [] as string[],
    /** Accounts deleted with their grant at the provider left alone (`revoke: false`). */
    grantsKept: [] as string[],
    triggers: new Map<string, { toolkit: ComposioToolkit; connectedAccountId: string; query: string | null }>(),
    deletedTriggers: [] as string[],
    failWith: null as Error | null,
  };
  let seq = 0;
  const client: ComposioClient = {
    async createConnectLink(input) {
      if (state.failWith) throw state.failWith;
      const connectedAccountId = `ca_${++seq}`;
      state.accounts.set(connectedAccountId, {
        toolkit: input.toolkit,
        userId: input.userId,
        status: "pending",
        address: null,
      });
      state.links.push({ ...input, connectedAccountId });
      return { connectedAccountId, redirectUrl: `https://composio.example/connect/${connectedAccountId}` };
    },
    async getConnectedAccount(id) {
      if (state.failWith) throw state.failWith;
      const a = state.accounts.get(id);
      if (!a) return { status: "failed", address: null };
      return { status: a.status, address: a.status === "active" ? a.address : null };
    },
    async deleteConnectedAccount(id, options) {
      state.deletedAccounts.push(id);
      if (options?.revoke === false) state.grantsKept.push(id);
      state.accounts.delete(id);
    },
    async createMailTrigger(input) {
      if (state.failWith) throw state.failWith;
      const triggerId = `ti_${++seq}`;
      state.triggers.set(triggerId, input);
      return { triggerId };
    },
    async deleteTrigger(triggerId) {
      state.deletedTriggers.push(triggerId);
      state.triggers.delete(triggerId);
    },
    verifyWebhook(headers, rawBody) {
      if (headers.get("webhook-signature") !== FAKE_COMPOSIO_SIGNATURE) throw new ComposioSignatureError();
      return JSON.parse(rawBody) as ComposioWebhookEvent;
    },
  };
  /** The person finished OAuth at Composio: the account is active with this address. */
  const activate = (connectedAccountId: string, address: string) => {
    const a = state.accounts.get(connectedAccountId);
    if (a) {
      a.status = "active";
      a.address = address;
    }
  };
  return { client, state, activate };
}

/** A MailAuthError, for fakes told to refuse the credentials. */
export const fakeMailAuthError = () => new MailAuthError("Invalid credentials (fake)");
