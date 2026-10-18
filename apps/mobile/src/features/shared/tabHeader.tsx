import { useMe } from "@agenteschat/client";
import { router } from "expo-router";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable } from "react-native";
import { type HeaderAction, PersonAvatar } from "@/ui";
import { usePersonPhoto } from "./photo";

/**
 * The bar of the three tabs (MobileConversas.html): Você on the left, "+" on the right opens "Novo"
 * (agent, channel, a conversation with someone), in the native bar.
 */
export function useTabHeader(): { left: ReactNode; actions: HeaderAction[] } {
  const { t } = useTranslation();
  const me = useMe();
  const photo = usePersonPhoto(me.data?.user.image);
  const actions: HeaderAction[] = [
    { icon: "plus", sf: "plus", label: t("mobile.new.title"), onPress: () => router.push("/new") },
  ];
  return {
    left: (
      <Pressable
        onPress={() => router.push("/me")}
        accessibilityRole="button"
        accessibilityLabel={t("mobile.me.title")}
        hitSlop={6}
      >
        <PersonAvatar name={me.data?.user.name ?? "?"} size={32} photo={photo} />
      </Pressable>
    ),
    actions,
  };
}
