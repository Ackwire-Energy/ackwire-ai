import type { Approval, Message } from "@/api/types";
import type { LiveRun } from "@/realtime/streams";

const byTime = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) =>
  a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1;

/** Adds (or replaces) a message in a list, keeping it ordered and without duplicates. */
export function upsertMessage(list: Message[] | undefined, message: Message): Message[] {
  const rest = (list ?? []).filter((m) => m.id !== message.id);
  return [...rest, message].sort(byTime);
}

/**
 * Agents reply inside the thread of the message that called them (the
 * executor posts with `threadId = root`), but the channel lists only
 * top-level messages. The channel view shows the conversation as one
 * timeline, as in the approved screen: top-level messages plus the loaded
 * thread replies, in time order.
 */
export function mergeTimeline(topLevel: Message[], threads: (Message[] | undefined)[]): Message[] {
  const seen = new Map<string, Message>();
  for (const m of topLevel) seen.set(m.id, m);
  for (const thread of threads) for (const m of thread ?? []) seen.set(m.id, m);
  return [...seen.values()].sort(byTime);
}

/** Top-level messages whose threads we load: the latest ones written by people (agents answer those). */
export function threadRootsToLoad(topLevel: Message[], max = 20): string[] {
  return topLevel
    .filter((m) => m.author.type === "person")
    .slice(-max)
    .map((m) => m.id);
}

export type TimelineItem =
  | { kind: "day"; key: string; iso: string }
  | { kind: "message"; key: string; message: Message; grouped: boolean }
  | { kind: "approval"; key: string; approval: Approval }
  | { kind: "run"; key: string; run: LiveRun };

const GROUP_WINDOW_MS = 5 * 60_000;
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
      item: { kind: "message" as const, key: m.id, message: m, grouped: false },
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
  for (const entry of entries) {
    const day = dayKey(entry.at);
    if (day !== lastDay) {
      out.push({ kind: "day", key: `day-${day}`, iso: entry.at });
      lastDay = day;
      prev = null;
    }
    if (entry.item.kind === "message") {
      const m = entry.item.message;
      const grouped =
        prev !== null &&
        prev.author.type === m.author.type &&
        prev.author.id === m.author.id &&
        new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS;
      out.push({ ...entry.item, grouped });
      prev = m;
    } else {
      out.push(entry.item);
      prev = null;
    }
  }
  for (const run of runs) out.push({ kind: "run", key: `run-${run.runId}`, run });
  return out;
}
