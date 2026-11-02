import { presenceOfAvailability } from "@agenteschat/client/lib/presence";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, PresenceBadge, Text, useTheme } from "@/ui";
import { useMyPerson } from "./hooks";
import { availabilityOf, personLine } from "./logic";
import { openStatus } from "./StatusScreen";

/**
 * Your status at the top of Você (ADR 0084), right under you: your badge, "Definir status" (online with no line)
 * or how you appear, and your line with when it clears; a tap pushes Status.
 */
export function MyStatusRow() {
  const { t, i18n } = useTranslation();
  const { colors: c, shadows } = useTheme();
  const me = useMyPerson();
  const presence = presenceOfAvailability(me?.availability ?? availabilityOf(me?.presence));
  const status = me?.status ?? null;
  const title = presence === "online" && !status ? t("presence.setStatus") : t(`presence.${presence}`);
  const sub = status
    ? personLine(t, i18n.language || "en", status)
    : presence === "hidden"
      ? t("presence.hiddenPreview")
      : presence === "online"
        ? `${t("presence.online")} · ${t("presence.placeholderLower")}`
        : t("presence.placeholder");
  return (
    <Pressable
      onPress={openStatus}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${sub}`}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: c.raised, boxShadow: `${shadows.e1}, ${shadows.top}` },
        pressed && { backgroundColor: c.sunken },
      ]}
    >
      <PresenceBadge presence={presence} cell={1.4} ring={null} />
      <View style={styles.grow}>
        <Text variant="body" numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        <Text variant="small" tone="muted" numberOfLines={1}>
          {sub}
        </Text>
      </View>
      <Icon name="right" size={15} color={c.faint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: 16,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 16,
  },
  grow: { flex: 1, minWidth: 0 },
  title: { fontWeight: "600" },
});
