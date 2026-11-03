import type {
  AppNotification,
  Channel,
  DirectMessage,
  MediaKind,
  Mission,
  MissionStatus,
  PreviewMeta,
  ThreadActor,
  ThreadInfo,
} from "@agenteschat/client";
import { hiddenAgentIds, hiddenDm } from "@agenteschat/client/lib/audience";
import type { FirstStepId } from "@agenteschat/client/lib/home";
import { looksUnread, unreadTotal } from "@agenteschat/client/lib/unread";
import type { IconName } from "@/ui";
import { previewOf } from "../shared/logic";

/**
 * Conversas: channels, direct messages, threads and missions in one list
 * (newest activity first), split by kind: the home's sections (Agentes, Canais, Pessoas), threads and
 * missions in their own tab, and what waits on you.
 */

export interface LastLine {
  author: ThreadActor | null;
  /** The author's name as the server sent it (channels), else looked up from `author`. */
  name?: string | null;
  text: string;
  /** A body the server wrote: the row shows it in the reader's language (`previewBody`). */
  meta?: PreviewMeta | null;
  /** A GIF or a sticker with no text (ADR 0091): the row says which ("GIF", "Figurinha"). */
  mediaKind?: MediaKind | null;
}

export type ConversationRow =
  | {
      kind: "channel";
      key: string;
      channelId: string;
      name: string;
      topic: string;
      /** Its sidebar category (ADR 0080); null: none. */
      categoryId: string | null;
      last: LastLine | null;
      at: string | null;
      /** New messages (0 while I muted it: it never looks unread). */
      unread: number;
      /** Unread mentions of me: the row's number, as on the web (even while muted). */
      mentions: number;
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
      /** Whose face the row shows: the last reply's author, else who started it. */
      face: ThreadActor;
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

export { hiddenAgentIds };

/**
 * One list: threads and missions, DMs and channels, by the latest activity (channels without any last, by
 * name). `workingChannels`: conversations where an agent has a run in progress (who is working now).
 */
export function buildConversations(input: {
  channels: Channel[];
  dms: DirectMessage[];
  threads: ThreadInfo[];
  workingChannels?: ReadonlySet<string>;
  hiddenAgents?: ReadonlySet<string>;
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
      face: t.lastMessage?.author ?? t.rootAuthor,
      last: t.lastMessage
        ? {
            author: t.lastMessage.author,
            text: previewOf(t.lastMessage.excerpt),
            ...(t.lastMessage.meta ? { meta: t.lastMessage.meta } : {}),
            ...(t.lastMessage.mediaKind ? { mediaKind: t.lastMessage.mediaKind } : {}),
          }
        : null,
      at: t.lastActivityAt,
      unread: Math.max(0, t.unread ?? 0),
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
    if (hiddenDm(d, input.hiddenAgents)) continue;
    rows.push({
      kind: "dm",
      key: `d:${d.channelId}`,
      channelId: d.channelId,
      with: d.with,
      last: d.lastMessage
        ? {
            author: d.lastMessage.authorType === "agent" ? { type: "agent", id: d.with.id } : null,
            text: previewOf(d.lastMessage.body),
            ...(d.lastMessage.meta ? { meta: d.lastMessage.meta } : {}),
            ...(d.lastMessage.mediaKind ? { mediaKind: d.lastMessage.mediaKind } : {}),
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
      categoryId: c.categoryId ?? null,
      last: last
        ? {
            author: { type: last.authorType, id: last.authorId },
            name: last.authorName,
            text: previewOf(last.preview),
            ...(last.meta ? { meta: last.meta } : {}),
            ...(last.mediaKind ? { mediaKind: last.mediaKind } : {}),
          }
        : null,
      at: last?.createdAt ?? null,
      unread: looksUnread(c) ? Math.max(0, c.unreadCount ?? 0) : 0,
      mentions: Math.max(0, c.mentionCount ?? 0),
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

/** The "Não lidas" count: conversations with something unread. */
export const unreadConversations = (rows: ConversationRow[]) => rows.filter((r) => r.unread > 0).length;

/**
 * The badge of Conversas, straight from the two lists (no thread list needed): joined channels and DMs
 * with something unread, the rows of the home's sections. Threads and missions have their own tab and
 * badge (`unreadThreadCount`), so nothing is counted twice.
 */
export function unreadConversationCount(input: {
  channels: Pick<Channel, "isMember" | "unreadCount" | "muted">[];
  dms: Pick<DirectMessage, "unread" | "with">[];
  hiddenAgents?: ReadonlySet<string>;
}): number {
  const channels = input.channels.filter(looksUnread).length;
  const dms = input.dms.filter((d) => d.unread > 0 && !hiddenDm(d, input.hiddenAgents)).length;
  return channels + dms;
}

/** The app icon's number: the web tab title's total (unread DM messages and mentions of me), DMs the home hides left out. */
export function appBadgeCount(input: {
  channels: Pick<Channel, "isMember" | "mentionCount">[];
  dms: Pick<DirectMessage, "unread" | "with">[];
  hiddenAgents?: ReadonlySet<string>;
}): number {
  return unreadTotal(input.channels, input.dms, input.hiddenAgents);
}

// ── The home by kind ───────────────────────────────────────────────────────

/** The home's collapsible sections, in order. */
export const HOME_SECTIONS = ["agents", "channels", "people"] as const;
export type HomeSection = (typeof HOME_SECTIONS)[number];
/** The kinds of rows: the home's sections, and threads and missions (their own tab). */
export type RowKind = HomeSection | "threads";
/** A pushed list of one kind: a section's "Ver todos" (threads and missions are a tab). */
export type ListKind = HomeSection;
/** Rows a section shows before "Ver todos". */
export const SECTION_MAX = 5;

export const isListKind = (v: unknown): v is ListKind => HOME_SECTIONS.includes(v as ListKind);

/** Which list a row belongs to: agent DMs, channels, DMs with people, threads and missions. */
export function kindOf(r: ConversationRow): RowKind {
  if (r.kind === "channel") return "channels";
  if (r.kind === "dm") return r.with.type === "agent" ? "agents" : "people";
  return "threads";
}

/** The rows of one kind, in the list's order (latest activity first). */
export const rowsOfKind = (rows: ConversationRow[], kind: RowKind) => rows.filter((r) => kindOf(r) === kind);

/** The home's sections that have rows: the first `max` of each, and how many there are in all. */
export function homeSections(
  rows: ConversationRow[],
  max = SECTION_MAX,
): { key: HomeSection; rows: ConversationRow[]; total: number; more: boolean }[] {
  return HOME_SECTIONS.map((key) => {
    const all = rowsOfKind(rows, key);
    return { key, rows: all.slice(0, max), total: all.length, more: all.length > max };
  }).filter((s) => s.total > 0);
}

/** A section of the home with the channel categories (ADR 0080): the fixed ones, or one per category. */
export type HomeKey = HomeSection | `category:${string}`;
export interface HomeBlock {
  key: HomeKey;
  /** A category's name (the fixed sections are translated by key). */
  name?: string;
  /** The category's id, for its "Ver todos" and its menu. */
  categoryId?: string;
  rows: ConversationRow[];
  total: number;
  more: boolean;
  /** A category's unread rows: they stay in sight while it is closed, as on the web. */
  unread: ConversationRow[];
}

/** A category's "Ver todos" route segment (`conversations/category-<id>`). */
const CATEGORY_LIST_PREFIX = "category-";
export const categoryListKind = (categoryId: string) => `category-${categoryId}` as const;
export const categoryOfListKind = (kind: string) =>
  kind.startsWith(CATEGORY_LIST_PREFIX) ? kind.slice(CATEGORY_LIST_PREFIX.length) || null : null;

/**
 * The home with channel categories: Agentes, Canais (the channels with no category), one section per category
 * in the sidebar's order, then Pessoas; each the first `max` by latest activity. A channel whose category is
 * unknown counts as having none. Sections with no rows are left out.
 */
export function homeLayout(
  rows: ConversationRow[],
  categories: readonly { id: string; name: string }[],
  max = SECTION_MAX,
  starters: ConversationRow[] = [],
): HomeBlock[] {
  const known = new Set(categories.map((c) => c.id));
  const categoryOf = (r: ConversationRow) =>
    r.kind === "channel" && r.categoryId && known.has(r.categoryId) ? r.categoryId : null;
  const block = (key: HomeKey, all: ConversationRow[], extra: Partial<HomeBlock> = {}): HomeBlock => ({
    key,
    rows: all.slice(0, max),
    total: all.length,
    more: all.length > max,
    unread: all.filter((r) => r.unread > 0),
    ...extra,
  });
  const channels = rowsOfKind(rows, "channels");
  return [
    // No conversation with an agent yet: the team's agents, to start one ("Ver todos" would list none).
    rowsOfKind(rows, "agents").length > 0
      ? block("agents", rowsOfKind(rows, "agents"))
      : { ...block("agents", starters), more: false },
    block(
      "channels",
      channels.filter((r) => categoryOf(r) === null),
    ),
    ...categories.map((c) =>
      block(
        `category:${c.id}`,
        channels.filter((r) => categoryOf(r) === c.id),
        { name: c.name, categoryId: c.id },
      ),
    ),
    block("people", rowsOfKind(rows, "people")),
  ].filter((b) => b.total > 0);
}

/**
 * The agents to start a conversation with, as rows of the home's Agentes section while there is no agent DM yet:
 * each a DM with no channel (`channelId: ""`), opened on press. Agents hidden from me are left out.
 */
export function agentStarters(
  agents: readonly { id: string; name: string; handle: string }[],
  hidden: ReadonlySet<string> = new Set(),
): ConversationRow[] {
  return agents
    .filter((a) => !hidden.has(a.id))
    .map((a) => ({
      kind: "dm" as const,
      key: `a:${a.id}`,
      channelId: "",
      with: { type: "agent" as const, id: a.id, name: a.name, handle: a.handle },
      last: null,
      at: null,
      unread: 0,
      working: false,
    }));
}

/** The home's closed sections as remembered: any keys (categories come and go), anything unreadable: none. */
export function parseHomeCollapsed(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/** Closes or opens one of the home's sections. */
export const toggleHomeCollapsed = (list: readonly string[], key: string) =>
  list.includes(key) ? list.filter((k) => k !== key) : [...list, key];

/** The Threads tab: threads and missions, by latest activity. */
export const threadRows = (rows: ConversationRow[]) => rowsOfKind(rows, "threads");

/** The badge of the Threads tab: thread and mission rows with something unread (replies in threads I follow). */
export const unreadThreadCount = (rows: ConversationRow[]) => threadRows(rows).filter((r) => r.unread > 0).length;

/**
 * The sections the person collapsed, as remembered (anything unreadable: none), out of `keys`. Null `keys` takes any
 * ids: the groups of agents of every workspace share one list, so one workspace's toggles keep the others'.
 */
export function parseCollapsed<K extends string>(
  raw: string | null,
  keys: readonly K[] | null = HOME_SECTIONS as unknown as readonly K[],
): K[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return keys ? keys.filter((k) => v.includes(k)) : v.filter((k): k is K => typeof k === "string");
  } catch {
    return [];
  }
}

/** Collapses or opens a section (in the sections' order; with null `keys`, the others stay as they were). */
export function toggleCollapsed<K extends string>(
  list: readonly K[],
  key: K,
  keys: readonly K[] | null = HOME_SECTIONS as unknown as readonly K[],
): K[] {
  const on = list.includes(key);
  if (!keys) return on ? list.filter((k) => k !== key) : [...list, key];
  return keys.filter((k) => (k === key ? !on : list.includes(k)));
}

// ── The Threads tab ─────────────────────────────────────────────────────────

/** The Threads tab's collapsible sections, in order. */
export const THREAD_SECTIONS = ["missions", "threads"] as const;
export type ThreadSection = (typeof THREAD_SECTIONS)[number];

type ThreadRow = Extract<ConversationRow, { kind: "thread" | "mission" }>;

/** Missões, then Threads, each by latest activity; empty ones left out. */
export function threadSections(rows: ConversationRow[]): { key: ThreadSection; rows: ThreadRow[] }[] {
  const all = threadRows(rows).filter((r): r is ThreadRow => r.kind === "thread" || r.kind === "mission");
  return [
    { key: "missions" as const, rows: all.filter((r) => r.kind === "mission") },
    { key: "threads" as const, rows: all.filter((r) => r.kind === "thread") },
  ].filter((s) => s.rows.length > 0);
}

/** Where a mission stands, for its second line ("trabalhando…", "Esperando você", "Pausada", "Concluída"). */
export type MissionState = "working" | "waiting" | "paused" | "done" | "canceled" | "active" | "proposed";

export function missionState(r: Pick<ThreadRow, "working" | "needsYou" | "mission">): MissionState | null {
  const m = r.mission;
  if (!m) return null;
  if (m.status === "canceled") return "canceled";
  if (m.status === "done") return "done";
  if (m.status === "active" && r.working) return "working";
  if (m.waitingYou > 0 || r.needsYou) return "waiting";
  if (m.status === "paused") return "paused";
  if (m.status === "awaiting_close") return "done";
  return m.status === "proposed" ? "proposed" : "active";
}

/**
 * A Threads row's lines (`trowApp`): the faint line with what it is and where ("Missão · #canal", "Missão ·
 * Theo" in a DM, "Thread · #canal"); a mission's state and progress, or a thread's last reply; the badge (a
 * mission: what waits on you in it; a thread: unread).
 */
export function threadRowLines(r: ThreadRow, nameOf?: (who: { type: string; id: string | null }) => string) {
  const place = rowPlace(r, nameOf);
  const where = !place ? null : place.kind === "with" ? place.name : `#${place.name}`;
  const state = r.kind === "mission" ? missionState(r) : null;
  return {
    kind: r.kind === "mission" ? ("mission" as const) : ("thread" as const),
    where,
    state,
    progress: r.mission ? { done: r.mission.planDone, total: r.mission.planTotal } : null,
    badge: r.kind === "mission" ? (r.mission?.waitingYou ?? 0) : r.unread,
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

// ── A new workspace's first steps (ADR 0108) ────────────────────────────────

/** The screen each of Conversas' first steps opens, and its tile. */
export const FIRST_STEP_SCREENS: Record<FirstStepId, { icon: IconName; href: string }> = {
  agent: { icon: "agent", href: "/new-agent" },
  ai: { icon: "brain", href: "/connect-ai" },
  ask: { icon: "chat", href: "/new-chat" },
  team: { icon: "members", href: "/me/members" },
  routine: { icon: "clock", href: "/routines/new" },
};
