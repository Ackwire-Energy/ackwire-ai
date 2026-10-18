import type { ReactNode } from "react";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, withTiming } from "react-native-reanimated";
import { readValueSync, STORED, writeValue } from "@/lib/storage";
import { Count, Icon, LIST_INSET, Text } from "@/ui";
import { useColors } from "../shared/hooks";
import { HOME_SECTIONS, type HomeSection, parseCollapsed, toggleCollapsed } from "./logic";

/**
 * The sections the person collapsed, remembered across launches: Conversas' by default, or another list's
 * (`store`, `keys`: the Threads tab's Missões and Threads).
 */
export function useCollapsedSections<K extends string = HomeSection>(
  store: string = STORED.homeCollapsed,
  keys: readonly K[] = HOME_SECTIONS as unknown as readonly K[],
) {
  const [collapsed, setCollapsed] = useState<K[]>(() => parseCollapsed(readValueSync(store), keys));
  const toggle = useCallback(
    (key: K) => {
      setCollapsed((list) => {
        const next = toggleCollapsed(list, key, keys);
        void writeValue(store, next.length > 0 ? JSON.stringify(next) : null);
        return next;
      });
    },
    [store, keys],
  );
  return { collapsed, toggle };
}

/**
 * A section of Conversas (MobileHomeAgentes.html `.sec`): the title, its count in Doto and a chevron that
 * turns when collapsed; tapping the header collapses or opens it.
 */
export function CollapsibleSection({
  title,
  count,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const c = useColors();
  const chevron = useAnimatedStyle(() => ({
    transform: [{ rotate: withTiming(collapsed ? "-90deg" : "0deg", { duration: 200 }) }],
  }));
  return (
    <View>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: !collapsed }}
        style={({ pressed }) => [styles.head, pressed && styles.pressed]}
      >
        <Text variant="small" tone="ink" style={styles.title} accessibilityRole="header" numberOfLines={1}>
          {title}
        </Text>
        <Count value={count} size={15} color={c.faint} />
        <View style={styles.grow} />
        <Animated.View style={chevron}>
          <Icon name="chev" size={16} color={c.faint} />
        </Animated.View>
      </Pressable>
      {collapsed ? null : children}
    </View>
  );
}

/** "Ver todos os agentes" under a section's first rows, aligned with the text column (`.more`). */
export function SeeAllRow({ label, onPress }: { label: string; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.more, pressed && { backgroundColor: c.sunken }]}
    >
      <Text variant="small" tone="muted" style={styles.medium}>
        {label}
      </Text>
      <Icon name="right" size={15} color={c.muted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 18, paddingHorizontal: 20, paddingBottom: 6 },
  pressed: { opacity: 0.6 },
  title: { fontWeight: "600", flexShrink: 1 },
  grow: { flex: 1 },
  more: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 12,
    paddingLeft: LIST_INSET + 2,
    paddingRight: 16,
  },
  medium: { fontWeight: "500" },
});
