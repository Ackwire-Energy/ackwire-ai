import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { Button, EmptyState, useTheme } from "@/ui";

/** A link to something the app doesn't have (or no longer has). */
export default function NotFound() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <EmptyState title={t("mobile.notFound.title")} subtitle={t("mobile.notFound.subtitle")} sky />
      <Button variant="primary" label={t("mobile.notFound.home")} onPress={() => router.replace("/")} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
});
