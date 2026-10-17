/**
 * Push notifications to the phone app (ADR 0035). Core sends only from an
 * outbox job (`push.send`), never inline in a request. Default: the Expo
 * Push API (the app registers Expo push tokens). Tests use the fake.
 */
export interface PushMessage {
  /** Expo push token (`ExponentPushToken[…]`). */
  to: string;
  title: string;
  body: string;
  /** Deep link data for the app (`{ orgId, kind, notificationId, … }`). */
  data: Record<string, unknown>;
  /** `high` wakes the device right away (things waiting for the person). */
  priority?: "default" | "high";
}

export interface PushResult {
  token: string;
  ok: boolean;
  /** The token no longer reaches a device (app uninstalled, notifications off): delete it. */
  unregistered: boolean;
  error?: string;
}

export interface PushSender {
  readonly id: string;
  /** One result per message, in order. Throws `PushError` when the whole request failed. */
  send(messages: PushMessage[]): Promise<PushResult[]>;
}

/** A request failure; `retryable` drives the outbox retry. */
export class PushError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "PushError";
  }
}

/** Expo accepts at most 100 messages per request. */
export const EXPO_PUSH_BATCH = 100;
export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

type ExpoTicket = { status: "ok"; id?: string } | { status: "error"; message?: string; details?: { error?: string } };

/**
 * Expo Push API (`POST /--/api/v2/push/send`, JSON array, ≤100 per request).
 * `accessToken` is needed only when the Expo project has enhanced push
 * security on. 429 and 5xx retry; other 4xx don't. A ticket with
 * `DeviceNotRegistered` marks its token unregistered.
 */
export function createExpoPushSender(options: { accessToken?: string; url?: string; fetch?: typeof fetch } = {}) {
  const http = options.fetch ?? fetch;
  const url = options.url ?? EXPO_PUSH_URL;
  const sender: PushSender = {
    id: "expo",
    async send(messages) {
      const results: PushResult[] = [];
      for (let i = 0; i < messages.length; i += EXPO_PUSH_BATCH) {
        const batch = messages.slice(i, i + EXPO_PUSH_BATCH);
        let res: Response;
        try {
          res = await http(url, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}),
            },
            body: JSON.stringify(
              batch.map((m) => ({
                to: m.to,
                title: m.title,
                body: m.body,
                data: m.data,
                sound: "default",
                priority: m.priority ?? "default",
              })),
            ),
          });
        } catch (error) {
          throw new PushError(`could not reach Expo push: ${String(error)}`, true);
        }
        const payload = (await res.json().catch(() => ({}))) as {
          data?: ExpoTicket[];
          errors?: { code?: string; message?: string }[];
        };
        if (!res.ok || !Array.isArray(payload.data)) {
          const why = payload.errors?.map((e) => e.message ?? e.code).join("; ") ?? "";
          throw new PushError(
            `Expo push refused the request (${res.status}): ${why}`.trim(),
            res.status === 429 || res.status >= 500,
            res.status,
          );
        }
        batch.forEach((m, n) => {
          const ticket = payload.data?.[n];
          if (ticket?.status === "ok") results.push({ token: m.to, ok: true, unregistered: false });
          else
            results.push({
              token: m.to,
              ok: false,
              unregistered: ticket?.details?.error === "DeviceNotRegistered",
              error: ticket?.message ?? ticket?.details?.error ?? "no ticket",
            });
        });
      }
      return results;
    },
  };
  return sender;
}

/** Test sender: records every message, never sends. Tokens in `unregistered` come back unregistered. */
export function createFakePushSender(options: { unregistered?: Iterable<string> } = {}) {
  const sent: PushMessage[] = [];
  const unregistered = new Set(options.unregistered ?? []);
  const sender: PushSender & { sent: PushMessage[]; unregistered: Set<string> } = {
    id: "fake",
    sent,
    unregistered,
    async send(messages) {
      return messages.map((m) => {
        if (unregistered.has(m.to)) return { token: m.to, ok: false, unregistered: true, error: "DeviceNotRegistered" };
        sent.push(m);
        return { token: m.to, ok: true, unregistered: false };
      });
    },
  };
  return sender;
}
