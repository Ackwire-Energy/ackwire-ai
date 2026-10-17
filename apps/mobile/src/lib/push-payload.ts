/**
 * What a push carries for the deep link (ADR 0035 §4): `{ orgId, kind, notificationId, channelId?,
 * threadId?, approvalId?, missionId? }`. Pure: reads untrusted notification data into known string
 * fields (anything else is dropped), so the route mapping (`hrefForPush`) gets clean input.
 */
export interface PushData {
  orgId?: string;
  kind?: string;
  notificationId?: string;
  channelId?: string;
  threadId?: string;
  approvalId?: string;
  missionId?: string;
}

const FIELDS = ["orgId", "kind", "notificationId", "channelId", "threadId", "approvalId", "missionId"] as const;

export function readPushData(data: unknown): PushData {
  const out: PushData = {};
  if (!data || typeof data !== "object") return out;
  const o = data as Record<string, unknown>;
  for (const key of FIELDS) {
    const v = o[key];
    if (typeof v === "string" && v.length > 0 && v.length <= 200) out[key] = v;
  }
  return out;
}

/** The body of `POST /api/app/push/devices`. */
export function deviceBody(token: string, platform: string, locale: string) {
  return { token, platform: platform === "ios" ? "ios" : "android", locale };
}

/** `DELETE /api/app/push/devices/:token` path (the token has brackets: encode it). */
export const devicePath = (token: string) => `/api/app/push/devices/${encodeURIComponent(token)}`;
