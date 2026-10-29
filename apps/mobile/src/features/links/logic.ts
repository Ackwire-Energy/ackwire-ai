import type { AiStatus, AppNotification } from "@agenteschat/client";
import { ROUTINE_TROUBLE } from "@agenteschat/client/lib/notifications";
import { isSafeId } from "../shared/logic";

/**
 * Where things open in the app (Expo Router paths). Deep links
 * (`agenteschat://chat/<id>`, `approval/<id>`, `mission/<id>`, `routines/<id>`, `activity`, `threads`,
 * `join-requests`), push payloads (ADR 0035 §4) and inbox items all end up here.
 */

export type AppHref =
  | `/chat/${string}`
  | `/chat/${string}?thread=${string}`
  | `/approval/${string}`
  | `/mission/${string}`
  | `/chat/${string}?handoff=${string}`
  | `/chat/${string}?thread=${string}&handoff=${string}`
  | `/agent/${string}`
  | `/handoff/${string}`
  | `/issues/${number}`
  | `/routines/${string}`
  | "/routines"
  | "/activity"
  | "/threads"
  | "/join-requests"
  | "/computer-setup"
  | "/connect-ai?ready=1";

export const chatHref = (channelId: string, threadId?: string | null): AppHref =>
  threadId && threadId !== channelId ? `/chat/${channelId}?thread=${threadId}` : `/chat/${channelId}`;

/** A routine's screen, or Rotinas when the id isn't one. */
export const routineHref = (routineId: unknown): AppHref =>
  isSafeId(routineId) ? `/routines/${routineId}` : "/routines";

/**
 * An agent's request for help in its browser opens in its conversation, with its card in control:
 * `/chat/<id>[?thread=<id>]&handoff=<id>`. Without the conversation (a bare deep link), `/handoff/<id>`
 * finds it first.
 */
export function handoffHref(handoffId: string, channelId?: unknown, threadId?: unknown): AppHref {
  if (!isSafeId(channelId)) return `/handoff/${handoffId}`;
  return isSafeId(threadId) && threadId !== channelId
    ? `/chat/${channelId}?thread=${threadId}&handoff=${handoffId}`
    : `/chat/${channelId}?handoff=${handoffId}`;
}

/** What a push carries for the deep link. */
export interface PushPayload {
  orgId?: unknown;
  kind?: unknown;
  notificationId?: unknown;
  channelId?: unknown;
  threadId?: unknown;
  approvalId?: unknown;
  missionId?: unknown;
  handoffId?: unknown;
}

const MISSION_KINDS = new Set(["mission_finished", "mission_stopped"]);

/**
 * Where "your workspace's computer is ready" opens (its push, its row in Atividade): Connect an AI, saying the
 * computer is ready, while no agent has an AI yet (what comes next is connecting one); else the computer's wait,
 * which says it's ready. `ai` unknown: the computer's.
 */
export const computerReadyHref = (ai: Pick<AiStatus, "any" | "agents"> | undefined): AppHref =>
  ai !== undefined && !ai.any && ai.agents.length > 0 ? "/connect-ai?ready=1" : "/computer-setup";

/**
 * The screen a push opens. A high-risk approval opens the request, and someone asking to join opens the requests
 * (neither is ever answered from the push). `ai`: the workspace's AI status, for the computer being ready.
 */
export function hrefForPush(p: PushPayload, ai?: Pick<AiStatus, "any" | "agents">): AppHref {
  if (isSafeId(p.approvalId)) return `/approval/${p.approvalId}`;
  if (p.kind === "join_request") return "/join-requests";
  if (p.kind === "computer_ready") return computerReadyHref(ai);
  // An agent needs a person in its browser: its conversation, with the request's card in control.
  if (p.kind === "browser_handoff" && isSafeId(p.handoffId)) return handoffHref(p.handoffId, p.channelId, p.threadId);
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
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?\/?([a-z][a-z-]*)(?:\/([^?#/]+))?\/?(?:\?([^#]*))?/i.exec(url.trim());
  if (!m) return null;
  const [, screen = "", rawId, query = ""] = m;
  const id = rawId ? safeDecode(rawId) : undefined;
  switch (screen.toLowerCase()) {
    case "activity":
      return "/activity";
    case "threads":
      return "/threads";
    case "join-requests":
      return "/join-requests";
    case "chat": {
      if (!isSafeId(id)) return null;
      const thread = queryParam(query, "thread");
      const handoff = queryParam(query, "handoff");
      if (isSafeId(handoff)) return handoffHref(handoff, id, thread);
      return chatHref(id, isSafeId(thread) ? thread : null);
    }
    case "approval":
      return isSafeId(id) ? `/approval/${id}` : null;
    case "mission":
      return isSafeId(id) ? `/mission/${id}` : null;
    case "agent":
      return isSafeId(id) ? `/agent/${id}` : null;
    case "handoff":
      return isSafeId(id) ? `/handoff/${id}` : null;
    case "routines":
      return id === undefined ? "/routines" : isSafeId(id) ? `/routines/${id}` : null;
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

/**
 * Where an inbox item opens in the app; null when the app has no screen for it (issues, forum). What a
 * routine found opens the agent's message in its conversation; a routine's trouble (failed, paused,
 * waiting for its computer), or what it found without a message, opens the routine, where its state says
 * what happened and how to fix it (as on the web). The computer being ready: `computerReadyHref` with the
 * workspace's AI status (`ai`).
 */
export function notificationHref(
  n: Pick<AppNotification, "kind" | "source">,
  ai?: Pick<AiStatus, "any" | "agents">,
): AppHref | null {
  const s = n.source;
  if (n.kind === "computer_ready") return computerReadyHref(ai);
  if (ROUTINE_TROUBLE.has(n.kind) || (n.kind === "routine_finished" && !s.messageId && !s.threadId))
    return routineHref(s.routineId);
  if (n.kind === "approval") return isSafeId(s.approvalId) ? `/approval/${s.approvalId}` : null;
  if (n.kind === "join_request") return "/join-requests";
  // An agent's browser handoff (ADR 0040): its conversation, with the request's card in control.
  if (n.kind === "browser_handoff" && isSafeId(s.handoffId))
    return handoffHref(s.handoffId, s.channelId ?? s.dmId, s.threadId);
  if ((n.kind === "mission_finished" || n.kind === "mission_stopped") && isSafeId(s.missionId))
    return `/mission/${s.missionId}`;
  if (s.topicId || s.issueId || s.issueNumber != null) return null;
  const channelId = s.channelId ?? s.dmId;
  if (isSafeId(channelId)) return chatHref(channelId, isSafeId(s.threadId) ? s.threadId : null);
  if (isSafeId(s.missionId)) return `/mission/${s.missionId}`;
  return null;
}
