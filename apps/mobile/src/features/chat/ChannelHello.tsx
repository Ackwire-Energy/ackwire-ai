import type { Agent } from "@agenteschat/client";
import { greetingSuggestions } from "@agenteschat/client/lib/chat";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { Icon, Text } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors } from "../shared/hooks";
import { tapHaptic, useSurface } from "../shared/parts";

/**
 * A channel with nothing in it yet, as on the web (ADR 0108): "Diga oi em #canal" and three first messages for its
 * agent, each a row of one card whose words wrap. Tapping one sends it, as the first conversation with an agent does.
 */
export function ChannelHello({
  channel,
  agent,
  bottomInset,
  keyboardLift,
  onAsk,
}: {
  channel: string;
  agent: Agent;
  /** Room for the composer floating over the bottom. */
  bottomInset: number;
  /** How much of the composer's bottom padding hides behind the open keyboard. */
  keyboardLift: number;
  onAsk: (text: string) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const keyboard = useReanimatedKeyboardAnimation();
  const above = useAnimatedStyle(() => ({ paddingBottom: Math.max(0, -keyboard.height.value - keyboardLift) }));
  return (
    <Animated.View style={[styles.grow, above]}>
      <ScrollView
        style={styles.grow}
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset + 16 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <Text variant="title2" style={styles.h2} accessibilityRole="header">
          {t("chat.sayHiChannel", { channel })}
        </Text>
        <View style={[styles.card, surface]}>
          {greetingSuggestions(t, agent.role).map((s, i) => {
            const label = `@${agent.name} ${s}`;
            return (
              <Pressable
                key={s}
                onPress={() => {
                  tapHaptic();
                  onAsk(`@${agent.handle} ${s}`);
                }}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityHint={t("mobile.chat.intent.sendHint")}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
              >
                {i > 0 ? <View style={[styles.sep, { backgroundColor: c.line2 }]} /> : null}
                <AgentFace agentId={agent.id} size={FACE} />
                <Text variant="callout" tone="ink" style={[styles.grow, styles.ask]}>
                  {label}
                </Text>
                <View style={styles.send}>
                  <Icon name="send" size={16} color={c.faint} />
                </View>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </Animated.View>
  );
}

/** A suggestion's row (FirstDay's): its inset, the face, the gap to the words, and the words' first line (callout). */
const INSET = 14;
const FACE = 28;
const GAP = 12;
const LINE = 21;

const styles = StyleSheet.create({
  grow: { flex: 1 },
  content: { flexGrow: 1, justifyContent: "flex-end", paddingHorizontal: 16, paddingTop: 8 },
  h2: { textAlign: "center", paddingHorizontal: 8, paddingBottom: 14 },
  card: { borderRadius: 20, overflow: "hidden" },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: GAP,
    minHeight: 52,
    paddingHorizontal: INSET,
    paddingVertical: 12,
  },
  sep: { position: "absolute", top: 0, left: INSET + FACE + GAP, right: 0, height: StyleSheet.hairlineWidth },
  // The first line's middle on the face's middle; the send icon (16) too.
  ask: { fontWeight: "500", marginTop: (FACE - LINE) / 2 },
  send: { marginTop: (FACE - 16) / 2 },
});
