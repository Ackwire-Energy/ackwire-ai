import type { AppNotification } from "@agenteschat/client";
import { isSafeId } from "../shared/logic";

/**
 * Where things open in the app (Expo Router paths). Deep links
 * (`agenteschat://chat/<id>`, `approval/<id>`, `mission/<id>`, `activity`, `threads`),
 * push payloads (ADR 0035 §4) and inbox items all end up here.
 */

export type AppHref =
  | `/chat/${string}`
  | `/chat/${string}?thread=${string}`
  | `/approval/${string}`
  | `/mission/${string}`
  | `/agent/${string}`
  | `/issues/${number}`
  | "/activity"
  | "/threads";

export const chatHref = (channelId: string, threadId?: string | null): AppHref =>
  threadId && threadId !== channelId ? `/chat/${channelId}?thread=${threadId}` : `/chat/${channelId}`;

/** What a push carries for the deep link. */
export interface PushPayload {
  orgId?: unknown;
  kind?: unknown;
  notificationId?: unknown;
  channelId?: unknown;
  threadId?: unknown;
  approvalId?: unknown;
  missionId?: unknown;
}

const MISSION_KINDS = new Set(["mission_finished", "mission_stopped"]);

/** The screen a push opens. A high-risk approval opens the request (it is never approved from the push). */
export function hrefForPush(p: PushPayload): AppHref {
  if (isSafeId(p.approvalId)) return `/approval/${p.approvalId}`;
  if (isSafeId(p.missionId) && typeof p.kind === "string" && MISSION_KINDS.has(p.kind))
    return `/mission/${p.missionId}`;
  if (isSafeId(p.channelId)) return chatHref(p.channelId, isSafeId(p.threadId) ? p.threadId : null);
  if (isSafeId(p.missionId)) return `/mission/${p.missionId}`;
  return "/activity";
}

/**
 * `agenteschat://chat/<id>?thread=<id>` (or the same path on its own) → the
 * route, checked; anything else → null.
 */
export function hrefFromUrl(url: string): AppHref | null {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?\/?([a-z]+)(?:\/([^?#/]+))?\/?(?:\?([^#]*))?/i.exec(url.trim());
  if (!m) return null;
  const [, screen = "", rawId, query = ""] = m;
  const id = rawId ? safeDecode(rawId) : undefined;
  switch (screen.toLowerCase()) {
    case "activity":
      return "/activity";
    case "threads":
      return "/threads";
    case "chat": {
      if (!isSafeId(id)) return null;
      const thread = queryParam(query, "thread");
      return chatHref(id, isSafeId(thread) ? thread : null);
    }
    case "approval":
      return isSafeId(id) ? `/approval/${id}` : null;
    case "mission":
      return isSafeId(id) ? `/mission/${id}` : null;
    case "agent":
      return isSafeId(id) ? `/agent/${id}` : null;
    default:
      return null;
  }
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
};

/** One query value (React Native's URLSearchParams lacks `get`). */
function queryParam(query: string, name: string): string | undefined {
  for (const pair of query.split("&")) {
    const [k, v = ""] = pair.split("=");
    if (k === name) return safeDecode(v.replace(/\+/g, " "));
  }
  return undefined;
}

/** Where an inbox item opens in the app; null when the app has no screen for it (issues, forum, routines). */
export function notificationHref(n: Pick<AppNotification, "kind" | "source" | "actors">): AppHref | null {
  const s = n.source;
  if (n.kind === "approval") return isSafeId(s.approvalId) ? `/approval/${s.approvalId}` : null;
  if ((n.kind === "mission_finished" || n.kind === "mission_stopped") && isSafeId(s.missionId))
    return `/mission/${s.missionId}`;
  if (s.topicId || s.issueId || s.issueNumber != null) return null;
  if (n.kind === "routine_finished" || n.kind === "routine_failed") return null;
  const channelId = s.channelId ?? s.dmId;
  if (isSafeId(channelId)) return chatHref(channelId, isSafeId(s.threadId) ? s.threadId : null);
  if (isSafeId(s.missionId)) return `/mission/${s.missionId}`;
  return null;
}
