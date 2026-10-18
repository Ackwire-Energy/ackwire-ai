import type {
  AppNotification,
  Channel,
  DirectMessage,
  Mission,
  MissionStatus,
  ThreadActor,
  ThreadInfo,
} from "@agenteschat/client";
import { previewOf } from "../shared/logic";

/**
 * Conversas: channels, direct messages, threads and missions in one list
 * (newest activity first), its filters and counts.
 */

export type ChatFilter = "all" | "unread" | "dm" | "threads";
/** In the order the chips show them (Todas, Não lidas, Diretas, Threads e missões). */
export const CHAT_FILTERS: ChatFilter[] = ["all", "unread", "dm", "threads"];

export interface LastLine {
  author: ThreadActor | null;
  /** The author's name as the server sent it (channels), else looked up from `author`. */
  name?: string | null;
  text: string;
}

export type ConversationRow =
  | {
      kind: "channel";
      key: string;
      channelId: string;
      name: string;
      topic: string;
      last: LastLine | null;
      at: string | null;
      unread: number;
    }
  | {
      kind: "dm";
      key: string;
      channelId: string;
      with: DirectMessage["with"];
      last: LastLine | null;
      at: string | null;
      unread: number;
      /** An agent DM where the agent is working right now ("trabalhando…"). */
      working: boolean;
    }
  | {
      kind: "thread" | "mission";
      key: string;
      channelId: string;
      threadId: string;
      title: string;
      channelName: string;
      channelKind: ThreadInfo["channelKind"];
      /** In a DM: who it is with (the channel's own name is an internal one). */
      dmWith: DirectMessage["with"] | null;
      closed: boolean;
      working: boolean;
      needsYou: boolean;
      last: LastLine | null;
      at: string | null;
      unread: number;
      mission: {
        id: string;
        agentId: string;
        status: MissionStatus;
        planDone: number;
        planTotal: number;
        waitingYou: number;
      } | null;
    };

/**
 * Every message with replies is a thread on the server (an agent's answer
 * too). The list shows the ones that are conversations of their own: a
 * mission, a titled or range thread, or one where two people talk.
 */
export function isListedThread(t: Pick<ThreadInfo, "mission" | "title" | "context" | "participants" | "state">) {
  if (t.state === "archived") return false;
  if (t.mission) return true;
  if (t.title?.trim() || t.context) return true;
  return t.participants.filter((p) => p.type === "person" && p.id).length >= 2;
}

export const threadTitle = (t: Pick<ThreadInfo, "title" | "rootText">) => t.title?.trim() || previewOf(t.rootText);

/**
 * One list: threads and missions, DMs and channels, by the latest activity (channels without any last, by
 * name). `workingChannels`: conversations where an agent has a run in progress (who is working now).
 */
export function buildConversations(input: {
  channels: Channel[];
  dms: DirectMessage[];
  threads: ThreadInfo[];
  workingChannels?: ReadonlySet<string>;
}): ConversationRow[] {
  const rows: ConversationRow[] = [];
  const dmWith = new Map(input.dms.map((d) => [d.channelId, d.with]));
  for (const t of input.threads) {
    if (!isListedThread(t)) continue;
    const m = t.mission ?? null;
    rows.push({
      kind: m ? "mission" : "thread",
      key: `t:${t.id}`,
      channelId: t.channelId,
      threadId: t.id,
      title: threadTitle(t),
      channelName: t.channelName,
      channelKind: t.channelKind,
      dmWith: t.channelKind === "dm" ? (dmWith.get(t.channelId) ?? null) : null,
      closed: t.state === "closed",
      working: t.working,
      needsYou: t.needsYou,
      last: t.lastMessage ? { author: t.lastMessage.author, text: previewOf(t.lastMessage.excerpt) } : null,
      at: t.lastActivityAt,
      unread: 0,
      mission: m
        ? {
            id: m.id,
            agentId: m.agentId,
            status: m.status,
            planDone: m.planDone,
            planTotal: m.planTotal,
            waitingYou: m.waitingYou,
          }
        : null,
    });
  }
  for (const d of input.dms) {
    rows.push({
      kind: "dm",
      key: `d:${d.channelId}`,
      channelId: d.channelId,
      with: d.with,
      last: d.lastMessage
        ? {
            author: d.lastMessage.authorType === "agent" ? { type: "agent", id: d.with.id } : null,
            text: previewOf(d.lastMessage.body),
          }
        : null,
      at: d.lastMessage?.createdAt ?? null,
      unread: Math.max(0, d.unread),
      working: d.with.type === "agent" && Boolean(input.workingChannels?.has(d.channelId)),
    });
  }
  for (const c of input.channels) {
    if (!c.isMember) continue;
    const last = c.lastMessage ?? null;
    rows.push({
      kind: "channel",
      key: `c:${c.id}`,
      channelId: c.id,
      name: c.name,
      topic: c.topic,
      last: last
        ? {
            author: { type: last.authorType, id: last.authorId },
            name: last.authorName,
            text: previewOf(last.preview),
          }
        : null,
      at: last?.createdAt ?? null,
      unread: Math.max(0, c.unreadCount ?? 0),
    });
  }
  return rows.sort((a, b) => {
    if (a.at && b.at) return b.at.localeCompare(a.at);
    if (a.at) return -1;
    if (b.at) return 1;
    return rowName(a).localeCompare(rowName(b));
  });
}

