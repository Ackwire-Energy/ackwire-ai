import { type AppNotification, useNotificationAction, useNotifications } from "@agenteschat/client";
import { router } from "expo-router";
import { Fragment, memo, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Animated, PanResponder, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import {
  EmptyState,
  Filters,
  Icon,
  LargeTitleScreen,
  LIST_AVATAR,
  LIST_INSET,
  ListRow,
  SectionHeader,
  Text,
} from "@/ui";
import { notificationHref } from "../links/logic";
import { Face } from "../shared/Face";
import { useColors, useDirectory, useOrgId, usePullRefresh, useWhen } from "../shared/hooks";
import { Tile, tapHaptic } from "../shared/parts";
import { useTabHeader } from "../shared/tabHeader";
import { type ActivityFilter, activitySections, type DayGroup, emojisOf, placeOf, subtitleOf, whoOf } from "./logic";

/**
 * Atividade (D46): what waits on you on top, then the rest by day, grouped
 * as the server groups them, in Conversas' full-width rows under `.sec-h` headers. Swipe right to mark read or unread, left for
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
  const header = useTabHeader();
  return (
    <LargeTitleScreen
      title={t("mobile.activity.title")}
      {...header}
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
      <View style={styles.list}>
        {waiting.length > 0 ? (
          <>
            <SectionHeader title={t("mobile.home.waiting")} count={counts?.waiting ?? waiting.length} />
            {waiting.map((n, i) => (
              <ActivityRow key={n.id} item={n} divider={i > 0} />
            ))}
          </>
        ) : null}
        {days.map(([group, groupItems]) => (
          <View key={group}>
            <SectionHeader title={t(`mobile.activity.day.${group satisfies DayGroup}`)} />
            {groupItems.map((n, i) => (
              <ActivityRow key={n.id} item={n} divider={i > 0} />
            ))}
          </View>
        ))}
      </View>
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
/** Stands in for the names in the translated title, so they can be drawn bold. */
const NAMES = "\u2063names\u2063";

/**
 * One item, in Conversas' row (MobileConversas.html, S.activity): the faces, who did what (the names bold)
 * and when, the snippet and where; a dot on the left while unread. Swipe right to mark read or unread,
 * left for "Feito"; tapping opens where it happened.
 */
const ActivityRow = memo(function ActivityRow({ item: n, divider }: { item: AppNotification; divider: boolean }) {
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
  const template = t(`mobile.activity.kind.${n.kind}`, { names: NAMES, count: who.total, defaultValue: NAMES });
  const parts = template.split(NAMES);
  const title = parts.join(names);
  const sub = [emojisOf(n).join(" "), [subtitleOf(n), placeOf(n)].filter(Boolean).join(" · ")]
    .filter(Boolean)
    .join(" ");
  const time = when.short(n.updatedAt);

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
  const leading =
    faces.length === 0 ? (
      <Tile icon="bell" size={LIST_AVATAR} />
    ) : faces.length === 1 ? (
      <Face who={faceOf(faces[0])} size={faces[0]?.type === "agent" ? LIST_AVATAR - 2 : LIST_AVATAR} live={false} />
    ) : (
      <View style={styles.stack}>
        <View style={styles.back}>
          <Face who={faceOf(faces[0])} size={STACKED} live={false} />
        </View>
        <View style={[styles.front, { backgroundColor: c.bg, borderRadius: STACKED / 2 + 2 }]}>
          <Face who={faceOf(faces[1])} size={STACKED} live={false} />
        </View>
      </View>
    );
  const a11y = [title, sub, time, unread ? t("mobile.activity.unread") : null].filter(Boolean).join(", ");
  return (
    <View>
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
      <Animated.View style={{ transform: [{ translateX: x }], backgroundColor: c.bg }} {...responder.panHandlers}>
        <ListRow
          onPress={open}
          accessibilityRole="button"
          accessibilityLabel={a11y}
          accessibilityActions={[
            { name: "read", label: unread ? t("mobile.activity.markRead") : t("mobile.activity.markUnread") },
            { name: "done", label: t("mobile.activity.done") },
          ]}
          onAccessibilityAction={(e) => (e.nativeEvent.actionName === "read" ? toggleRead() : done())}
          dot={unread}
          leading={leading}
          title={
            <Text variant="body" tone={unread ? "ink" : "ink2"} numberOfLines={2}>
              {parts.map((part, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one fixed sentence
                <Fragment key={i}>
                  {i > 0 ? (
                    <Text variant="body" tone="ink" style={styles.bold}>
                      {names}
                    </Text>
                  ) : null}
                  {part}
                </Fragment>
              ))}
            </Text>
          }
          time={time}
          sub={sub || null}
        />
      </Animated.View>
      {divider ? <View style={[styles.divider, { backgroundColor: c.line2 }]} /> : null}
    </View>
  );
});

/** Two faces share the avatar box (grouped items: reactions, replies). */
const STACKED = 36;
const faceOf = (a: AppNotification["actors"][number] | undefined) =>
  a ? { type: a.type === "agent" ? "agent" : "person", id: a.id } : null;

const styles = StyleSheet.create({
  list: { marginTop: 4 },
  stack: { width: LIST_AVATAR, height: LIST_AVATAR },
  back: { position: "absolute", top: 0, left: 0 },
  front: { position: "absolute", right: -2, bottom: -2, padding: 2 },
  bold: { fontWeight: "600" },
  divider: { position: "absolute", top: 0, left: LIST_INSET, right: 0, height: StyleSheet.hairlineWidth },
  under: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18 },
  side: { flexDirection: "row", alignItems: "center", gap: 6 },
  more: { alignItems: "center", paddingVertical: 16 },
});
