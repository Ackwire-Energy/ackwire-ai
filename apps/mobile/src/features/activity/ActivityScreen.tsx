import { type AppNotification, useNotificationAction, useNotifications } from "@agenteschat/client";
import { router } from "expo-router";
import { memo, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Animated, PanResponder, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Card, EmptyState, Filters, Icon, LargeTitleScreen, Section, Text } from "@/ui";
import { notificationHref } from "../links/logic";
import { Face } from "../shared/Face";
import { useColors, useDirectory, useOrgId, usePullRefresh, useWhen } from "../shared/hooks";
import { tapHaptic } from "../shared/parts";
import { type ActivityFilter, activitySections, type DayGroup, placeOf, subtitleOf, whoOf } from "./logic";

/**
 * Atividade (D46): what waits on you on top, then the rest by day, grouped
 * as the server groups them. Swipe right to mark read or unread, left for
 * "Feito". Tapping opens where it happened.
 */
export function ActivityScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const list = useNotifications(orgId, filter === "waiting" ? "waiting" : "all");
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const counts = list.data?.pages[0]?.counts;
  const { waiting, days } = activitySections(items, filter);
  const pull = usePullRefresh(list.refetch);
  return (
    <LargeTitleScreen
      title={t("mobile.activity.title")}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
    >
      <Filters
        items={[
          { key: "all", label: t("mobile.activity.filter.all") },
          { key: "waiting", label: t("mobile.activity.filter.waiting"), count: counts?.waiting ?? waiting.length },
        ]}
        value={filter}
        onChange={(key) => setFilter(key as ActivityFilter)}
      />
      {waiting.length > 0 ? (
        <Section title={t("mobile.home.waiting")}>
          <Card>
            {waiting.map((n, i) => (
              <ActivityRow key={n.id} item={n} first={i === 0} />
            ))}
          </Card>
        </Section>
      ) : null}
      {days.map(([group, groupItems]) => (
        <Section key={group} title={t(`mobile.activity.day.${group satisfies DayGroup}`)}>
          <Card>
            {groupItems.map((n, i) => (
              <ActivityRow key={n.id} item={n} first={i === 0} />
            ))}
          </Card>
        </Section>
      ))}
      {list.hasNextPage ? (
        <Pressable onPress={() => void list.fetchNextPage()} accessibilityRole="button" style={styles.more}>
          <Text variant="small" tone="muted">
            {t("mobile.activity.more")}
          </Text>
        </Pressable>
      ) : null}
      {!list.isLoading && waiting.length === 0 && days.length === 0 ? (
        <EmptyState title={t("mobile.activity.empty")} sky />
      ) : null}
    </LargeTitleScreen>
  );
}

const SWIPE = 72;

/** One item: faces, who did what, the snippet, when. Swipe to act. */
const ActivityRow = memo(function ActivityRow({ item: n, first }: { item: AppNotification; first: boolean }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const dir = useDirectory();
  const c = useColors();
  const when = useWhen();
  const act = useNotificationAction(orgId);
  const x = useRef(new Animated.Value(0)).current;
  const href = notificationHref(n);
  const unread = n.readAt === null;

  const who = whoOf(n.actors, (a) => dir.nameOf({ type: a.type === "agent" ? "agent" : "person", id: a.id }));
  const names = who.second
    ? who.more > 0
      ? t("mobile.names.more", { first: who.first, second: who.second, count: who.more })
      : t("mobile.names.two", { first: who.first, second: who.second })
    : who.first;
  const title = t(`mobile.activity.kind.${n.kind}`, { names, count: who.total, defaultValue: names });
  const sub = [subtitleOf(n), placeOf(n)].filter(Boolean).join(" · ");
  const emojis = n.kind === "reaction" ? (n.latest.emojis ?? []).slice(0, 5).join(" ") : "";

  const toggleRead = () => {
    tapHaptic();
    act.mutate({ type: "read", item: n, read: unread });
  };
  const done = () => {
    tapHaptic();
    act.mutate({ type: "done", item: n, done: true });
  };
  // The pan handlers live as long as the row; they call the latest actions.
  const actions = useRef({ toggleRead, done });
  actions.current = { toggleRead, done };
  const responder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 12 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
        onPanResponderMove: (_e, g) => x.setValue(Math.max(-SWIPE * 1.4, Math.min(SWIPE * 1.4, g.dx))),
        onPanResponderRelease: (_e, g) => {
          if (g.dx > SWIPE) actions.current.toggleRead();
          else if (g.dx < -SWIPE) actions.current.done();
          Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
        },
        onPanResponderTerminate: () => Animated.spring(x, { toValue: 0, useNativeDriver: true }).start(),
      }),
    [x],
  );

  const open = () => {
    if (unread) act.mutate({ type: "read", item: n, read: true });
    if (href) router.push(href);
  };
  const faces = n.actors.slice(0, n.count > 1 ? 2 : 1);
  return (
    <View style={[!first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.line }]}>
      <View style={[StyleSheet.absoluteFill, styles.under, { backgroundColor: c.sunken }]}>
        <View style={styles.side}>
          <Icon name={unread ? "check" : "bell"} size={18} color={c.muted} />
          <Text variant="caption" tone="muted">
            {unread ? t("mobile.activity.markRead") : t("mobile.activity.markUnread")}
          </Text>
        </View>
        <View style={styles.side}>
          <Text variant="caption" tone="muted">
            {t("mobile.activity.done")}
          </Text>
          <Icon name="archive" size={18} color={c.muted} />
        </View>
      </View>
      <Animated.View style={{ transform: [{ translateX: x }], backgroundColor: c.raised }} {...responder.panHandlers}>
        <Pressable
          onPress={open}
          accessibilityRole="button"
          accessibilityLabel={`${title}. ${sub}`}
          accessibilityActions={[
            { name: "read", label: unread ? t("mobile.activity.markRead") : t("mobile.activity.markUnread") },
            { name: "done", label: t("mobile.activity.done") },
          ]}
          onAccessibilityAction={(e) => (e.nativeEvent.actionName === "read" ? toggleRead() : done())}
          style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.sunken }]}
        >
          <View style={styles.faces}>
            {faces.length === 0 ? (
              <Icon name="bell" size={20} color={c.muted} />
            ) : (
              faces.map((a, i) => (
                <View key={`${a.type}:${a.id}`} style={i > 0 ? styles.overlap : undefined}>
                  <Face
                    who={{ type: a.type === "agent" ? "agent" : "person", id: a.id }}
                    size={faces.length > 1 ? 26 : 36}
                    live={false}
                  />
                </View>
              ))
            )}
          </View>
          <View style={styles.tx}>
            <Text
              variant="body"
              tone={unread ? "ink" : "ink2"}
              style={unread ? styles.bold : undefined}
              numberOfLines={2}
            >
              {title}
            </Text>
            {sub || emojis ? (
              <Text variant="small" tone="muted" numberOfLines={2}>
                {[emojis, sub].filter(Boolean).join(" ")}
              </Text>
            ) : null}
          </View>
          <Text variant="caption" tone="faint">
            {when.short(n.updatedAt)}
          </Text>
        </Pressable>
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    minHeight: 60,
  },
  faces: { flexDirection: "row", minWidth: 36, alignItems: "center" },
  overlap: { marginLeft: -8 },
  tx: { flex: 1, minWidth: 0 },
  bold: { fontWeight: "600" },
  under: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18 },
  side: { flexDirection: "row", alignItems: "center", gap: 6 },
  more: { alignItems: "center", paddingVertical: 16 },
});
