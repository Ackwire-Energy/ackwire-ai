import { type ChatStyle, type ChatTone, chatLookOf } from "@agenteschat/client/lib/chat-look";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { createContext, useContext, useMemo } from "react";
import { StyleSheet } from "react-native";
import { useOrg } from "@/providers/org";
import { useTheme } from "@/ui";
import { bubbleFill } from "./logic";

/** How this conversation's rows are drawn (`chatLookOf`, as on the web's `MessageLook`). */
export interface RowLook {
  style: ChatStyle;
  tone: ChatTone;
  /** My bubble in `bubbles`; null: the app's gray. */
  fill: string | null;
  /** False where the name says nothing (a DM's two speakers). */
  names: boolean;
}

export const ROW_LOOK_DEFAULT: RowLook = { style: "comfortable", tone: "light", fill: null, names: true };
export const RowLookContext = createContext<RowLook>(ROW_LOOK_DEFAULT);
export const useRowLook = () => useContext(RowLookContext);

/** The conversation's look. My bubbles take the color of the agent I talk to, and the workspace's sky elsewhere. */
export function useConversationLook(dm: boolean, agentColor?: AgentColorName): RowLook {
  const { org } = useOrg();
  const { colors, scheme } = useTheme();
  const { style, tone } = chatLookOf(org?.chatPrefs, dm);
  const fill = bubbleFill(agentColor ?? "sky", tone, colors.bg, scheme === "dark");
  return useMemo(() => ({ style, tone, fill, names: !dm }), [style, tone, fill, dm]);
}

/** The rows' frames per style, shared by the saved row (`MessageRow`) and the live one (`TurnRow`). */
export const lookRows = StyleSheet.create({
  bubblesRow: { paddingLeft: 10, paddingRight: 44, paddingVertical: 1, marginTop: 10, gap: 8 },
  bubblesSlot: { width: 30, paddingTop: 0 },
  compactRow: { paddingLeft: 10, paddingRight: 12, paddingVertical: 1, marginTop: 4, gap: 6 },
  compactSlot: { width: 18, paddingTop: 1 },
  compactClock: { width: 34, textAlign: "right", lineHeight: 20, fontVariant: ["tabular-nums"] },
  bubble: { alignSelf: "flex-start", maxWidth: "100%", paddingVertical: 7, paddingHorizontal: 13, borderRadius: 18 },
});
