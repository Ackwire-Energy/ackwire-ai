import type { Agent } from "@agenteschat/client";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { Icon, Sky, Text } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { tapHaptic, useSurface } from "../shared/parts";
import { agentIntro, firstAsks, isNewAgent } from "./intent";

/**
 * The first conversation with an agent: under its sky, it says
 * who it is in plain words (what it does, else its role), then three first requests tied to what it
 * does. Tapping one sends it; the composer stays the other way in.
 */
export function FirstDay({
  agent,
  bottomInset,
  keyboardLift,
  onAsk,
}: {
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
  const intro = agentIntro(agent);
  const asks = useMemo(() => firstAsks(agent), [agent]);
  // The composer rides the keyboard; the welcome gives way with it instead of staying under the keys.
  const keyboard = useReanimatedKeyboardAnimation();
  const above = useAnimatedStyle(() => ({ paddingBottom: Math.max(0, -keyboard.height.value - keyboardLift) }));
  const title = isNewAgent(agent.createdAt)
    ? // No "o"/"a" before the name: guessing it from the name gave "O Atende".
      t("mobile.chat.intent.arrived", { name: agent.name })
    : t("mobile.chat.intent.meet", { name: agent.name });
  const line =
    intro.kind === "what"
      ? intro.text
      : intro.kind === "role"
        ? t("mobile.chat.intent.roleIntro", { role: intro.role })
        : t("mobile.chat.intent.noIntro");

  return (
    <Animated.View style={[styles.grow, above]}>
      <ScrollView
        style={styles.grow}
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset + 16 }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        <View style={[styles.welc, surface]}>
          <Sky color={agentLook(agent).color} depth={0.8} surface="raised" style={styles.sky} />
          <View style={styles.born}>
            <AgentFace agentId={agent.id} size={78} />
          </View>
          <Text variant="display" style={styles.h2} accessibilityRole="header">
            {title}
          </Text>
          <Text variant="callout" tone="muted" style={styles.p}>
            {line}
          </Text>
        </View>
        <Text variant="footnote" tone="faint" style={styles.h3}>
          {t("mobile.chat.intent.firstTitle")}
        </Text>
        <View style={[styles.card, surface]}>
          {asks.map((a, i) => {
            const text = t(`mobile.chat.intent.first.${a.key}`);
            return (
              <Pressable
                key={a.key}
                onPress={() => {
                  tapHaptic();
                  onAsk(text);
                }}
                accessibilityRole="button"
                accessibilityLabel={text}
                accessibilityHint={t("mobile.chat.intent.sendHint")}
                style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
              >
                {i > 0 ? <View style={[styles.sep, { backgroundColor: c.line2 }]} /> : null}
                <View style={styles.mark}>
                  <Icon name={a.icon} size={18} color={c.ink2} />
                </View>
                <Text variant="callout" tone="ink" style={[styles.grow, styles.ask]}>
                  {text}
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

const styles = StyleSheet.create({
  grow: { flex: 1 },
  content: { flexGrow: 1, justifyContent: "flex-end", paddingHorizontal: 16, paddingTop: 8 },
  welc: {
    alignItems: "center",
    paddingTop: 134,
    paddingHorizontal: 20,
    paddingBottom: 18,
    borderRadius: 20,
    overflow: "hidden",
  },
  sky: { position: "absolute", top: 0, left: 0, right: 0, height: 150 },
  born: { position: "absolute", top: 34, alignSelf: "center" },
  h2: { textAlign: "center" },
  p: { marginTop: 6, textAlign: "center", lineHeight: 21 },
  h3: { fontWeight: "600", paddingHorizontal: 4, paddingTop: 18, paddingBottom: 8 },
  card: { borderRadius: 20, overflow: "hidden" },
  // The channel's suggestions' rows (ChannelHello): a 28 mark (no tile inside the card), the first line's middle on
  // its middle when a suggestion wraps (28 against a 21 line), the send icon there too.
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  sep: { position: "absolute", top: 0, left: 54, right: 0, height: StyleSheet.hairlineWidth },
  mark: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  ask: { fontWeight: "500", marginTop: 3 },
  send: { marginTop: 6 },
});
