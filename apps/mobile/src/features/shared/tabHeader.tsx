import { useMe } from "@agenteschat/client";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Pressable } from "react-native";
import { type HeaderAction, PersonAvatar } from "@/ui";

/**
 * The bar of the three tabs (MobileConversas.html): Você on the left, "+" on the right opens "Novo"
 * (agent, channel, a conversation with someone), as native bar items. On iOS Você is a system bar button:
 * a custom view there (the avatar) kept the large title from collapsing, so the list scrolled under it.
 */
export function useTabHeader(): { left?: ReactNode; leftActions?: HeaderAction[]; actions: HeaderAction[] } {
  const { t } = useTranslation();
  const me = useMe();
  const actions: HeaderAction[] = [
    { icon: "plus", sf: "plus", label: t("mobile.new.title"), onPress: () => router.push("/new") },
  ];
  if (Platform.OS === "ios") {
    return {
      leftActions: [
        { icon: "circle", sf: "person.crop.circle", label: t("mobile.me.title"), onPress: () => router.push("/me") },
      ],
      actions,
    };
  }
  return {
    left: (
      <Pressable
        onPress={() => router.push("/me")}
        accessibilityRole="button"
        accessibilityLabel={t("mobile.me.title")}
        hitSlop={6}
      >
        <PersonAvatar name={me.data?.user.name ?? "?"} size={32} />
      </Pressable>
    ),
    actions,
  };
}
