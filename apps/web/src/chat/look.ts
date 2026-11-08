import { type ChatPrefs, chatLookOf, textSizeOf } from "@agenteschat/client/lib/chat-look";
import { type AgentColor, agentGradient, MessageLookContext } from "@agenteschat/ui";
import { useContext, useLayoutEffect, useMemo } from "react";
import { useOrg } from "@/components/org-context";

/** The deep end of an agent's color: what my bubbles take in a DM. */
const deepOf = (color: AgentColor) => agentGradient(color)[1];

/**
 * How this conversation looks to me (`chatLookOf`). A thread opened inside a DM is that DM's: it keeps its bubbles'
 * color from the view around it. My bubbles take the color of the agent I talk to, and the workspace's sky elsewhere.
 */
export function useConversationLook(dm: boolean, agentColor?: AgentColor) {
  const { org } = useOrg();
  const around = useContext(MessageLookContext);
  const inDm = dm || (around !== null && !around.names);
  const { style, tone } = chatLookOf(org.chatPrefs, inDm);
  const mine = agentColor ? deepOf(agentColor) : inDm && around ? around.mine : deepOf("sky");
  return useMemo(() => ({ style, tone, mine, names: !inDm }), [style, tone, mine, inDm]);
}

/**
 * My Tamanho do texto on the page (`html[data-text-size]`, packages/ui's components.css), so every conversation on
 * screen, the panels and the floating thread included, takes a new choice at once. Set before the first paint: rows
 * already in the cache (the device snapshot) would otherwise show at the default for a frame, then jump.
 */
export function usePageTextSize(prefs: ChatPrefs | undefined) {
  const size = textSizeOf(prefs);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.textSize = size;
    return () => {
      delete root.dataset.textSize;
    };
  }, [size]);
}
