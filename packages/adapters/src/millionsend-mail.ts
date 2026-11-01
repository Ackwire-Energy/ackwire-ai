/**
 * MillionSend inboxes as mailboxes for agents (ADR 0102), over MillionSend's REST API (bearer key per mailbox):
 * Resend's Inboxes and receiving shapes plus MillionSend's own fields.
 *
 * - `client`: the inboxes a key reaches, and the webhook that wakes routines at once.
 * - `connector`: a `MailProvider` per inbox. A message's id is `{thread}:{email}`. MillionSend keeps folders, read
 *   state and the trash on threads, so moving or marking a message moves or marks its whole conversation.
 * - `poller`: mail delivered since the last check, for an inbox without a webhook and for anything one missed.
 *
 * Held mail (quarantine, screening) never comes out: MillionSend leaves it out of every list unless asked. The key
 * never appears in errors.
 */
import {
  arr,
  clampLimit,
  formatMailbox,
  htmlToText,
  type Obj,
  obj,
  parseAddress,
  parseAddressList,
  snippetOf,
  str,
  toIsoDate,
} from "./composio-mail";
import {
  type MailAccountRef,
  MailAuthError,
  type MailConnector,
  MailError,
  type MailFolder,
  type MailMessage,
  type MailPoller,
  type MailProvider,
  type MailQuery,
  type MailSummary,
  type MillionSendClient,
  type MillionSendInbox,
  type OutgoingMail,
} from "./mail";

/** An inbox's folders: MillionSend has these five and no others. */
export const MILLIONSEND_FOLDERS: MailFolder[] = [
  { id: "inbox", name: "Inbox", role: "inbox" },
  { id: "archive", name: "Archive", role: "archive" },
  { id: "sent", name: "Sent", role: "sent" },
  { id: "spam", name: "Spam", role: "spam" },
  { id: "trash", name: "Trash", role: "trash" },
];
/** `sent` is MillionSend's to set, never a destination. */
const MOVABLE = new Set(["inbox", "archive", "spam", "trash"]);

/** A poll looks this far behind its cursor: mail screened for a while lands after newer mail. */
const POLL_OVERLAP_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const millionSendMessageId = (threadId: string, emailId: string) => `${threadId}:${emailId}`;

/** A message id's thread and email; anything else is refused before it reaches a URL. */
function partsOf(id: string) {
  const [threadId = "", emailId = "", ...rest] = id.split(":");
  if (rest.length > 0 || !UUID.test(threadId) || !UUID.test(emailId)) {
    throw new MailError(`${id.slice(0, 100)} is not a message id of this mailbox`, false);
  }
  return { threadId, emailId };
}

/** A search's `before` leaves out the day it names, MillionSend's `end_date` as a day takes it in: the day before. */
function endDateOf(before: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(before)) return before;
  const day = Date.parse(`${before}T00:00:00Z`);
  return Number.isNaN(day) ? before : new Date(day - 86_400_000).toISOString().slice(0, 10);
}

/** A folder as MillionSend names it (`INBOX`, our default, is its `inbox`). */
export const millionSendFolder = (folder: string | undefined) => (folder ?? "").trim().toLowerCase() || "inbox";

const iso = (value: unknown) => toIsoDate(value) ?? new Date(0).toISOString();
const addressOf = (value: unknown) => parseAddress(str(value) ?? "");

/** An `inbox.email.received` delivery (verified by the caller), as the summary routines get. */
export type MillionSendWebhookEvent = { type: "mail.received"; message: MailSummary } | { type: "other" };

/**
 * The inbox a webhook delivery names and what it says. Read before the signature is checked, only to find whose
 * secret signs it: nothing in it counts until one does. Null when it isn't an inbox event.
 */
