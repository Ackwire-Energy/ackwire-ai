import { useMe } from "@agenteschat/client";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { useOrg } from "@/providers/org";
import { type HeaderAction, PersonAvatar } from "@/ui";
import { router } from "@/ui/navigation";
import { useColors, useDirectory, useMeId } from "./hooks";
import { OrgAvatar } from "./OrgAvatar";
import { usePersonPhoto } from "./photo";

/** The workspace's logo in the bar, and your photo on its corner. */
const ORG = 34;
const ME = 18;
/** The ring around your photo, in the page's color, lifting it off the logo. */
const RING = 2;

/**
 * The bar of the three tabs: on the left the workspace you are in (its logo, your photo small on its corner)
 * opens Você; "+" on the right pushes "New" (start a conversation or create something), in the native bar.
 */
export function useTabHeader(): { left: ReactNode; actions: HeaderAction[] } {
  const { t } = useTranslation();
  const me = useMe();
  const { org } = useOrg();
  const c = useColors();
  // Your photo as the directory has it (as Você shows it): `me` comes from the session, which the server
  // caches for minutes, so a new photo only reached the bar later.
  const meId = useMeId();
  const dir = useDirectory();
  const mine = meId ? dir.memberById.get(meId) : undefined;
  const photo = usePersonPhoto(mine?.avatarUrl ?? mine?.image ?? me.data?.user.image);
  const actions: HeaderAction[] = [
    { icon: "plus", sf: "plus", label: t("mobile.new.title"), onPress: () => router.push("/new") },
  ];
  return {
    left: (
      <Pressable
        onPress={() => router.push("/me")}
        accessibilityRole="button"
        accessibilityLabel={org?.name ? `${t("mobile.me.title")}, ${org.name}` : t("mobile.me.title")}
        hitSlop={6}
        style={({ pressed }) => [styles.box, pressed ? styles.pressed : null]}
      >
        <OrgAvatar logo={org?.logo} size={ORG} />
        <View style={[styles.me, { borderColor: c.bg, backgroundColor: c.bg }]}>
          <PersonAvatar name={me.data?.user.name ?? "?"} size={ME} photo={photo} />
        </View>
      </Pressable>
    ),
    actions,
  };
}

const styles = StyleSheet.create({
  // Room for the photo on the logo's corner.
  box: { width: ORG + 6, height: ORG + 6 },
  pressed: { opacity: 0.6 },
  me: { position: "absolute", right: 0, bottom: 0, borderRadius: (ME + RING * 2) / 2, borderWidth: RING },
});
