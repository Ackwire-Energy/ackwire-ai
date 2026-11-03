import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { readValueSync, STORED, writeValue } from "@/lib/storage";
import { ConversationRowView } from "../chats/ConversationRowView";
import { type ConversationRow, parseCollapsed } from "../chats/logic";
import type { AgentRowState } from "../chats/now";
import { useMeId, useOrgId } from "../shared/hooks";

/**
 * The right hand's row on top of Conversas (ADR 0134): its face, its name, "seu braço direito" in the time's place
 * and its DM's last line and unread count; "Novo" with the dot until it is first opened on this phone. Not part of
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
  const { fresh, seen } = useRightHandSeen();
  return (
    <ConversationRowView
      row={row}
      live
      agent={agent}
      meta={fresh ? t("rightHand.newDot") : t("rightHand.label")}
      fresh={fresh}
      onOpen={seen}
      {...(row.kind === "dm" && !row.channelId ? { onStart } : {})}
    />
  );
}

/** Whether the right hand's row was opened in this workspace on this phone (`<user id>.<org id>` entries). */
function useRightHandSeen() {
  const key = `${useMeId() ?? ""}.${useOrgId()}`;
  const [list, setList] = useState(() => parseCollapsed<string>(readValueSync(STORED.rightHandSeen), null));
  const fresh = !list.includes(key);
  const seen = useCallback(() => {
    if (!fresh) return;
    const next = [...list, key];
    setList(next);
    void writeValue(STORED.rightHandSeen, JSON.stringify(next));
  }, [fresh, list, key]);
  return { fresh, seen };
}
