import { Pressable, StyleSheet, View } from "react-native";
import { Count } from "./Count";
import { Icon } from "./Icon";
import { Text } from "./Text";
import { useTheme } from "./theme";
import { weights } from "./type-scale";

export interface SectionHeaderProps {
  title: string;
  count?: number;
  /**
   * A way on at the header's right ("Gerenciador de tarefas ›"), as Meu Início's "Ver todos ›". `chevron: false`
   * for an act done in place (the recent searches' "Clear"): it goes nowhere, so it has no chevron.
   */
  action?: { label: string; onPress: () => void; chevron?: boolean } | null;
}

/**
 * The header over a full-width list, as Conversas' sections: 15 semibold ink, the count beside it (medium, faint),
 * and a way on at its right (medium, faint, with its chevron).
 */
export function SectionHeader({ title, count, action }: SectionHeaderProps) {
  const { colors } = useTheme();
  return (
    <View style={styles.h}>
      <Text variant="small" tone="ink" accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      {count !== undefined ? <Count value={count} size={15} weight={weights.medium} color={colors.faint} /> : null}
      {action ? (
        <Pressable
          onPress={action.onPress}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          hitSlop={12}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <Text variant="small" tone="faint" numberOfLines={1} style={styles.actionText}>
            {action.label}
          </Text>
          {action.chevron === false ? null : <Icon name="right" size={15} color={colors.faint} />}
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // The count and the way on sit on the title's baseline: on its first line when a long title wraps.
  // At the screen's 16-point margin, 24 above and 8 below: the lists' rhythm in eights.
  h: { flexDirection: "row", alignItems: "baseline", gap: 8, paddingTop: 24, paddingHorizontal: 16, paddingBottom: 8 },
  title: { fontWeight: "600", flexShrink: 1 },
  action: { marginLeft: "auto", flexDirection: "row", alignItems: "baseline", gap: 2, flexShrink: 1, minWidth: 0 },
  actionText: { fontWeight: weights.medium, flexShrink: 1 },
  pressed: { opacity: 0.6 },
});
