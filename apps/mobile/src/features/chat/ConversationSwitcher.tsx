import { router } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { Glass, haptics, Icon, Text, useTheme } from "@/ui";
import { rowName } from "../chats/logic";
import { chatHref } from "../links/logic";
import { AgentFace, Face } from "../shared/Face";
import { useDirectory } from "../shared/hooks";
import { Tile } from "../shared/parts";
import { useConversations, useWorkingNow } from "../shared/queries";

/** Each row's height: the finger's place picks the row without measuring each one. */
const ROW = 52;
const PAD = 6;
/** The current conversation, then the latest others. */
const MAX_ROWS = 7;

/** Where the finger is while it holds the header's pill (window coordinates), and whether it let go. */
export interface SwitcherTouch {
  x: number;
  y: number;
  up: boolean;
}

/**
 * Holding the conversation's pill drops this card under it: the latest DMs and channels, the current one first
 * with a check. Without lifting the finger, sliding over a row picks it (a selection tap on each) and letting go
 * there opens it, in place of this one; let go anywhere else first and the card stays for a tap (as iOS's back
 * button menu).
 */
export function ConversationSwitcher({
  channelId,
  top,
  touch,
  onClose,
}: {
  channelId: string;
  /** Where the card starts: under the header. */
  top: number;
  /** The holding finger, from the pill (null once it let go). */
  touch: SwitcherTouch | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { colors, shadows } = useTheme();
  const { width } = useWindowDimensions();
  const dir = useDirectory();
  const working = useWorkingNow();
  const { rows } = useConversations();
  const items = useMemo(() => {
    const convs = rows.filter((r) => r.kind === "dm" || r.kind === "channel");
    const here = convs.find((r) => r.channelId === channelId);
    const rest = convs.filter((r) => r.channelId !== channelId).slice(0, MAX_ROWS - (here ? 1 : 0));
    return here ? [here, ...rest] : rest;
  }, [rows, channelId]);
  const busy = useMemo(() => new Set(working.map((w) => w.channelId)), [working]);

  const cardWidth = Math.min(320, width - 32);
  const left = (width - cardWidth) / 2;
  const [hover, setHover] = useState<number | null>(null);
  const hovered = useRef(false);
  const open = (i: number) => {
    const r = items[i];
    onClose();
    if (!r || r.channelId === channelId) return;
    haptics.light();
    router.replace(chatHref(r.channelId, null));
  };

  // The finger sliding over the card: the row under it, a selection tap each time it changes; letting go on one opens it.
  const indexAt = (x: number, y: number): number | null => {
    if (x < left || x > left + cardWidth) return null;
    const i = Math.floor((y - top - PAD) / ROW);
    return i >= 0 && i < items.length ? i : null;
  };
  const touchRef = useRef(touch);
  touchRef.current = touch;
  useEffect(() => {
    if (!touch) return;
    const i = indexAt(touch.x, touch.y);
    if (touch.up) {
      if (i !== null) open(i);
      else if (hovered.current) onClose();
      setHover(null);
      return;
    }
    if (i !== null) hovered.current = true;
    setHover((prev) => {
      if (prev !== i && i !== null) haptics.selection();
      return i;
    });
    // biome-ignore lint/correctness/useExhaustiveDependencies: follows the finger only
  }, [touch]);

  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={t("mobile.common.close")} />
      <Animated.View
        entering={FadeIn.duration(140)}
        exiting={FadeOut.duration(120)}
        style={[styles.card, { top, left, width: cardWidth, boxShadow: shadows.e2 }]}
      >
        <Glass liquid intensity={80} style={[styles.glass, { borderColor: colors.line2 }]}>
          {items.map((r, i) => {
            const name = rowName(r);
            const agentId = r.kind === "dm" && r.with.type === "agent" ? r.with.id : null;
            const doing = busy.has(r.channelId);
            const sub =
              r.kind === "channel"
                ? null
                : doing
                  ? t("mobile.chat.switchWorking")
                  : agentId
                    ? (dir.agentById.get(agentId)?.role ?? null)
                    : null;
            const current = r.channelId === channelId;
            return (
              <Pressable
                key={r.key}
                onPress={() => open(i)}
                accessibilityRole="button"
                accessibilityLabel={t("mobile.chat.switchTo", { name })}
                accessibilityState={{ selected: current }}
                style={({ pressed }) => [
                  styles.row,
                  (hover === i || pressed) && { backgroundColor: colors.sunken },
                ]}
              >
                {r.kind === "dm" ? (
                  agentId ? (
                    <AgentFace agentId={agentId} size={30} framed={false} mode={doing ? "run" : "idle"} />
                  ) : (
                    <Face who={{ type: r.with.type, id: r.with.id }} size={30} live={false} />
                  )
                ) : (
                  <Tile icon="hash" size={30} />
                )}
                <View style={styles.text}>
                  <Text variant="callout" numberOfLines={1} style={styles.name}>
                    {name}
                  </Text>
                  {sub ? (
                    <Text variant="caption" tone="muted" numberOfLines={1}>
                      {sub}
                    </Text>
                  ) : null}
                </View>
                {current ? <Icon name="check" size={16} color={colors.muted} /> : null}
              </Pressable>
            );
          })}
        </Glass>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { position: "absolute", borderRadius: 22 },
  glass: { borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, padding: PAD },
  row: { height: ROW, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, borderRadius: 16 },
  text: { flex: 1, minWidth: 0 },
  name: { fontWeight: "600" },
});
