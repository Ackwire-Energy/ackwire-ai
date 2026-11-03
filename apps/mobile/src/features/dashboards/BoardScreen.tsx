import { busyWidgets, type Widget } from "@agenteschat/client";
import { router } from "expo-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, Icon, IconButton, Text, useTheme } from "@/ui";
import { widgetHref } from "../links/logic";
import { usePullRefresh } from "../shared/hooks";
import { FocusLive, PushedHeader } from "../shared/parts";
import { SheetHostProvider } from "../shared/SheetHost";
import { useBoard } from "./hooks";
import { HOME, phoneRows, widgetsInOrder } from "./logic";
import { useBoardMenu } from "./menu";
import { AudienceLine, ProposalBanner, useBoardByline } from "./parts";
import { WidgetCard } from "./WidgetView";

/** While a widget is being built or updated, the board is asked again this often (events usually come first). */
const BUSY_POLL_MS = 15_000;

/** "New widget" for a board (`home` for My Home). */
export const newWidgetHref = (dashboardId: string) => `/widget-new?dashboardId=${dashboardId}` as const;

/**
 * A dashboard, pushed (ADR 0134): its widgets on two columns (a 2-wide one takes the whole row, a 2-high one draws
 * its data big), who sees it and how many widgets, an agent's request to publish it, and "+ Widget" at the end.
 * Share (the globe or the lock), "+" and "…" (Organize, Rename, Pin, Delete) in the bar. `id` is `home` for My Home,
 * made the first time it is opened.
 */
export function BoardScreen({ id }: { id: string }) {
  return (
    <SheetHostProvider>
      <Board id={id} />
    </SheetHostProvider>
  );
}

function Board({ id }: { id: string }) {
  const { t } = useTranslation();
  const { colors: c } = useTheme();
  const insets = useSafeAreaInsets();
  const { board, loading, failed, refetch } = useBoard(id);
  const menu = useBoardMenu(board);
  const pull = usePullRefresh(refetch);
  const byline = useBoardByline();
  const busy = board ? busyWidgets(board.widgets).length > 0 : false;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void refetch(), BUSY_POLL_MS);
    return () => clearInterval(timer);
  }, [busy, refetch]);
  if (!board) {
    return (
      <View style={[styles.screen, { backgroundColor: c.grouped }]}>
        <PushedHeader title={id === HOME ? t("dashboards.home") : ""} solid={false} grouped />
        <View style={styles.center}>
          {loading ? (
            <ActivityIndicator color={c.muted} />
          ) : (
            <>
              <Text tone="muted" style={styles.centerText}>
                {failed ? t("mobile.dashboards.loadFailed") : t("dashboards.errors.notFound")}
              </Text>
              <Button variant="secondary" size="sm" label={t("mobile.common.retry")} onPress={() => void refetch()} />
            </>
          )}
        </View>
      </View>
    );
  }
  const home = board.kind === "home";
  const title = home ? t("dashboards.home") : board.title;
  const add = () => router.push(newWidgetHref(home ? HOME : board.id));
  const share = () => router.push(`/board-share/${board.id}`);
  const widgets = widgetsInOrder(board.widgets);
  const rows = phoneRows(widgets.map((w) => ({ w: w.layout.w, widget: w })));
  const open = (w: Widget) => router.push(widgetHref(w.id));
  return (
    <View style={[styles.screen, { backgroundColor: c.grouped }]}>
      <PushedHeader
        title={title}
        subtitle={home ? t("dashboards.audience.private") : byline(board, false) || undefined}
        solid={false}
        grouped
        right={
          <View style={styles.barRight}>
            {board.canManage && !home ? (
              <IconButton
                icon={board.audience === "workspace" ? "globe" : "lock"}
                label={t("dashboards.share.action")}
                onPress={share}
              />
            ) : null}
            {board.canEdit ? <IconButton icon="plus" label={t("widgets.add.label")} onPress={add} /> : null}
            {menu.any ? <IconButton icon="more" label={menu.label} onPress={menu.open} /> : null}
          </View>
        }
      />
      <FocusLive>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
          contentContainerStyle={[styles.in, { paddingBottom: insets.bottom + 28 }]}
        >
          {home ? null : (
            <View style={styles.meta}>
              <AudienceLine board={board} after={t("dashboards.meta.widgets", { count: board.widgetCount })} />
            </View>
          )}
          <ProposalBanner board={board} />
          {widgets.length === 0 ? (
            <View style={[styles.empty, { borderColor: c.line2 }]}>
              <Text variant="title" tone="ink" style={styles.centerText}>
                {t("dashboards.empty.title")}
              </Text>
              <Text variant="subhead" tone="muted" style={styles.centerText}>
                {t("dashboards.empty.text")}
              </Text>
              {board.canEdit ? (
                <Button variant="primary" size="sm" icon="plus" label={t("widgets.add.tile")} onPress={add} />
              ) : null}
            </View>
          ) : (
            <View style={styles.grid}>
              {rows.map((items) => (
                <View key={items.map((x) => x.widget.id).join("+")} style={styles.row}>
                  {items.map(({ widget: w }) => (
                    <View key={w.id} style={items.length === 1 && w.layout.w < 2 ? styles.half : styles.cell}>
                      <WidgetCard
                        widget={{
                          title: w.title,
                          spec: w.spec,
                          status: w.status,
                          agentId: w.agentId,
                          refreshedAt: w.refreshedAt,
                          schedule: w.schedule,
                          w: w.layout.w,
                          h: w.layout.h,
                        }}
                        onPress={() => open(w)}
                      />
                    </View>
                  ))}
                </View>
              ))}
              {board.canEdit ? (
                <Pressable
                  onPress={add}
                  accessibilityRole="button"
                  accessibilityLabel={t("widgets.add.label")}
                  style={({ pressed }) => [styles.add, { borderColor: c.line2 }, pressed ? styles.pressed : null]}
                >
                  <Icon name="plus" size={18} color={c.faint} />
                  <Text variant="subhead" tone="faint" style={styles.semibold}>
                    {t("widgets.add.tile")}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          )}
        </ScrollView>
      </FocusLive>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  in: { paddingHorizontal: 16, paddingTop: 4, gap: 10 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 32 },
  centerText: { textAlign: "center" },
  barRight: { flexDirection: "row", alignItems: "center" },
  meta: { paddingHorizontal: 4, paddingTop: 4 },
  grid: { gap: 10 },
  row: { flexDirection: "row", gap: 10 },
  cell: { flex: 1, minWidth: 0 },
  half: { width: "50%", paddingRight: 5 },
  empty: {
    alignItems: "center",
    gap: 6,
    marginTop: 14,
    paddingVertical: 32,
    paddingHorizontal: 16,
    borderRadius: 22,
    borderWidth: 1.5,
  },
  add: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    minHeight: 52,
    borderWidth: 1.5,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderBottomRightRadius: 20,
    borderBottomLeftRadius: 6,
  },
  pressed: { opacity: 0.6 },
  semibold: { fontWeight: "600" },
});