export function readMillionSendWebhook(rawBody: string): { inboxId: string; event: MillionSendWebhookEvent } | null {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const data = obj(obj(payload).data);
  const inboxId = str(data.inbox_id);
  if (!inboxId) return null;
  const threadId = str(data.thread_id);
  const emailId = str(data.email_id);
  if (obj(payload).type !== "inbox.email.received" || !threadId || !emailId)
    return { inboxId, event: { type: "other" } };
  const email = obj(data.email);
  const thread = obj(data.thread);
  return {
    inboxId,
    event: {
      type: "mail.received",
      message: {
        id: millionSendMessageId(threadId, emailId),
        threadId,
        folder: str(thread.folder) ?? "inbox",
        from: addressOf(email.from),
        to: parseAddressList(email.to),
        cc: parseAddressList(email.cc),
        subject: str(email.subject) ?? str(thread.subject) ?? "",
        date: iso(email.received_at ?? obj(payload).created_at),
        snippet: "",
        unread: email.read !== true,
        hasAttachments: arr(email.attachments).length > 0,
      },
    },
  };
}

/** A received email of `GET /emails/receiving` as a summary, in its thread's folder. */
function receivedSummary(item: Obj, folder: string): MailSummary | null {
  const id = str(item.id);
  const threadId = str(item.thread_id);
  if (!id || !threadId) return null;
  return {
    id: millionSendMessageId(threadId, id),
    threadId,
    folder,
    from: addressOf(item.from),
    to: parseAddressList(item.to),
    cc: parseAddressList(item.cc),
    subject: str(item.subject) ?? "",
    date: iso(item.created_at),
    snippet: "",
    unread: item.read !== true,
    hasAttachments: arr(item.attachments).length > 0,
  };
}

