/**
 * Transactional email. Core sends only through an outbox job (`email.send`),
 * never inline in a request. Cloud: MillionSend (Resend-compatible API).
 * Without a key: a dev sender that logs instead of sending.
 */
export interface EmailMessage {
  to: string[];
  subject: string;
  html: string;
  text: string;
  /** Same key → the provider sends once (also deduped by the outbox). */
  idempotencyKey: string;
  replyTo?: string;
  tags?: { name: string; value: string }[];
}

/** A marketing contact (e.g. a confirmed waiting list address), keyed by email. */
export interface EmailContact {
  email: string;
  /** Custom properties, merged into what the provider already has. */
  properties: Record<string, string | number>;
}

export interface EmailSender {
  readonly id: string;
  /** Whether real delivery is configured (enables password reset and email verification). */
  readonly delivers: boolean;
  send(message: EmailMessage): Promise<{ id: string }>;
  /** Creates or updates a contact in the provider's list; absent = the provider keeps no contacts. */
  saveContact?(contact: EmailContact): Promise<void>;
}

/** A send failure; `retryable` drives the outbox retry. */
export class EmailError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "EmailError";
  }
}

/**
 * MillionSend over its REST API (`POST {baseURL}/emails`, bearer key), the
 * documented Resend-compatible fields. 429 (quota) and 5xx retry; 4xx don't.
 * A 409 (idempotency conflict: this key was already used) counts as sent.
 */
export function createMillionSendSender(options: {
  apiKey: string;
  from: string;
  replyTo?: string;
  baseURL?: string;
  fetch?: typeof fetch;
}): EmailSender {
  const http = options.fetch ?? fetch;
  const base = (options.baseURL ?? "https://api.millionsend.com").replace(/\/$/, "");
  return {
    id: "millionsend",
    delivers: true,
    async send(message) {
      let res: Response;
      try {
        res = await http(`${base}/emails`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
            "idempotency-key": message.idempotencyKey.slice(0, 256),
          },
          body: JSON.stringify({
            from: options.from,
            to: message.to,
            subject: message.subject,
            html: message.html,
            text: message.text,
            ...(message.replyTo || options.replyTo ? { reply_to: message.replyTo ?? options.replyTo } : {}),
            ...(message.tags?.length ? { tags: message.tags } : {}),
          }),
        });
      } catch (error) {
        throw new EmailError(`could not reach MillionSend: ${String(error)}`, true);
      }
      if (res.status === 409) return { id: `duplicate:${message.idempotencyKey}` };
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
      if (!res.ok || !body.id) {
        throw new EmailError(
          `MillionSend refused the email (${res.status}${body.name ? ` ${body.name}` : ""}): ${body.message ?? ""}`.trim(),
          res.status === 429 || res.status >= 500,
          res.status,
        );
      }
      return { id: body.id };
    },
    /** `POST /contacts`; an existing contact (409) gets its properties merged with `PATCH /contacts/{email}`. */
    async saveContact(contact) {
      const call = async (method: string, path: string, body: unknown) => {
        try {
          return await http(`${base}${path}`, {
            method,
            headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify(body),
          });
        } catch (error) {
          throw new EmailError(`could not reach MillionSend: ${String(error)}`, true);
        }
      };
      let res = await call("POST", "/contacts", { email: contact.email, properties: contact.properties });
      if (res.status === 409)
        res = await call("PATCH", `/contacts/${encodeURIComponent(contact.email)}`, { properties: contact.properties });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; name?: string };
        throw new EmailError(
          `MillionSend refused the contact (${res.status}${body.name ? ` ${body.name}` : ""}): ${body.message ?? ""}`.trim(),
          res.status === 429 || res.status >= 500,
          res.status,
        );
      }
    },
  };
}

/** Dev fallback: no key configured, so the email is logged (subject, recipients, text) and not sent. */
export function createLogEmailSender(log: (line: string, data: Record<string, unknown>) => void): EmailSender {
  return {
    id: "log",
    delivers: false,
    async send(message) {
      log("email (not sent: no MILLIONSEND_API_KEY)", { to: message.to, subject: message.subject, text: message.text });
      return { id: `logged:${message.idempotencyKey}` };
    },
  };
}

/** Test sender: records every message, never sends. */
export function createFakeEmailSender(options: { delivers?: boolean } = {}) {
  const sent: EmailMessage[] = [];
  const contacts: EmailContact[] = [];
  const sender: EmailSender & { sent: EmailMessage[]; contacts: EmailContact[] } = {
    id: "fake",
    delivers: options.delivers ?? true,
    sent,
    contacts,
    async send(message) {
      sent.push(message);
      return { id: `fake-${sent.length}` };
    },
    async saveContact(contact) {
      contacts.push(contact);
    },
  };
  return sender;
}
