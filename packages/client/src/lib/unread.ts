import type { Channel, DirectMessage } from "../api/types";
import { hiddenDm } from "./audience";

/** A channel looks unread (the pill, its name in full ink): something new I haven't muted. */
export const looksUnread = (c: Pick<Channel, "isMember" | "unreadCount" | "muted">) =>
  c.isMember && !c.muted && (c.unreadCount ?? 0) > 0;

/**
 * The number on the tab's title and the phone's icon: what the numbered marks add up to, unread DM messages
 * (people and agents, but not `hiddenAgents`, whose rows aren't shown) plus mentions of me in channels (muted ones
 * too, like their mark).
 */
export function unreadTotal(
  channels: readonly Pick<Channel, "isMember" | "mentionCount">[],
  dms: readonly Pick<DirectMessage, "unread" | "with">[],
  hiddenAgents?: ReadonlySet<string>,
): number {
  let total = 0;
  for (const d of dms) if (!hiddenDm(d, hiddenAgents)) total += Math.max(0, d.unread);
  for (const c of channels) if (c.isMember) total += Math.max(0, c.mentionCount ?? 0);
  return total;
}

const COUNTED = /^\(\d+\+?\) /;

/** A title with the total in front, "(3) agentes.chat" (99+ past 99), whatever count it carried before. */
export function titledWithUnread(title: string, total: number): string {
  const bare = title.replace(COUNTED, "");
  return total > 0 ? `(${total > 99 ? "99+" : total}) ${bare}` : bare;
}
