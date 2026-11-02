import type { Approval, Message, ReplyRef } from "../api/types";
import type { LiveRun } from "../realtime/streams";
import { messageMediaOf } from "./media";
import { answeredNotices, isAgentOnlyNotice, isAnsweredNotice, isEventLine, isTalkerReply } from "./notices";
import { quoteExcerpt } from "./reply";
import { isRoutineCall, routineReplyOf } from "./routines";
import { voiceOf } from "./voice";

const byTime = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1;

/** Adds (or replaces) a message in a list, keeping it ordered and without duplicates. */
export function upsertMessage(list: Message[] | undefined, message: Message): Message[] {
  const rest = (list ?? []).filter((m) => m.id !== message.id);
  return [...rest, message].sort(byTime);
}

/**
 * A list read again from the server, keeping my messages of the list before that are still on their way or wait to
 * go out (`waits`, by `clientId`) while the server doesn't have them (no message of its with their `clientId`). One
 * the server refused goes with the read.
 */
export function withLocalCopies(
  read: Message[],
  before: Message[] | undefined,
  waits: (clientId: string | null | undefined) => boolean,
): Message[] {
  const written = new Set(read.map((m) => m.clientId));
  const local = (before ?? []).filter(
    (m) => (m.local === "pending" || (m.local === "failed" && waits(m.clientId))) && !written.has(m.clientId),
  );
  return local.length === 0 ? read : [...read, ...local].sort(byTime);
}

/**
 * Agents reply inside the thread of the message that called them (the
 * executor posts with `threadId = root`), but the channel lists only
 * top-level messages. The channel view shows the conversation as one
 * timeline: top-level messages plus the loaded
 * thread replies, in time order.
 */
export function mergeTimeline(topLevel: Message[], threads: (Message[] | undefined)[]): Message[] {
  const seen = new Map<string, Message>();
  for (const m of topLevel) seen.set(m.id, m);
  for (const thread of threads) for (const m of thread ?? []) seen.set(m.id, m);
  return [...seen.values()].sort(byTime);
}

export type TimelineItem =
  | { kind: "day"; key: string; iso: string }
  | {
      kind: "message";
      key: string;
      message: Message;
      grouped: boolean;
      /** A reply shown away from the message it answers (others came in between): that message, quoted. */
      context?: ReplyRef;
    }
  | { kind: "approval"; key: string; approval: Approval }
  | { kind: "run"; key: string; run: LiveRun };

export const GROUP_WINDOW_MS = 5 * 60_000;

/**
 * A row's React key. An optimistic message keeps its key when the server
 * copy (same `clientId`, new id) replaces it: no remount, no flash.
 */
export const messageKey = (m: Pick<Message, "id" | "clientId">) => (m.clientId ? `c:${m.clientId}` : m.id);

/** Same author (person or agent) writing again within 5 minutes: the row collapses under the previous one. */
export function groupsWith(
  prev: { author: Message["author"]; createdAt: string } | null | undefined,
  author: Message["author"],
  createdAt: string,
) {
  if (!prev) return false;
  const gap = new Date(createdAt).getTime() - new Date(prev.createdAt).getTime();
  return prev.author.type === author.type && prev.author.id === author.id && gap < GROUP_WINDOW_MS;
}
const dayKey = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/**
 * The rows of the channel: day dividers, messages (grouped when the same
 * author writes again within 5 minutes), approval cards at the time they
 * were asked, and live agent runs at the end.
 */
export function buildTimeline(messages: Message[], approvals: Approval[], runs: LiveRun[]): TimelineItem[] {
  type Entry = { at: string; id: string; item: TimelineItem };
  const entries: Entry[] = [
    ...messages.map((m) => ({
      at: m.createdAt,
      id: m.id,
      item: { kind: "message" as const, key: messageKey(m), message: m, grouped: false },
    })),
    ...approvals.map((a) => ({
      at: a.createdAt,
      id: a.id,
      item: { kind: "approval" as const, key: a.id, approval: a },
    })),
  ].sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at < b.at ? -1 : 1));

  const out: TimelineItem[] = [];
  let lastDay = "";
  let prev: Message | null = null;
  const byId = new Map(messages.map((m) => [m.id, m]));
  // Routine reports an agent's message already answers: they fold into it.
  const answered = answeredNotices(messages);
  // The last message shown, across day dividers and cards (to tell a reply that lands far from its root).
  let lastShown: Message | null = null;
  for (const entry of entries) {
    const day = dayKey(entry.at);
    if (day !== lastDay) {
      out.push({ kind: "day", key: `day-${day}`, iso: entry.at });
      lastDay = day;
      prev = null;
    }
    if (entry.item.kind === "message") {
      const m = entry.item.message;
      // A routine's call written as its creator, a report the agent already told people about, a notice only its agent
      // reads: not shown.
      if (isRoutineCall(m) || isAnsweredNotice(m, answered) || isAgentOnlyNotice(m.meta)) continue;
      // A routine's answer (or an automatic line: a notice) always shows its own header, and nothing groups under it.
      const routine = Boolean(routineReplyOf(m)) || isEventLine(m.meta);
      const prevRoutine = Boolean(prev && (routineReplyOf(prev) || isEventLine(prev.meta)));
      const root = m.threadId ? byId.get(m.threadId) : undefined;
      const away =
        root && lastShown && lastShown.id !== root.id && lastShown.threadId !== root.id && !replyQuotes(m, root.id);
      // A root that is a GIF or a sticker with no text: its quote names it (ADR 0091).
      const rootVoice = away && voiceOf(root.meta) !== null;
      const rootMedia = rootVoice ? ("voice" as const) : away ? messageMediaOf(root.meta)?.kind : undefined;
      const context: ReplyRef | undefined = away
        ? {
            messageId: root.id,
            threadId: null,
            author: root.author,
            authorName: "",
            excerpt: rootVoice ? "" : quoteExcerpt(root.body),
            ...(rootMedia ? { media: rootMedia } : {}),
          }
        : undefined;
      out.push({
        ...entry.item,
        // A reply that quotes its root starts its own block; a fast reply while it works shows its header
        // ("enquanto trabalha").
        grouped:
          !context && !routine && !prevRoutine && !isTalkerReply(m.meta) && groupsWith(prev, m.author, m.createdAt),
        ...(context ? { context } : {}),
      });
      prev = m;
      lastShown = m;
    } else {
      out.push(entry.item);
      prev = null;
    }
  }
  for (const run of runs) out.push({ kind: "run", key: `run-${run.runId}`, run });
  return out;
}

/** The message already quotes that one itself (a person's "Responder"). */
function replyQuotes(m: Message, id: string) {
  const r = m.meta?.replyTo as { messageId?: unknown } | undefined;
  return r?.messageId === id;
}
