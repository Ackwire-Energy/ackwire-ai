import { Tabs } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useUnreadConversations, useWaitingCount } from "@/features/shared/queries";
import { Count, fonts, Glass, haptics, Icon, type IconName, Text, useTheme } from "@/ui";

const TABS: { name: string; icon: IconName; label: string }[] = [
  { name: "index", icon: "home", label: "mobile.tabs.home" },
  { name: "chats", icon: "chat", label: "mobile.tabs.chats" },
  { name: "agents", icon: "agent", label: "mobile.tabs.agents" },
  { name: "activity", icon: "bell", label: "mobile.tabs.activity" },
];

/** Início, Conversas, Agentes, Atividade under a glass bar; Doto badges for unread and what waits on you. */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      // Our own bar: only the pieces of React Navigation's props it reads.
      tabBar={(props) => (
        <TabBar
          state={props.state as unknown as BarProps["state"]}
          // expo-router 58's bar gets an emitter and navigateToTab(key) instead of `navigation`.
          navigation={{
            emit: (e) => props.emitter.emit(e as never) as unknown as { defaultPrevented: boolean },
            navigate: (name) => {
              const route = props.state.routes.find((r) => r.name === name);
              if (route) props.navigateToTab(route.key);
            },
          }}
        />
      )}
    >
      {TABS.map((tab) => (
        <Tabs.Screen key={tab.name} name={tab.name} />
      ))}
    </Tabs>
  );
}

interface BarProps {
  state: { index: number; routes: { key: string; name: string }[] };
  navigation: {
    emit: (e: { type: "tabPress"; target: string; canPreventDefault: true }) => { defaultPrevented: boolean };
    navigate: (name: string) => void;
  };
}

function TabBar({ state, navigation }: BarProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const unread = useUnreadConversations();
  const waiting = useWaitingCount();
  const badge: Record<string, number> = { chats: unread, activity: waiting };
  return (
    <Glass style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 12), borderTopColor: colors.line }]}>
      <View style={styles.row} accessibilityRole="tablist">
        {state.routes.map((route, i) => {
          const tab = TABS.find((x) => x.name === route.name);
          if (!tab) return null;
          const on = state.index === i;
          const count = badge[route.name] ?? 0;
          const label = t(tab.label);
          return (
            <Pressable
              key={route.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={count > 0 ? t("mobile.tabs.withCount", { label, count }) : label}
              onPress={() => {
                const e = navigation.emit({ type: "tabPress", target: route.key, canPreventDefault: true });
                if (!on && !e.defaultPrevented) {
                  haptics.selection();
                  navigation.navigate(route.name);
                }
              }}
              style={styles.tab}
            >
              <View>
                <Icon name={tab.icon} size={24} color={on ? colors.ink : colors.faint} />
                {count > 0 ? (
                  <View style={[styles.badge, { borderColor: colors.bg }]}>
                    <Count value={count} size={12} inverted />
                  </View>
                ) : null}
              </View>
              <Text variant="caption" style={[styles.label, { color: on ? colors.ink : colors.faint }]}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </Glass>
  );
}

const styles = StyleSheet.create({
  bar: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", paddingTop: 8, paddingHorizontal: 14 },
  tab: { flex: 1, alignItems: "center", gap: 3, paddingVertical: 4 },
  badge: { position: "absolute", top: -6, left: 14, borderWidth: 2, borderRadius: 999 },
  label: { fontSize: 11, fontFamily: fonts.semibold },
});
