import { useHomeBoard, type Widget } from "@agenteschat/client";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Icon, Text } from "@/ui";
import { newWidgetHref } from "../dashboards/BoardScreen";
import { HOME, widgetsInOrder } from "../dashboards/logic";
import { WidgetCard } from "../dashboards/WidgetView";
import { widgetHref } from "../links/logic";
import { useColors, useOrgId } from "../shared/hooks";

/** A widget's width on the strip: two and a bit show, so it reads as one that scrolls. */
const STRIP_WIDGET = 156;

/**
 * The home's widgets (ADR 0135 §15, §18): a head with what Início shows (My Home, or the board chosen with "Use on
 * Home") and "See all", which pushes Dashboards; then its widgets small, side by side, on a strip that scrolls
 * sideways. Tapping one opens it. With none yet, one card asks for a widget (when the person edits that board).
 */
export function HomeWidgets() {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const home = useHomeBoard(orgId);
  if (home.loading && !home.board) return null;
  const board = home.board;
  const title = home.chosenId ? (board?.title ?? home.chosenTitle ?? "") : t("dashboards.home");
  const widgets: Widget[] = board ? widgetsInOrder(board.widgets) : [];
  const canAdd = Boolean(board?.canEdit);
  const add = () => router.push(newWidgetHref(home.chosenId ?? HOME));
  return (
    <View>
      <View style={styles.head}>
        <Text variant="small" tone="ink" style={styles.title} accessibilityRole="header" numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.grow} />
        <Pressable
          onPress={() => router.push("/dashboards")}
          accessibilityRole="button"
          hitSlop={8}
          style={({ pressed }) => [styles.more, pressed && styles.pressed]}
        >
          <Text variant="small" tone="muted" style={styles.medium}>
            {t("dashboards.seeAll")}
          </Text>
          <Icon name="right" size={15} color={c.muted} />
        </Pressable>
      </View>
      {widgets.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          snapToInterval={STRIP_WIDGET + GAP}
          decelerationRate="fast"
          contentContainerStyle={styles.strip}
        >
          {widgets.map((w) => (
            <View key={w.id} style={styles.item}>
              <WidgetCard
                widget={{
                  title: w.title,
                  kind: w.kind,
                  spec: w.spec,
                  status: w.status,
                  agentId: w.agentId,
                  refreshedAt: w.refreshedAt,
                  schedule: w.schedule,
                  w: 1,
                  h: 1,
                }}
                onPress={() => router.push(widgetHref(w.id))}
                compact
              />
            </View>
          ))}
        </ScrollView>
      ) : canAdd ? (
        <Pressable
          onPress={add}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.empty,
            { borderColor: c.line2 ?? c.line },
            pressed && { backgroundColor: c.sunken },
          ]}
        >
          <Icon name="plus" size={18} color={c.muted} />
          <Text variant="subhead" tone="muted" style={styles.medium}>
            {t("widgets.add.label")}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const GAP = 10;

const styles = StyleSheet.create({
  head: { flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 20, paddingHorizontal: 20, paddingBottom: 8 },
  title: { fontWeight: "600", flexShrink: 1 },
  grow: { flex: 1 },
  more: { flexDirection: "row", alignItems: "center", gap: 2 },
  pressed: { opacity: 0.6 },
  medium: { fontWeight: "500" },
  strip: { paddingHorizontal: 16, gap: GAP, paddingBottom: 4 },
  item: { width: STRIP_WIDGET },
  empty: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginHorizontal: 16,
    paddingVertical: 18,
    borderRadius: 18,
    borderWidth: 1.5,
    borderStyle: "dashed",
  },
});
