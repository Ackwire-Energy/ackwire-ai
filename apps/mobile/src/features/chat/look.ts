import {
  CHAT_RHYTHM,
  type ChatStyle,
  type ChatTone,
  chatLookOf,
  facesShown,
  textSizeOf,
} from "@agenteschat/client/lib/chat-look";
import { isPersonal } from "@agenteschat/client/lib/workspace-mode";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { type LayoutChangeEvent, StyleSheet, useWindowDimensions } from "react-native";
import { useOrg } from "@/providers/org";
import { useTheme } from "@/ui";
import { keepSize, keptSize } from "./kept-sizes";
import { BUBBLES_INSET, bubbleFill, CHAT_TEXT, quietInset } from "./logic";

/** How this conversation's rows are drawn (`chatLookOf`, as on the web's `MessageLook`). */
export interface RowLook {
  style: ChatStyle;
  tone: ChatTone;
  /** My bubble in `bubbles`; null: the app's gray. */
  fill: string | null;
  /** False where the name says nothing (a DM's two speakers). */
  names: boolean;
  /** False where the sides say who spoke (`facesShown`, a DM with mine on the right): no face on the other side's rows. */
  faces: boolean;
  /** The words per the person's Tamanho do texto (`CHAT_TEXT`); null outside a conversation: the page's own body. */
  text: { fontSize: number; lineHeight: number } | null;
}

export const ROW_LOOK_DEFAULT: RowLook = {
  style: "comfortable",
  tone: "light",
  fill: null,
  names: true,
  faces: true,
  text: null,
};
export const RowLookContext = createContext<RowLook>(ROW_LOOK_DEFAULT);
export const useRowLook = () => useContext(RowLookContext);

/**
 * The conversation's look. My bubbles take the color of the agent I talk to, and the workspace's sky elsewhere. In a
 * personal workspace every conversation opens in bubbles, as a DM does (ADR 0159); the person's own choice wins.
 */
export function useConversationLook(dm: boolean, agentColor?: AgentColorName): RowLook {
  const { org } = useOrg();
  const { colors, scheme } = useTheme();
  const { style, tone } = chatLookOf(org?.chatPrefs, dm, isPersonal(org));
  const text = CHAT_TEXT[textSizeOf(org?.chatPrefs)];
  const fill = bubbleFill(agentColor ?? "sky", tone, colors.bg, scheme === "dark");
  return useMemo(
    () => ({ style, tone, fill, names: !dm, faces: facesShown(style, dm), text }),
    [style, tone, fill, dm, text],
  );
}

/** This conversation's rhythm: every row and line of its list takes its room from here. */
export const useRhythm = () => CHAT_RHYTHM[useRowLook().style];

/**
 * What a row's measured size depends on besides its content, for the sizes kept across the list's unmounts
 * (`kept-sizes.ts`): the window's width, the system's text size, the person's Tamanho do texto and the conversation's
 * look (its insets and faces).
 */
export function useLayoutKey(): string {
  const { width, fontScale } = useWindowDimensions();
  const { style, faces, text } = useRowLook();
  return `${Math.round(width)}:${fontScale}:${style}:${faces ? 1 : 0}:${text?.fontSize ?? 0}`;
}

/**
 * The width a part of a row has (its pictures' room), kept across the list's unmounts (`kept-sizes.ts`): a row coming
 * back lays out at its size from its first frame, never at a guess first. 0 until it is first measured.
 */
export function useKeptWidth(part: string): [number, (e: LayoutChangeEvent) => void] {
  const key = `${part}:${useLayoutKey()}`;
  const [width, setWidth] = useState(() => keptSize(key) ?? 0);
  const onLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const measured = e.nativeEvent.layout.width;
      keepSize(key, measured);
      setWidth(measured);
    },
    [key],
  );
  return [width, onLayout];
}

/**
 * In a message's body, which sets what stands between its parts: the value is how far past that gap a card stands off
 * the words above it (`CHAT_RHYTHM`'s `card` past its `part`, 0 with no words). Null outside a body.
 */
export const RowPartContext = createContext<number | null>(null);

/** A part's own top, for where it also stands alone (a mission's screen): in a message's body the body sets it. */
export const useOwnTop = (marginTop: number) => (useContext(RowPartContext) === null ? { marginTop } : undefined);

/** `useOwnTop` for a card, the one thing in a body with room of its own: `CHAT_RHYTHM`'s `card` under words. */
export const useCardTop = (marginTop = 0) => ({ marginTop: useContext(RowPartContext) ?? marginTop });

/** `quietInset` in this conversation's look. */
export const useQuietInset = () => quietInset(useRowLook());

/** The rows' frames per style. */
export const lookRows = StyleSheet.create({
  bubblesRow: { paddingLeft: BUBBLES_INSET, paddingRight: 44, gap: 8 },
  bubblesSlot: { width: 30, paddingTop: 0 },
  compactRow: { paddingLeft: 10, paddingRight: 12, gap: 6 },
  compactSlot: { width: 18, paddingTop: 1 },
  compactClock: { width: 34, textAlign: "right", lineHeight: 20, fontVariant: ["tabular-nums"] },
  bubble: { alignSelf: "flex-start", maxWidth: "100%", paddingVertical: 7, paddingHorizontal: 13, borderRadius: 18 },
});
