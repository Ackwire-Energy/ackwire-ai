import { useMe } from "@agenteschat/client";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable } from "react-native";
import { type HeaderAction, PersonAvatar } from "@/ui";

/**
 * The bar of the three tabs (MobileConversas.html): your avatar on the left opens Você, "+" on the right
 * opens "Novo" (agent, channel, a conversation with someone), as native bar items.
 */
export function useTabHeader(): { left: ReactNode; actions: HeaderAction[] } {
  const { t } = useTranslation();
  const me = useMe();
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
    actions: [{ icon: "plus", sf: "plus", label: t("mobile.new.title"), onPress: () => router.push("/new") }],
  };
}
