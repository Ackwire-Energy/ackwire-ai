import type { AiStatus, AppNotification, NotificationKind, NotificationSource } from "@agenteschat/client";
import { openTarget, ROUTINE_TROUBLE, targetPath } from "@agenteschat/client/lib/notifications";
import { isSafeId } from "../shared/logic";

/**
 * Where things open in the app (Expo Router paths). Deep links
 * (`agenteschat://chat/<id>`, `approval/<id>`, `mission/<id>`, `routines/<id>`, `activity`, `threads`,
 * `join-requests`), push payloads (ADR 0035 §4) and inbox items all end up here.
 */

export type AppHref =
  | `/chat/${string}`
  | `/chat/${string}?thread=${string}`
  | `/chat/${string}?m=${string}`
  | `/chat/${string}?thread=${string}&m=${string}`
  | `/approval/${string}`
  | `/mission/${string}`
  | `/chat/${string}?handoff=${string}`
  | `/chat/${string}?thread=${string}&handoff=${string}`
  | `/agent/${string}`
  | `/computer/${string}`
  | `/handoff/${string}`
  | `/issues/${number}`
  | `/routines/${string}`
  | `/settings/computers/${string}`
  | `/settings/skills/${string}`
  | `/consultation/${string}?channel=${string}`
  | "/routines"
  | "/issues"
  | "/connectors"
  | "/me/members"
  | "/settings/computers"
  | "/settings/skills"
  | "/activity"
  | "/threads"
  | "/join-requests"
  | "/computer-setup"
  | "/connect-ai?ready=1"
  | "/usage";

/** `messageId`: open at that message (`m=`: paged in, scrolled to and lit for a moment). */
export const chatHref = (channelId: string, threadId?: string | null, messageId?: string | null): AppHref => {
  const params = [
    threadId && threadId !== channelId ? `thread=${threadId}` : null,
    messageId ? `m=${messageId}` : null,
  ].filter(Boolean);
  return params.length ? `/chat/${channelId}?${params.join("&")}` : `/chat/${channelId}`;
};

/** Two agents' conversation for a question asked in a conversation, read only. */
export const consultationHref = (consultationId: string, channelId: string): AppHref =>
  `/consultation/${consultationId}?channel=${channelId}`;

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

/** What a push carries for the deep link (the server's `PUSH_PLACE_KEYS`, packages/engine/src/push.ts). */
export interface PushPayload {
  orgId?: unknown;
  kind?: unknown;
  notificationId?: unknown;
  channelId?: unknown;
  threadId?: unknown;
  messageId?: unknown;
  dmId?: unknown;
  approvalId?: unknown;
  missionId?: unknown;
  handoffId?: unknown;
  routineId?: unknown;
  agentId?: unknown;
  machineId?: unknown;
  topicId?: unknown;
  issueNumber?: unknown;
}

const PUSH_IDS = [
  "channelId",
  "threadId",
  "messageId",
  "dmId",
  "approvalId",
  "missionId",
  "handoffId",
  "routineId",
  "agentId",
  "machineId",
  "topicId",
] as const;

/** A push as the notification it names, from the ids it carried (checked), so it opens where its inbox row opens. */
export function pushAsNotification(p: PushPayload): Pick<AppNotification, "kind" | "source" | "actors" | "latest"> {
  const source: NotificationSource = {};
  for (const key of PUSH_IDS) {
    const v = p[key];
    if (isSafeId(v)) source[key] = v;
  }
  const issue = Number(p.issueNumber);
  if (Number.isSafeInteger(issue) && issue > 0) source.issueNumber = issue;
  return { kind: (typeof p.kind === "string" ? p.kind : "") as NotificationKind, source, actors: [], latest: {} };
}

/**
 * Where "your workspace's computer is ready" opens (its push, its row in Atividade): Connect an AI, saying the
 * computer is ready, while no agent has an AI yet (what comes next is connecting one); else the computer's wait,
 * which says it's ready. `ai` unknown: the computer's.
 */
export const computerReadyHref = (ai: Pick<AiStatus, "any" | "agents"> | undefined): AppHref =>
  ai !== undefined && !ai.any && ai.agents.length > 0 ? "/connect-ai?ready=1" : "/computer-setup";

