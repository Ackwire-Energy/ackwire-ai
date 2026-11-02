import { useChannels, useDms } from "@agenteschat/client";
import { titledWithUnread, unreadTotal } from "@agenteschat/client/lib/unread";
import { useEffect } from "react";

/**
 * The tab's title carries the unread total, "(3) agentes.chat" (unread DM messages and mentions of me, what the
 * sidebar's numbers add up to; DMs with `hiddenAgents` left out, as the sidebar leaves them), over whatever title a
 * page sets.
 */
export function useUnreadTitle(orgId: string, hiddenAgents: ReadonlySet<string>) {
  const channels = useChannels(orgId).data;
  const dms = useDms(orgId).data;
  const total = unreadTotal(channels ?? [], dms ?? [], hiddenAgents);
  useEffect(() => {
    const apply = () => {
      const next = titledWithUnread(document.title, total);
      if (next !== document.title) document.title = next;
    };
    apply();
    // Pages set their own titles: put the total back in front each time.
    const head = document.querySelector("head");
    const watch = head ? new MutationObserver(apply) : null;
    if (head) watch?.observe(head, { subtree: true, childList: true, characterData: true });
    return () => {
      watch?.disconnect();
      document.title = titledWithUnread(document.title, 0);
    };
  }, [total]);
}
