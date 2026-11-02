import type {
  Channel,
  ComputerQueue,
  DirectMessage,
  Machine,
  MessageReceipt,
  QueueWaiting,
  QueueWhere,
} from "@agenteschat/client";
import type { FanOut, QueuePlace } from "@agenteschat/client/lib/computer-queue";

/**
 * A shared computer's line on the phone (ADR 0032, "Calm waits"): which computer a conversation's agents share, where
 * a turn answers as this person knows the conversation, and which run of a message waits in line. The words come
 * from the shared `computer-queue` lib, as on the web.
 */

/** The computer the first of these agents thinks on: a Cloud workspace has one, shared by all of them. */
export function machineOfAgents(
  machines: readonly Pick<Machine, "id" | "agents">[] | undefined,
  agentIds: readonly string[],
): string | null {
  for (const id of agentIds) {
    const m = machines?.find((x) => x.agents.some((a) => a.id === id));
    if (m) return m.id;
  }
  return null;
}

/** Where a turn answers: one of my DMs, a channel I can see (or a thread in it), else a private conversation. */
export function queuePlace(
  where: QueueWhere,
  channels: readonly Pick<Channel, "id" | "name" | "visibility" | "isMember">[] | undefined,
  dms: readonly Pick<DirectMessage, "channelId">[] | undefined,
): QueuePlace {
  if (dms?.some((d) => d.channelId === where.channelId)) return { kind: "dm", mine: true };
  const ch = channels?.find((c) => c.id === where.channelId);
  if (!ch || (ch.visibility === "private" && !ch.isMember)) return { kind: "hidden" };
  return { kind: "channel", name: ch.name, thread: where.threadId !== null };
}

/**
 * An agent's place in line for a message: its run as the receipt follows it, else its one waiting turn in this
 * conversation (a new mention joins the turn already waiting).
 */
export function waitingFor(
  queue: ComputerQueue | null | undefined,
  receipt: Pick<MessageReceipt, "runOf"> | undefined,
  agentId: string,
  channelId: string,
): QueueWaiting | null {
  const runId = receipt?.runOf?.[agentId];
  const waiting = queue?.waiting ?? [];
  return (
    (runId ? waiting.find((w) => w.runId === runId) : undefined) ??
    waiting.find((w) => w.agentId === agentId && w.where.channelId === channelId) ??
    null
  );
}

/** The strip stays while some called agent still works or waits; once all are done their replies say it. */
export const fanShows = (fan: FanOut | null): fan is FanOut => fan !== null && fan.working + fan.inLine > 0;
