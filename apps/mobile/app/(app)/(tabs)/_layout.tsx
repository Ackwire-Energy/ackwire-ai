import { NativeTabs, type SFSymbolIcon } from "expo-router/native-tabs";
import { useTranslation } from "react-i18next";
import { useUnreadConversations, useWaitingCount } from "@/features/shared/queries";
import { tabBadge } from "@/lib/nav";
import { haptics, type IconName, useTheme } from "@/ui";
import { designIconFamily } from "@/ui/tabIcons";

const TABS: { name: string; icon: IconName; sf: NonNullable<SFSymbolIcon["sf"]>; label: string }[] = [
  { name: "index", icon: "home", sf: { default: "house", selected: "house.fill" }, label: "mobile.tabs.home" },
  {
    name: "chats",
    icon: "chat",
    sf: { default: "bubble.left.and.bubble.right", selected: "bubble.left.and.bubble.right.fill" },
    label: "mobile.tabs.chats",
  },
  { name: "agents", icon: "agent", sf: { default: "sparkles", selected: "sparkles" }, label: "mobile.tabs.agents" },
  { name: "activity", icon: "bell", sf: { default: "bell", selected: "bell.fill" }, label: "mobile.tabs.activity" },
];

/**
 * Início, Conversas, Agentes, Atividade in the system tab bar (UITabBarController on iOS, Liquid Glass on
 * iOS 26; Material bottom navigation on Android). SF Symbols on iOS, our line icons on Android. Badges for
 * unread conversations and what waits on you. Conversas, Agentes and Atividade each hold a stack with a
 * native large title.
 */
export default function TabsLayout() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const unread = useUnreadConversations();
  const waiting = useWaitingCount();
  const counts: Record<string, number> = { chats: unread, activity: waiting };
  return (
    <NativeTabs
      tintColor={colors.ink}
      iconColor={{ default: colors.faint, selected: colors.ink }}
      labelStyle={{ default: { color: colors.faint }, selected: { color: colors.ink } }}
      backgroundColor={colors.bg}
      badgeBackgroundColor={colors.ink}
      badgeTextColor={colors.bg}
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
              sf={tab.sf}
              src={<NativeTabs.Trigger.VectorIcon family={designIconFamily} name={tab.icon} />}
            />
            <NativeTabs.Trigger.Label>{label}</NativeTabs.Trigger.Label>
            {badge ? <NativeTabs.Trigger.Badge>{badge}</NativeTabs.Trigger.Badge> : null}
          </NativeTabs.Trigger>
        );
      })}
    </NativeTabs>
  );
}
