import { router } from "expo-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { AgentAvatar, Icon, type IconName, SheetScreen, Sky, Text } from "@/ui";
import { NEWBORN } from "../chats/Greeting";
import { chatHref } from "../links/logic";
import { Face } from "../shared/Face";
import { useColors } from "../shared/hooks";
import { useSurface } from "../shared/parts";
import { useConversations } from "../shared/queries";
import { closeSheetsAndOpen, SheetHeader } from "./parts";

/** How many recent direct conversations "Novo" offers. */
const RECENT = 8;

/**
 * "Novo" (the "+" of the tabs, MobileConversas.html): three ways to start something (a new agent, a new
 * channel, a conversation with someone), each a form sheet over this one, and the recent direct
 * conversations.
 */
export function NewSheet() {
  const { t } = useTranslation();
  const c = useColors();
  const list = useConversations();
  const recent = list.rows.filter((r) => r.kind === "dm").slice(0, RECENT);
  return (
    <SheetScreen>
      <SheetHeader title={t("mobile.new.title")} />
      <BigOption
        tile={
          <View style={[styles.tw, { backgroundColor: c.sunken }]}>
            <Sky color="indigo" depth={0.8} style={StyleSheet.absoluteFill} />
            <AgentAvatar agent={NEWBORN} size={34} live={false} />
          </View>
        }
        title={t("mobile.agents.new")}
        hint={t("mobile.new.agentHint")}
        onPress={() => router.push("/new-agent")}
      />
      <BigOption
        icon="hash"
        title={t("mobile.chats.newChannel")}
        hint={t("mobile.chats.newChannelHint")}
        onPress={() => router.push("/new-channel")}
      />
      <BigOption
        icon="compose"
        title={t("mobile.new.chat")}
        hint={t("mobile.new.chatHint")}
        onPress={() => router.push("/new-chat")}
      />
      {recent.length > 0 ? (
        <>
          <Text variant="label" style={styles.sec}>
            {t("mobile.new.recent")}
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.recent}>
            {recent.map((r) =>
              r.kind === "dm" ? (
                <Pressable
                  key={r.key}
                  onPress={() => closeSheetsAndOpen(chatHref(r.channelId))}
                  accessibilityRole="button"
                  accessibilityLabel={r.with.name}
                  style={styles.rec}
                >
                  <RecentFace who={r.with} />
                  <Text variant="caption" tone="ink2" numberOfLines={1} style={styles.recName}>
                    {r.with.name}
                  </Text>
                </Pressable>
              ) : null,
            )}
          </ScrollView>
        </>
      ) : null}
    </SheetScreen>
  );
}

function RecentFace({ who }: { who: { type: "agent" | "person"; id: string } }) {
  const surface = useSurface();
  if (who.type === "person") return <Face who={who} size={58} />;
  return (
    <View style={[styles.recBox, surface]}>
      <Face who={who} size={40} live={false} />
    </View>
  );
}

/** One of the three ways: a tile, the title and a line under it, a chevron. */
function BigOption({
  icon,
  tile,
  title,
  hint,
  onPress,
}: {
  icon?: IconName;
  tile?: ReactNode;
  title: string;
  hint: string;
  onPress: () => void;
}) {
  const c = useColors();
  const surface = useSurface();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${hint}`}
      style={({ pressed }) => [styles.bo, surface, pressed && styles.pressed]}
    >
      {tile ?? (
        <View style={[styles.tw, { backgroundColor: c.sunken }]}>
          {icon ? <Icon name={icon} size={24} color={c.ink2} /> : null}
        </View>
      )}
      <View style={styles.grow}>
        <Text variant="title">{title}</Text>
        <Text variant="footnote" tone="muted">
          {hint}
        </Text>
      </View>
      <Icon name="right" size={18} color={c.faint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bo: { flexDirection: "row", alignItems: "center", gap: 14, padding: 14, borderRadius: 24 },
  pressed: { transform: [{ scale: 0.98 }] },
  tw: { width: 52, height: 52, borderRadius: 17, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  grow: { flex: 1, minWidth: 0 },
  sec: { paddingHorizontal: 4, paddingTop: 10 },
  recent: { gap: 14, paddingHorizontal: 4, paddingVertical: 2 },
  rec: { width: 58, alignItems: "center", gap: 5 },
  recBox: { width: 58, height: 58, borderRadius: 29, alignItems: "center", justifyContent: "center" },
  recName: { fontWeight: "500" },
});