/** Where a thread or mission lives: "#vendas", or who the DM is with ("Theo"); null when unknown. */
export type RowPlace = { kind: "channel"; name: string } | { kind: "with"; name: string } | null;

/**
 * A DM's channel name is internal ("dm-…") and never shown: its other member, else (`nameOf`, from the
 * directory) the mission's agent; nothing when neither resolves.
 */
export function rowPlace(
  r: Pick<
    Extract<ConversationRow, { kind: "thread" | "mission" }>,
    "channelKind" | "channelName" | "dmWith" | "mission"
  >,
  nameOf?: (who: { type: string; id: string | null }) => string,
): RowPlace {
  if (r.channelKind === "dm") {
    const name =
      r.dmWith?.name?.trim() ||
      (r.dmWith ? nameOf?.(r.dmWith) : "") ||
      (r.mission ? nameOf?.({ type: "agent", id: r.mission.agentId }) : "") ||
      "";
    return name ? { kind: "with", name } : null;
  }
  const name = r.channelName?.trim();
  return name ? { kind: "channel", name } : null;
}

export const rowName = (r: ConversationRow) =>
  r.kind === "channel" ? r.name : r.kind === "dm" ? r.with.name : r.title;

export function filterConversations(rows: ConversationRow[], filter: ChatFilter): ConversationRow[] {
  switch (filter) {
    case "all":
      return rows;
    case "unread":
      return rows.filter((r) => r.unread > 0);
    case "threads":
      return rows.filter((r) => r.kind === "thread" || r.kind === "mission");
    case "dm":
      return rows.filter((r) => r.kind === "dm");
  }
}

/** The "Não lidas" count: conversations with something unread. */
export const unreadConversations = (rows: ConversationRow[]) => rows.filter((r) => r.unread > 0).length;

/**
 * The badge of Conversas, straight from the two lists (no thread list
 * needed): joined channels and DMs with something unread.
 */
export function unreadConversationCount(input: {
  channels: Pick<Channel, "isMember" | "unreadCount">[];
  dms: Pick<DirectMessage, "unread">[];
}): number {
  const channels = input.channels.filter((c) => c.isMember && (c.unreadCount ?? 0) > 0).length;
  const dms = input.dms.filter((d) => d.unread > 0).length;
  return channels + dms;
}

/** Counts per filter (only "Não lidas" shows one). */
export function filterCounts(rows: ConversationRow[]): Record<ChatFilter, number> {
  return {
    all: rows.length,
    unread: unreadConversations(rows),
    threads: rows.filter((r) => r.kind === "thread" || r.kind === "mission").length,
    dm: rows.filter((r) => r.kind === "dm").length,
  };
}

// ── Esperando você (top of Conversas) ───────────────────────────────────────

/** Agents' questions still open in the inbox ("Pergunta"). */
export function openQuestions<T extends Pick<AppNotification, "kind" | "doneAt">>(items: T[]): T[] {
  return items.filter((n) => n.kind === "agent_question" && !n.doneAt);
}

/** Missions with a review or a decision you may act on, and how many items each has. */
export function missionsWaiting<T extends Pick<Mission, "canAct" | "pending">>(list: T[]): T[] {
  return list.filter((m) => m.canAct && m.pending.reviews + m.pending.decisions > 0);
}

export const missionWaitingItems = (m: Pick<Mission, "pending">) => m.pending.reviews + m.pending.decisions;

/** The count next to "Esperando você": requests, mission items and open questions. */
export function waitingTotal(input: {
  approvals: number;
  missions: Pick<Mission, "pending">[];
  questions: number;
}): number {
  return input.approvals + input.missions.reduce((n, m) => n + missionWaitingItems(m), 0) + input.questions;
}
