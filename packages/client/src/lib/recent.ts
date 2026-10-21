import type { Channel, DirectMessage } from "../api/types";

/**
 * The conversations to load as soon as the app opens: unread ones first, then
 * the latest activity (channels I'm in and DMs), at most `count` channel ids.
 */
export function recentConversations(
  channels: readonly Channel[],
  dms: readonly DirectMessage[],
  count: number,
): string[] {
  const all = new Map<string, { at: string; unread: number }>();
  for (const c of channels) {
    if (c.isMember && c.lastMessage) all.set(c.id, { at: c.lastMessage.createdAt, unread: c.unreadCount ?? 0 });
  }
  for (const d of dms) {
    if (d.lastMessage) all.set(d.channelId, { at: d.lastMessage.createdAt, unread: d.unread });
  }
  return [...all]
    .sort(([, a], [, b]) => Number(b.unread > 0) - Number(a.unread > 0) || b.at.localeCompare(a.at))
    .slice(0, count)
    .map(([id]) => id);
}
