import type { AppNotification, WaitingItem } from "../api/types";

/**
 * What waits on me in this conversation with its card not on the loaded timeline (older than what is loaded, or in
 * one of its threads): the cards that are loaded speak for themselves. In a thread's view, only that thread's.
 */
export function waitingAway(
  items: readonly WaitingItem[] | undefined,
  channelId: string,
  threadId: string | null,
  loaded: ReadonlySet<string>,
): WaitingItem[] {
  return (items ?? []).filter(
    (i) =>
      i.source.channelId === channelId &&
      typeof i.source.messageId === "string" &&
      !loaded.has(i.source.messageId) &&
      (threadId === null || i.source.threadId === threadId),
  );
}

/** A waiting item as the inbox row it is a view of, for what opens a notification. */
export const waitingNotification = (item: WaitingItem): AppNotification => ({
  id: item.id,
  kind: item.kind,
  waiting: true,
  actors: item.asker ? [item.asker] : [],
  count: 1,
  source: item.source,
  latest: {},
  readAt: null,
  doneAt: null,
  snoozedUntil: null,
  createdAt: item.since,
  updatedAt: item.since,
});
