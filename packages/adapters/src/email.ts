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

export interface EmailSender {
  readonly id: string;
  /** Whether real delivery is configured (enables password reset and email verification). */
  readonly delivers: boolean;
  send(message: EmailMessage): Promise<{ id: string }>;
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
  const sender: EmailSender & { sent: EmailMessage[] } = {
    id: "fake",
    delivers: options.delivers ?? true,
    sent,
    async send(message) {
      sent.push(message);
      return { id: `fake-${sent.length}` };
    },
  };
  return sender;
}
