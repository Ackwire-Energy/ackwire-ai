import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { IconButton, type IconName, Text } from "@/ui";
import type { AppHref } from "../links/logic";

/**
 * Pieces of "Novo" (the "+" of the tabs) and its forms, each a native form sheet: the title row, and
 * leaving every sheet to open what was just made.
 */

/** The sheet's title, centered, with close (or back to "Novo") on the left. */
export function SheetHeader({
  title,
  icon = "x",
  onPress,
}: {
  title: string;
  icon?: Extract<IconName, "x" | "back">;
  /** Instead of closing the sheet (a page inside it goes back to the one before). */
  onPress?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.head}>
      <IconButton
        icon={icon}
        label={icon === "x" ? t("mobile.common.close") : t("mobile.common.back")}
        plate
        onPress={onPress ?? (() => (router.canGoBack() ? router.back() : router.replace("/")))}
      />
      <Text variant="title" style={styles.title} accessibilityRole="header" numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.side} />
    </View>
  );
}

/** Closes "Novo" and its forms, then opens `href` (a new conversation) over the tabs. */
export function closeSheetsAndOpen(href: AppHref) {
  if (router.canDismiss()) router.dismissAll();
  setTimeout(() => router.push(href), 60);
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 50, marginBottom: 4 },
  title: { flex: 1, textAlign: "center" },
  side: { width: 40 },
});
