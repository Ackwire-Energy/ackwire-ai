import { createContext, useContext } from "react";

/**
 * Opens an agent's page in the panel beside the conversation (like a thread's): "Ver perfil" in a DM's
 * header and in the profile card. Null outside a conversation: callers link to the agent's page instead.
 */
export const AgentPanelContext = createContext<((agentId: string) => void) | null>(null);

export const useOpenAgentPanel = () => useContext(AgentPanelContext);
