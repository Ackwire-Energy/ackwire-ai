import { Menu, MenuItem } from "@agenteschat/ui";
import { createContext, useContext } from "react";
import { useTranslation } from "react-i18next";
import type { Agent, Message as MessageType } from "@/api/types";

/** What rows deeper in the timeline can do with the composer ("Chamar um agente", retry). */
export interface ChannelActions {
  insertMention: (handle: string) => void;
  retry: (local: MessageType) => void;
  resend: (body: string) => void;
  /** "Responder" on an agent's question: type the answer in the composer. */
  focusComposer: () => void;
  /** A streaming reply grew: stay at the bottom if the person is there. */
  followBottom?: () => void;
  channelAgents: Agent[];
}
export const ChannelActionsContext = createContext<ChannelActions | null>(null);
export const useChannelActions = () => useContext(ChannelActionsContext);

const inlineButton = {
  background: "none",
  border: 0,
  padding: 0,
  font: "inherit",
  cursor: "pointer",
  color: "inherit",
};

/** "Chamar um agente": inserts `@handle` into the composer. */
export function CallAgentMenu() {
  const { t } = useTranslation();
  const actions = useChannelActions();
  if (!actions || actions.channelAgents.length === 0) return null;
  return (
    <Menu
      label={t("channel.callAgentMenu")}
      trigger={
        <button
          type="button"
          className="ac-link ac-link--muted"
          style={{ ...inlineButton, textDecoration: "underline" }}
        >
          {t("channel.callAgent")}
        </button>
      }
    >
      {actions.channelAgents.map((a) => (
        <MenuItem key={a.id} icon="agent" description={`@${a.handle}`} onSelect={() => actions.insertMention(a.handle)}>
          {a.name}
        </MenuItem>
      ))}
    </Menu>
  );
}
