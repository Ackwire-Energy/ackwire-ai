import { chatLookOf, facesShown } from "@agenteschat/client/lib/chat-look";
import { type AgentColor, agentGradient, MessageLookContext } from "@agenteschat/ui";
import { useContext, useMemo } from "react";
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
  return useMemo(
    () => ({ style, tone, mine, names: !inDm, faces: facesShown(style, inDm) }),
    [style, tone, mine, inDm],
  );
}