/**
 * The screen a push opens: where its row in Atividade opens (`notificationHref`). A high-risk approval opens the
 * request, and someone asking to join opens the requests (neither is ever answered from the push). `ai`: the
 * workspace's AI status, for the computer being ready. Null: the app has no screen for it (`notificationWebPath`).
 */
export function hrefForPush(p: PushPayload, ai?: Pick<AiStatus, "any" | "agents">): AppHref | null {
  if (isSafeId(p.approvalId)) return `/approval/${p.approvalId}`;
  const n = pushAsNotification(p);
  const href = notificationHref(n, ai);
  if (href) return href;
  if (isSafeId(p.missionId)) return `/mission/${p.missionId}`;
  return notificationWebPath(n, "x") ? null : "/activity";
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
  // Asking for one more browser profile: the agent's page, where its browsers are.
  if (n.kind === "agent_unreached" || n.kind === "browser_profile_request")
    return isSafeId(s.agentId) ? `/agent/${s.agentId}` : null;
  if (n.kind === "approval") return isSafeId(s.approvalId) ? `/approval/${s.approvalId}` : null;
  // What an AI app created as the person: the newest agent, else the newest routine.
  if (n.kind === "app_created")
    return isSafeId(s.agentId) ? `/agent/${s.agentId}` : s.routineId ? routineHref(s.routineId) : null;
  if (n.kind === "join_request") return "/join-requests";
  // Someone who joined: Membros, where they now are (the app has no "say hi" of its own for them).
  if (n.kind === "invitation_accepted") return "/me/members";
  // A server changed approved tools: accepted in Conectores.
  if (n.kind === "connector_tool_changed") return "/connectors";
  // An update of a skill from its link: the skill's page, where what waits is applied.
  if (n.kind === "skill_update") return isSafeId(s.skillId) ? `/settings/skills/${s.skillId}` : "/settings/skills";
  if (n.kind === "machine_connected")
    return isSafeId(s.machineId) ? `/settings/computers/${s.machineId}` : "/settings/computers";
  // An agent held on agentes.chat Cloud: its page, where the hold shows. The workspace's own hold: the web's.
  if (n.kind === "org_standing") return isSafeId(s.agentId) ? `/agent/${s.agentId}` : null;
  // The month's Composio calls are counted in Uso.
  if (n.kind === "composio_limit") return "/usage";
  // A computer's disk is almost full (ADR 0115): that computer, where its shared folder's size shows.
  if (n.kind === "computer_disk_full" || n.kind === "computer_no_chrome")
    return isSafeId(s.machineId) ? `/settings/computers/${s.machineId}` : null;
  // An agent's browser handoff (ADR 0040): its conversation, with the request's card in control.
  if (n.kind === "browser_handoff" && isSafeId(s.handoffId)) {
    // Sent to someone who can't open its conversation (it names none): the agent's computer, the request there.
    if (!isSafeId(s.channelId ?? s.dmId) && isSafeId(s.agentId)) return `/computer/${s.agentId}`;
    return handoffHref(s.handoffId, s.channelId ?? s.dmId, s.threadId);
  }
  if ((n.kind === "mission_finished" || n.kind === "mission_stopped") && isSafeId(s.missionId))
    return `/mission/${s.missionId}`;
  // The forum has no screen in the app: the web's (`notificationWebPath`).
  if (s.topicId) return null;
  if (s.issueNumber != null && Number.isSafeInteger(s.issueNumber)) return `/issues/${s.issueNumber}`;
  if (s.issueId) return "/issues";
  const channelId = s.channelId ?? s.dmId;
  if (isSafeId(channelId))
    return chatHref(channelId, isSafeId(s.threadId) ? s.threadId : null, isSafeId(s.messageId) ? s.messageId : null);
  if (isSafeId(s.missionId)) return `/mission/${s.missionId}`;
  return null;
}

/**
 * The web page of an item the app has no screen for (a forum topic, the workspace's billing hold), opened in the
 * browser so a tap is never a dead end; null when there is none either.
 */
export function notificationWebPath(
  n: Pick<AppNotification, "kind" | "source" | "actors" | "latest">,
  orgId: string,
): string | null {
  const target = openTarget(n as AppNotification);
  return target ? targetPath(orgId, target) : null;
}
