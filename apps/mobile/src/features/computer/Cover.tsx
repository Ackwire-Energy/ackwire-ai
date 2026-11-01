import type { ReactNode } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { Icon, type IconName, Text } from "@/ui";
import { useColors } from "../shared/hooks";

/** The stage with nothing live on it: what it is, and why. */
export function Cover({
  icon,
  art,
  spinner = false,
  text,
  help,
  action,
  fill = false,
}: {
  icon?: IconName;
  art?: ReactNode;
  spinner?: boolean;
  text: string;
  help?: string;
  action?: ReactNode;
  /** Over the live screen's box, filling it. */
  fill?: boolean;
}) {
  const c = useColors();
  return (
    <View style={[styles.cover, fill && StyleSheet.absoluteFill, { backgroundColor: c.sunken }]}>
      {art ??
        (spinner ? (
          <ActivityIndicator color={c.muted} />
        ) : icon ? (
          <Icon name={icon} size={22} color={c.muted} />
        ) : null)}
      <Text variant="callout" tone="ink" style={[styles.bold, styles.center]}>
        {text}
      </Text>
      {help ? (
        <Text variant="small" tone="muted" style={styles.center}>
          {help}
        </Text>
      ) : null}
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  bold: { fontWeight: "600" },
  center: { textAlign: "center" },
  cover: {
    minHeight: 220,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: 20,
  },
});
