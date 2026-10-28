import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { IconButton, Text } from "@/ui";

/** One screen inside Você: the bar (back, title, an action) over a scrolling body. */
export function Page({
  title,
  onBack,
  right,
  children,
}: {
  title?: string;
  onBack?: () => void;
  right?: ReactNode;
  children?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.fill}>
      {title ? <SheetBar title={title} onBack={onBack} right={right} /> : null}
      <ScrollView
        style={styles.fill}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={[
          styles.body,
          { paddingTop: title ? 4 : insets.top + 24, paddingBottom: 24 + insets.bottom },
        ]}
      >
        {children}
      </ScrollView>
    </View>
  );
}

/**
 * The bar of a screen inside Você (a full page, so under the status bar): the round glass back button, the title
 * centered, an action (or room).
 */
export function SheetBar({ title, onBack, right }: { title: string; onBack?: () => void; right?: ReactNode }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingTop: insets.top + 6 }]}>
      <View style={styles.side}>
        {onBack ? <IconButton icon="back" label={t("mobile.common.back")} plate onPress={onBack} /> : null}
      </View>
      <Text variant="title" accessibilityRole="header" numberOfLines={1} style={styles.barTitle}>
        {title}
      </Text>
      <View style={[styles.side, styles.sideRight]}>{right}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { paddingHorizontal: 16 },
  bar: { flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 14, paddingHorizontal: 12, paddingBottom: 6 },
  side: { width: 56, flexDirection: "row" },
  sideRight: { justifyContent: "flex-end" },
  barTitle: { flex: 1, textAlign: "center" },
});
