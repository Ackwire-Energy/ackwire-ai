import type { Agent } from "@agenteschat/client";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Icon, Sky, Text } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors } from "../shared/hooks";
import { agentLook, genderOf } from "../shared/logic";
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
  onAsk,
}: {
  agent: Agent;
  /** Room for the composer floating over the bottom. */
  bottomInset: number;
  onAsk: (text: string) => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const g = genderOf(agent.name);
  const intro = agentIntro(agent);
  const asks = useMemo(() => firstAsks(agent), [agent]);
  const title = isNewAgent(agent.createdAt)
    ? t(`mobile.chat.intent.arrived${g}`, { name: agent.name })
    : t("mobile.chat.intent.meet", { name: agent.name });
  const line =
    intro.kind === "what"
      ? intro.text
      : intro.kind === "role"
        ? t("mobile.chat.intent.roleIntro", { role: intro.role })
        : t("mobile.chat.intent.noIntro");

  return (
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
              <View style={[styles.tile, { backgroundColor: c.sunken }]}>
                <Icon name={a.icon} size={18} color={c.ink2} />
              </View>
              <Text variant="callout" tone="ink" style={[styles.grow, styles.ask]}>
                {text}
              </Text>
              <Icon name="send" size={16} color={c.faint} />
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
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
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 58,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  sep: { position: "absolute", top: 0, left: 62, right: 0, height: StyleSheet.hairlineWidth },
  tile: { width: 36, height: 36, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  ask: { fontWeight: "500" },
});
