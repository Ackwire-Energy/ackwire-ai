import {
  type BoardItem,
  boardItems,
  type Dashboard,
  layoutOf,
  resizeItem,
  useRemoveWidget,
  useSaveLayout,
} from "@agenteschat/client";
import { layoutToSize, sizeToLayout, WIDGET_SIZES, type WidgetSize } from "@agenteschat/ui/widgets/spec";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GroupedFooter, haptics, IconButton, Segmented, Text, useTheme, useToast } from "@/ui";
import { useFailed } from "../routines/hooks";
import { AgentFace } from "../shared/Face";
import { useOrgId } from "../shared/hooks";
import { goBack, PushedHeader, successHaptic, useSurface } from "../shared/parts";
import { useBoard } from "./hooks";
import { layoutChanged, moveWidgetItem, widgetPlace } from "./logic";

/**
 * Organize a board on the phone, pushed from its "…" (ADR 0134): each widget in the board's order with Move up and
 * Move down, its size (S, M, L) and Remove. "Done" saves the order and sizes at once; a home board's tiles keep
 * their places. `id` is `home` for My Home.
 */
export function OrganizeScreen({ id }: { id: string }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const { board, loading } = useBoard(id);
  if (!board) {
    return (
      <View style={[styles.screen, { backgroundColor: c.grouped }]}>
        <PushedHeader title={t("widgets.organize.start")} solid={false} grouped />
        <View style={styles.center}>
          {loading ? (
            <ActivityIndicator color={c.muted} />
          ) : (
            <Text tone="muted" style={styles.centerText}>
              {t("dashboards.errors.notFound")}
            </Text>
          )}
        </View>
      </View>
    );
  }
  return <Arrange key={board.id} board={board} />;
}

function Arrange({ board }: { board: Dashboard }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const orgId = useOrgId();
  const toast = useToast();
  const failed = useFailed();
  const save = useSaveLayout(orgId);
  const remove = useRemoveWidget(orgId);
  const [before] = useState(() => boardItems(board.widgets, board.tiles));
  const [items, setItems] = useState<BoardItem[]>(before);
  const home = board.kind === "home";
  const widgets = items.flatMap((item) => (item.type === "widget" ? [item] : []));
  const move = (itemId: string, step: -1 | 1) => {
    haptics.selection();
    setItems((list) => moveWidgetItem(list, itemId, step));
  };
  const resize = (itemId: string, size: WidgetSize) => setItems((list) => resizeItem(list, itemId, sizeToLayout(size)));
  const done = () => {
    if (!layoutChanged(before, items)) {
      goBack();
      return;
    }
    save.mutate(
      { dashboardId: board.id, ...layoutOf(items), home },
      {
        onSuccess: () => {
          successHaptic();
          toast({ title: t("mobile.dashboards.organize.saved") });
          goBack();
        },
        onError: failed,
      },
    );
  };
  const confirmRemove = (item: Extract<BoardItem, { type: "widget" }>) =>
    Alert.alert(
      t("mobile.dashboards.widget.removeTitle", { title: item.widget.title }),
      t("mobile.dashboards.widget.removeText"),
      [
        { text: t("mobile.common.cancel"), style: "cancel" },
        {
          text: t("widgets.organize.remove"),
          style: "destructive",
          onPress: () =>
            remove.mutate(item.id, {
              onSuccess: () => {
                setItems((list) => list.filter((x) => x.id !== item.id));
                toast({ title: t("mobile.dashboards.widget.removed") });
              },
              onError: failed,
            }),
        },
      ],
    );
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={t("widgets.organize.start")}
        subtitle={home ? t("dashboards.home") : board.title}
        solid={false}
        grouped
        action={{ label: t("widgets.organize.done"), disabled: save.isPending, onPress: done }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={[styles.in, { paddingBottom: 28 + insets.bottom }]}
      >
        <GroupedFooter>{t("mobile.dashboards.organize.hint")}</GroupedFooter>
        {widgets.length === 0 ? (
          <Text variant="subhead" tone="muted" style={styles.empty}>
            {t("dashboards.empty.title")}
          </Text>
        ) : null}
        {widgets.map((item) => (
          <OrganizeRow
            key={item.id}
            item={item}
            place={widgetPlace(items, item.id)}
            onMove={(step) => move(item.id, step)}
            onSize={(size) => resize(item.id, size)}
            onRemove={() => confirmRemove(item)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

/** One widget in Organize: its agent and title, where it stands, up and down, its size, and Remove. */
function OrganizeRow({
  item,
  place,
  onMove,
  onSize,
  onRemove,
}: {
  item: Extract<BoardItem, { type: "widget" }>;
  place: { at: number; count: number };
  onMove: (step: -1 | 1) => void;
  onSize: (size: WidgetSize) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const surface = useSurface();
  const size = layoutToSize(item);
  return (
    <View style={[styles.row, surface]}>
      <View style={styles.top}>
        <AgentFace agentId={item.widget.agentId} size={26} live={false} />
        <View style={styles.grow}>
          <Text variant="body" numberOfLines={1} style={styles.semibold}>
            {item.widget.title}
          </Text>
          <Text variant="footnote" tone="faint">
            {t("mobile.dashboards.organize.position", { at: place.at, count: place.count })}
          </Text>
        </View>
        {/* `send` is the line icons' up arrow, `down`'s mirror. */}
        <IconButton
          icon="send"
          label={t("mobile.dashboards.organize.up")}
          disabled={place.at <= 1}
          onPress={() => onMove(-1)}
        />
        <IconButton
          icon="down"
          label={t("mobile.dashboards.organize.down")}
          disabled={place.at >= place.count}
          onPress={() => onMove(1)}
        />
      </View>
      <View style={styles.bottom}>
        <Text variant="footnote" tone="muted">
          {t("widgets.organize.size")}
        </Text>
        <Segmented
          items={WIDGET_SIZES.map((s) => ({ key: s, label: t(`widgets.sizes.${s}`) }))}
          value={size}
          onChange={(k) => onSize(k as WidgetSize)}
        />
        <View style={styles.grow} />
        <IconButton icon="trash" label={t("widgets.organize.remove")} onPress={onRemove} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 4, gap: 10 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  centerText: { textAlign: "center" },
  empty: { textAlign: "center", paddingVertical: 32 },
  row: {
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderBottomRightRadius: 18,
    borderBottomLeftRadius: 6,
    paddingLeft: 12,
    paddingRight: 4,
    paddingVertical: 8,
    gap: 6,
  },
  top: { flexDirection: "row", alignItems: "center", gap: 10 },
  bottom: { flexDirection: "row", alignItems: "center", gap: 10 },
  grow: { flex: 1, minWidth: 0 },
  semibold: { fontWeight: "600" },
});
