import { NativeTabs } from "expo-router/native-tabs";
import { useTranslation } from "react-i18next";
import { useUnreadConversations, useUnreadThreads, useWaitingCount } from "@/features/shared/queries";
import { TAB_BADGE, tabBadge } from "@/lib/nav";
import { haptics, useTheme } from "@/ui";
import { type TabGlyph, tabGlyphKey } from "@/ui/tabGlyphs";
import { tabGlyphFamily } from "@/ui/tabIcons";

const TABS: { name: string; glyph: TabGlyph; label: string }[] = [
  { name: "(chats)", glyph: "chats", label: "mobile.tabs.chats" },
  { name: "threads", glyph: "threads", label: "mobile.tabs.threads" },
  { name: "agents", glyph: "agents", label: "mobile.tabs.agents" },
  { name: "activity", glyph: "activity", label: "mobile.tabs.activity" },
];

/**
 * Conversas (the home), Threads (threads and missions), Agentes, Atividade in the system tab bar
 * (UITabBarController on iOS, Liquid Glass on iOS 26; Material bottom navigation on Android). Our own glyphs on both platforms (outline, filled when
 * selected), drawn as template images the bar tints. Badges for unread conversations (Conversas: channels
 * and DMs; Threads: its rows, never both) and what waits on you. Every tab holds a stack with a native header.
 */
export default function TabsLayout() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const unread = useUnreadConversations();
  const unreadThreads = useUnreadThreads();
  const waiting = useWaitingCount();
  const counts: Record<string, number> = { "(chats)": unread, threads: unreadThreads, activity: waiting };
  return (
    <NativeTabs
      tintColor={colors.ink}
      iconColor={{ default: colors.faint, selected: colors.ink }}
      labelStyle={{ default: { color: colors.faint }, selected: { color: colors.ink } }}
      backgroundColor={colors.bg}
      // iOS draws badge text in white whatever we ask: a red dark enough for it, in both themes.
      badgeBackgroundColor={TAB_BADGE.background}
      badgeTextColor={TAB_BADGE.text}
      indicatorColor={colors.sunken}
      rippleColor={colors.plate}
      labelVisibilityMode="labeled"
      // The system tab bars give no haptic on a tab change; ours did.
      screenListeners={{ tabPress: () => haptics.selection() }}
    >
      {TABS.map((tab) => {
        const label = t(tab.label);
        const count = counts[tab.name] ?? 0;
        const badge = tabBadge(count);
        return (
          <NativeTabs.Trigger
            key={tab.name}
            name={tab.name}
            accessibilityLabel={badge ? t("mobile.tabs.withCount", { label, count }) : label}
            contentStyle={{ backgroundColor: colors.bg }}
          >
            <NativeTabs.Trigger.Icon
              renderingMode="template"
              src={{
                default: <NativeTabs.Trigger.VectorIcon family={tabGlyphFamily} name={tabGlyphKey(tab.glyph, false)} />,
                selected: <NativeTabs.Trigger.VectorIcon family={tabGlyphFamily} name={tabGlyphKey(tab.glyph, true)} />,
              }}
            />
            <NativeTabs.Trigger.Label>{label}</NativeTabs.Trigger.Label>
            {badge ? <NativeTabs.Trigger.Badge>{badge}</NativeTabs.Trigger.Badge> : null}
          </NativeTabs.Trigger>
        );
      })}
    </NativeTabs>
  );
}
