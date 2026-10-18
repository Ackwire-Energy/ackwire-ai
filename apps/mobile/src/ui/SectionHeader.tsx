import { StyleSheet, View } from "react-native";
import { Count } from "./Count";
import { Text } from "./Text";

export interface SectionHeaderProps {
  title: string;
  count?: number;
}

/** The header over a full-width list (MobileConversas.html `.sec-h`): 15 semibold faint, the count in Doto. */
export function SectionHeader({ title, count }: SectionHeaderProps) {
  return (
    <View style={styles.h}>
      <Text variant="small" tone="faint" accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      {count !== undefined ? <Count value={count} size={15} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  h: { flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 20, paddingHorizontal: 20, paddingBottom: 8 },
  title: { fontWeight: "600", flexShrink: 1 },
});
