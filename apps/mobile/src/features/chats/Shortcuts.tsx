import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { Count, Icon, type IconName, Text } from "@/ui";
import { useColors } from "../shared/hooks";
import { useSurface } from "../shared/parts";

export interface ShortcutItem {
  key: string;
  icon: IconName;
  title: string;
  count: number;
  /** One line under the title (the first waiting item, the latest thread). */
  preview: string | null;
  /** The icon on an inverted ink tile (something waits on you). */
  hot?: boolean;
  onPress: () => void;
}

/**
 * The shortcuts on top of Conversas, where the filters were (MobileHomeAgentes.html `.sc`/`.sct`): two cards
 * side by side ("Esperando você" only while something waits, "Threads e missões"), one card full width when
 * only one shows. Each has its icon tile, its count in Doto, the title and a one-line preview.
 */
export function Shortcuts({ items }: { items: ShortcutItem[] }) {
  if (items.length === 0) return null;
  return (
    <View style={styles.row}>
      {items.map((it) => (
        <Shortcut key={it.key} item={it} />
      ))}
    </View>
  );
}

function Shortcut({ item }: { item: ShortcutItem }) {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  return (
    <Pressable
      onPress={item.onPress}
      accessibilityRole="button"
      accessibilityLabel={[t("mobile.tabs.withCount", { label: item.title, count: item.count }), item.preview]
        .filter(Boolean)
        .join(", ")}
      style={({ pressed }) => [styles.card, surface, pressed && styles.pressed]}
    >
      <View style={styles.top}>
        <View style={[styles.tile, { backgroundColor: item.hot ? c.ink : c.sunken }]}>
          <Icon name={item.icon} size={18} color={item.hot ? c.bg : c.ink2} />
        </View>
        <Count value={item.count} size={22} />
      </View>
      <View>
        <Text variant="small" tone="ink" style={styles.bold} numberOfLines={1}>
          {item.title}
        </Text>
        {item.preview ? (
          <Text variant="caption" tone="muted" numberOfLines={1} style={styles.preview}>
            {item.preview}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: 10, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 2 },
  card: { flex: 1, minWidth: 0, gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 20 },
  pressed: { transform: [{ scale: 0.97 }] },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  tile: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  bold: { fontWeight: "600" },
  preview: { fontSize: 12.5, marginTop: 1 },
});
