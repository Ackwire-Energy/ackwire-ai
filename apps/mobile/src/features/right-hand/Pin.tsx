import { rightHandSeenKey } from "@agenteschat/client/lib/right-hand";
import { useTranslation } from "react-i18next";
import { rightHandSeen } from "@/lib/storage";
import { ConversationRowView } from "../chats/ConversationRowView";
import type { ConversationRow } from "../chats/logic";
import type { AgentRowState } from "../chats/now";
import { useMeId, useOrgId } from "../shared/hooks";

/**
 * The right hand's row on top of Conversas (ADR 0134): its face, its name, "seu braço direito" in the time's place
 * and its DM's last line and unread count; "Novo" with the dot until its DM first opens on this phone. Not part of
 * the sections, so it is never collapsed or moved.
 */
export function RightHandPin({
  row,
  agent,
  onStart,
}: {
  row: ConversationRow;
  agent?: AgentRowState;
  onStart: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const fresh = rightHandSeen.useFresh(rightHandSeenKey(useMeId() ?? "", useOrgId()));
  return (
    <ConversationRowView
      row={row}
      live
      agent={agent}
      meta={fresh ? t("rightHand.newDot") : t("rightHand.label")}
      fresh={fresh}
      {...(row.kind === "dm" && !row.channelId ? { onStart } : {})}
    />
  );
}
