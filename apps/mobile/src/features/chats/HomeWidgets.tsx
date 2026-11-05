import { useHomeBoard, type Widget } from "@agenteschat/client";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Icon, Text } from "@/ui";
import { newWidgetHref } from "../dashboards/BoardScreen";
import { HOME, widgetsInOrder } from "../dashboards/logic";
import { WidgetPeek } from "../dashboards/WidgetPeek";
import { useColors, useOrgId } from "../shared/hooks";
import { CollapsibleSection } from "./HomeSection";

/** A widget's width on the strip: two and a bit show, so it reads as one that scrolls. */
const STRIP_WIDGET = 156;

/**
 * The home's widgets (ADR 0135 §15, §18): a head with what Início shows (My Home, or the board chosen with "Use on
 * Home") and "See all", which pushes Dashboards; then its widgets small, side by side, on a strip that scrolls
 * sideways. Tapping one opens it. With none yet, one card asks for a widget (when the person edits that board).
 */
export function HomeWidgets({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
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
  // A section of Conversas like the others: its header hides the widgets (remembered on this phone) and shows them.
  return (
    <CollapsibleSection title={title} count={widgets.length} collapsed={collapsed} onToggle={onToggle}>
      {widgets.length > 0 || !canAdd ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          snapToInterval={STRIP_WIDGET + GAP}
          decelerationRate="fast"
          contentContainerStyle={styles.strip}
        >
          {widgets.map((w) => (
            <View key={w.id} style={styles.item}>
              <WidgetPeek
                widget={w}
                canEdit={canAdd}
                board={{ id: home.chosenId ?? HOME, home: !home.chosenId }}
                compact
              />
            </View>
          ))}
          {/* "Ver todos" ends the strip: Dashboards, where every board and widget is. */}
          <Pressable
            onPress={() => router.push("/dashboards")}
            accessibilityRole="button"
            accessibilityLabel={t("dashboards.seeAll")}
            style={({ pressed }) => [styles.all, { backgroundColor: c.sunken }, pressed && styles.pressed]}
          >
            <Text variant="small" tone="muted" style={styles.medium}>
              {t("dashboards.seeAll")}
            </Text>
            <Icon name="right" size={15} color={c.muted} />
          </Pressable>
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
    </CollapsibleSection>
  );
}

const GAP = 10;

const styles = StyleSheet.create({
  medium: { fontWeight: "500" },
  // Room above and below: the cards' hairline and shadow are never cut by the strip's edge.
  strip: { paddingHorizontal: 16, gap: GAP, paddingTop: 4, paddingBottom: 6 },
  all: {
    width: 104,
    borderRadius: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  pressed: { opacity: 0.7 },
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