export function createMillionSendMail(options: {
  baseURL: string;
  fetch?: typeof fetch;
  /** Clock for the poller's first check (tests). */
  now?: () => number;
}): { client: MillionSendClient; connector: MailConnector; poller: MailPoller } {
  const http = options.fetch ?? fetch;
  const base = options.baseURL.replace(/\/$/, "");
  const now = options.now ?? Date.now;

  /** One call; refused keys throw `MailAuthError`, the network, limits and 5xx a retryable `MailError`. */
  async function request(apiKey: string, method: string, path: string, body?: unknown) {
    let res: Response;
    try {
      res = await http(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new MailError(
        `could not reach MillionSend: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    }
    const data = obj(await res.json().catch(() => ({})));
    const said = str(data.message) ?? "";
    if (res.status === 401) throw new MailAuthError("MillionSend refused the API key");
    if (res.status === 429 || res.status >= 500) {
      throw new MailError(`MillionSend can't answer now (${res.status}) ${said}`.trim(), true);
    }
    return { status: res.status, data };
  }

  /** The answer, when MillionSend took the call. */
  function accepted(r: { status: number; data: Obj }) {
    if (r.status < 200 || r.status > 299) {
      throw new MailError(
        `MillionSend refused (${r.status} ${str(r.data.name) ?? ""}) ${str(r.data.message) ?? ""}`.trim(),
        false,
      );
    }
    return r;
  }

  /** The answer of a call that must succeed. */
  async function call(apiKey: string, method: string, path: string, body?: unknown) {
    return accepted(await request(apiKey, method, path, body));
  }

  /**
   * A send MillionSend held for a person answers `202` with the draft: never reported as sent. Only the status
   * tells: a draft that went out answers `200` with `object: "inbox_draft"` too.
   */
  function sentId({ status, data }: { status: number; data: Obj }) {
    if (status === 202) {
      const reasons = arr(data.approval_reasons).map(String).join(", ");
      throw new MailError(
        `MillionSend is holding this email until a person approves it there, in Inboxes › Needs review${reasons ? ` (${reasons})` : ""}`,
        false,
      );
    }
    return str(data.email_id) ?? str(data.id) ?? null;
  }

  const client: MillionSendClient = {
    async listInboxes(apiKey) {
      const out: MillionSendInbox[] = [];
      let after: string | undefined;
      // ponytail: 10 pages of 100; a team with more inboxes than that picks among the newest.
      for (let page = 0; page < 10; page++) {
        const r = await request(
          apiKey,
          "GET",
          `/inboxes?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`,
        );
        // A key that only sends can't read inboxes: as refused as a wrong one, for this purpose.
        if (r.status === 403) throw new MailAuthError("This MillionSend key can't read inboxes");
        if (r.status !== 200)
          throw new MailError(`MillionSend refused (${r.status}) ${str(r.data.message) ?? ""}`.trim(), false);
        const rows = arr(r.data.data).map(obj);
        for (const row of rows) {
          const id = str(row.id);
          const address = str(row.email_address)?.toLowerCase();
          if (!id || !address) continue;
          out.push({
            id,
            address,
            name: str(row.name) ?? null,
            kind: row.kind === "human" ? "human" : "agent",
            shared: row.shared === true,
          });
        }
        after = str(rows.at(-1)?.id);
        if (r.data.has_more !== true || !after) break;
      }
      return out;
    },

    async createWebhook(apiKey, input) {
      const r = await request(apiKey, "POST", "/webhooks", {
        endpoint: input.endpoint,
        events: ["inbox.email.received"],
        inbox_ids: [input.inboxId],
        signing_secret: input.secret,
      });
      if (r.status === 403) return null;
      if (r.status < 200 || r.status > 299 || !str(r.data.id)) {
        throw new MailError(`MillionSend didn't create the webhook (${r.status})`, false);
      }
      return { id: str(r.data.id) as string };
    },

    async deleteWebhook(apiKey, webhookId) {
      if (!UUID.test(webhookId)) return;
      const r = await request(apiKey, "DELETE", `/webhooks/${webhookId}`);
      if (r.status !== 404 && (r.status < 200 || r.status > 299)) {
        throw new MailError(`MillionSend didn't delete the webhook (${r.status})`, false);
      }
    },
  };

  const keyOf = (account: MailAccountRef) => {
    if (!account.millionsend || !UUID.test(account.millionsend.inboxId)) {
      throw new MailError("This mailbox has no MillionSend inbox", false);
    }
    return account.millionsend;
  };

  const connector: MailConnector = {
    async open(account) {
      const { apiKey, inboxId } = keyOf(account);
      const inbox = `/inboxes/${inboxId}`;
      const thread = (id: string) => `${inbox}/threads/${partsOf(id).threadId}`;
      const answer = (method: string, path: string, body?: unknown) => call(apiKey, method, path, body);
      const fetchJson = async (method: string, path: string, body?: unknown) => (await answer(method, path, body)).data;

      const provider: MailProvider = {
        async listFolders() {
          return MILLIONSEND_FOLDERS;
        },

        async search(q: MailQuery) {
          const folder = millionSendFolder(q.folder);
          if (!MILLIONSEND_FOLDERS.some((f) => f.id === folder)) throw new MailError(`No folder ${q.folder}`, false);
          const params = new URLSearchParams({ folders: folder, limit: String(clampLimit(q.limit)) });
          // ponytail: MillionSend keeps bodies sealed, so its search reads subjects, senders and recipients only.
          const words = [q.subject, q.text].filter(Boolean).join(" ").trim();
          if (words) params.set("query", words.slice(0, 256));
          if (q.from) params.set("from", q.from);
          if (q.to) params.set("to", q.to);
          if (q.since) params.set("start_date", q.since);
          if (q.before) params.set("end_date", endDateOf(q.before));
          if (q.unreadOnly) params.set("read", "false");
          const data = await fetchJson("GET", `${inbox}/threads/search?${params}`);
          const hits = arr(data.data).flatMap((raw) => {
            const t = obj(raw);
            const threadId = str(t.id);
            const emailId = str(t.matched_email_id);
            return threadId && emailId && UUID.test(threadId) && UUID.test(emailId) ? [{ t, threadId, emailId }] : [];
          });
          // A thread's sender is its newest received mail's and its date its newest message's, while the line names
          // the newest email that matched (the inbox's own reply, say). One message is that email; more, it's read.
          return Promise.all(
            hits.map(async ({ t, threadId, emailId }): Promise<MailSummary> => {
              const one = t.message_count === 1;
              const e = one ? t : await fetchJson("GET", `${inbox}/threads/${threadId}/emails/${emailId}`);
              return {
                id: millionSendMessageId(threadId, emailId),
                threadId,
                folder: str(t.folder) ?? folder,
                from: addressOf(e.from),
                to: parseAddressList(e.to),
                cc: parseAddressList(e.cc),
                subject: str(e.subject) ?? str(t.subject) ?? "",
                date: iso(e.received_at),
                snippet: "",
                unread: t.read !== true,
                hasAttachments: one ? t.has_attachment === true : arr(e.attachments).length > 0,
              };
            }),
          );
        },

        async read(id) {
          const { threadId, emailId } = partsOf(id);
          const [email, t] = await Promise.all([
            fetchJson("GET", `${inbox}/threads/${threadId}/emails/${emailId}`),
            fetchJson("GET", `${inbox}/threads/${threadId}`),
          ]);
          // The plain part as sent (invisible characters already removed), else the reply MillionSend cleaned of
          // hidden text, else the HTML as text.
          const html = str(email.html);
          const text = str(email.text) ?? str(email.extracted_text) ?? (html ? htmlToText(html) : "");
          const message: MailMessage = {
            id,
            threadId,
            folder: str(t.folder) ?? "inbox",
            from: addressOf(email.from),
            to: parseAddressList(email.to),
            cc: parseAddressList(email.cc),
            subject: str(email.subject) ?? str(t.subject) ?? "",
            date: iso(email.received_at),
            snippet: snippetOf(text),
            unread: email.read !== true,
            hasAttachments: arr(email.attachments).length > 0,
            text,
            replyTo: parseAddressList(email.reply_to),
            ...(str(email.message_id) ? { messageIdHeader: str(email.message_id) } : {}),
            references: [],
            attachments: arr(email.attachments).map((raw) => {
              const a = obj(raw);
              return {
                id: str(a.id) ?? "",
                filename: str(a.filename) ?? "attachment",
                contentType: str(a.content_type) ?? "application/octet-stream",
                size: typeof a.size === "number" ? a.size : 0,
              };
            }),
          };
          return message;
        },

        async attachment(messageId, attachmentId) {
          const { emailId } = partsOf(messageId);
          if (!UUID.test(attachmentId)) throw new MailError(`No attachment ${attachmentId.slice(0, 100)}`, false);
          const a = await fetchJson("GET", `/emails/receiving/${emailId}/attachments/${attachmentId}`);
          const url = str(a.download_url) ?? "";
          // The link is signed and needs no key: only one on MillionSend's own API is followed.
          if (!url.startsWith(`${base}/`))
            throw new MailError("MillionSend gave a download link outside its API", false);
          let res: Response;
          try {
            res = await http(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
          } catch (error) {
            throw new MailError(
              `could not download the file: ${error instanceof Error ? error.message : String(error)}`,
              true,
            );
          }
          if (!res.ok) throw new MailError(`MillionSend didn't give the file (${res.status})`, res.status >= 500);
          return {
            filename: str(a.filename) ?? "attachment",
            contentType: str(a.content_type) ?? "application/octet-stream",
            data: new Uint8Array(await res.arrayBuffer()),
          };
        },

        async createDraft(mail: OutgoingMail) {
          const reply = mail.inReplyTo ? partsOf(mail.inReplyTo) : null;
          const fields = { to: mail.to, cc: mail.cc, bcc: mail.bcc, subject: mail.subject, text: mail.text };
          const r = await answer("POST", `${inbox}/drafts`, {
            ...fields,
            ...(reply ? { thread_id: reply.threadId, reply_to_email_id: reply.emailId } : {}),
          });
          const id = str(r.data.id);
          if (!id || !UUID.test(id)) throw new MailError("MillionSend didn't return the draft", false);
          // MillionSend keeps one unsent reply draft per email: another answers 200 with that one, unchanged.
          if (r.status === 200) await answer("PATCH", `${inbox}/drafts/${id}`, fields);
          return { id };
        },

        async send(mail: OutgoingMail) {
          // An inbox sends only as itself: `from` (an alias elsewhere) has no meaning here.
          if (mail.inReplyTo) {
            const { threadId, emailId } = partsOf(mail.inReplyTo);
            const r = await answer("POST", `${inbox}/threads/${threadId}/emails/${emailId}/reply`, {
              text: mail.text,
              subject: mail.subject,
              cc: mail.cc,
              bcc: mail.bcc,
            });
            return { id: sentId(r) };
          }
          if (mail.forwardOf) {
            const { threadId, emailId } = partsOf(mail.forwardOf);
            const r = await answer("POST", `${inbox}/threads/${threadId}/emails/${emailId}/forward`, {
              to: mail.to,
              cc: mail.cc,
              bcc: mail.bcc,
              subject: mail.subject,
              ...(mail.text ? { text: mail.text } : {}),
            });
            return { id: sentId(r) };
          }
          // New mail goes out as the inbox through POST /emails, where MillionSend runs the inbox's rules for any key.
          // A draft sent with a team-wide key would count as a person's approval and skip them. A send the rules
          // hold is refused there and leaves nothing behind.
          const box = await fetchJson("GET", inbox);
          const address = str(box.email_address);
          if (!address) throw new MailError("MillionSend didn't return the inbox", false);
          const r = await request(apiKey, "POST", "/emails", {
            from: formatMailbox(str(box.from_name), address),
            to: mail.to,
            // MillionSend refuses an empty list.
            ...(mail.cc.length > 0 ? { cc: mail.cc } : {}),
            ...(mail.bcc.length > 0 ? { bcc: mail.bcc } : {}),
            subject: mail.subject,
            text: mail.text,
          });
          const said = str(r.data.message) ?? "";
          if (r.status === 403 && /rules hold this email/.test(said)) {
            const reasons = /\(([^)]+)\)/.exec(said)?.[1];
            throw new MailError(
              `MillionSend didn't send it: this inbox's rules there hold mail like it for a person${reasons ? ` (${reasons})` : ""}. Nothing was sent or saved. A person can send it from MillionSend, or change the inbox's rules there and ask you again`,
              false,
            );
          }
          return { id: str(accepted(r).data.id) ?? null };
        },

        async move(id, folder) {
          const to = millionSendFolder(folder);
          if (!MOVABLE.has(to))
            throw new MailError(`Can't move to ${folder}: use inbox, archive, spam or trash`, false);
          await fetchJson("PATCH", thread(id), { folder: to });
        },

        async setFlags(id, flags) {
          if (flags.flagged !== undefined)
            throw new MailError("MillionSend has no flags: mark it read or move it", false);
          if (flags.read !== undefined) await fetchJson("PATCH", thread(id), { read: flags.read });
        },

        async archive(id) {
          await fetchJson("PATCH", thread(id), { folder: "archive" });
        },

        async trash(id) {
          await fetchJson("DELETE", thread(id));
        },

        async close() {},
      };
      return provider;
    },
  };

  const poller: MailPoller = {
    async newMessages(account, folder, state, opts) {
      const { apiKey, inboxId } = keyOf(account);
      // `uidValidity` holds when the checks started: mail from before then never counts, overlap or not.
      if (!state) {
        const at = now();
        return { messages: [], state: { lastUid: at, uidValidity: at } };
      }
      const params = new URLSearchParams({
        inbox_id: inboxId,
        since: new Date(Math.max(state.uidValidity, state.lastUid - POLL_OVERLAP_MS)).toISOString(),
        // ponytail: one page, the newest; a burst past it between two checks loses its oldest to the webhook alone.
        limit: String(Math.min(100, Math.max(1, opts?.limit ?? 50))),
      });
      const { data } = await call(apiKey, "GET", `/emails/receiving?${params}`);
      const rows = arr(data.data).map(obj);
      // MillionSend files mail by its thread (a reply stays in its thread's folder, whatever its own verdict):
      // each thread is read once, and mail of a thread it doesn't show is left out.
      const threadIds = new Set(rows.map((r) => str(r.thread_id) ?? "").filter((id) => UUID.test(id)));
      const folders = new Map(
        await Promise.all(
          [...threadIds].map(async (id) => {
            const r = await request(apiKey, "GET", `/inboxes/${inboxId}/threads/${id}`);
            return [id, r.status === 200 ? str(r.data.folder) : undefined] as const;
          }),
        ),
      );
      const want = millionSendFolder(folder);
      const messages = rows
        .flatMap((r) => {
          const at = folders.get(str(r.thread_id) ?? "");
          const m = at === undefined ? null : receivedSummary(r, at);
          return m && m.folder === want ? [m] : [];
        })
        .sort((a, b) => a.date.localeCompare(b.date));
      const newest = Math.max(state.lastUid, ...rows.map((r) => Date.parse(str(r.created_at) ?? "") || 0));
      return { messages, state: { lastUid: newest, uidValidity: state.uidValidity } };
    },
  };

  return { client, connector, poller };
}
