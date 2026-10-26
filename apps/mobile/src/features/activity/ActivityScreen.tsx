import {
  type AppNotification,
  type Routine,
  useDms,
  useNotificationAction,
  useNotifications,
  useRoutines,
} from "@agenteschat/client";
import { approvalTitle } from "@agenteschat/client/lib/approval-words";
import { router, useLocalSearchParams } from "expo-router";
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Animated, PanResponder, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import {
  Button,
  Card,
  Filters,
  Fuse,
  Icon,
  LargeTitleScreen,
  LIST_AVATAR,
  LIST_INSET,
  LineIcon,
  ListRow,
  PersonAvatar,
  SectionHeader,
  Sky,
  Text,
  weights,
} from "@/ui";
import { ApprovalWhy } from "../approvals/parts";
import { agentDmOf, notificationHref } from "../links/logic";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useNow, useOrgId, usePullRefresh, useWhen } from "../shared/hooks";
import { agentLook, fuseRemaining, minutesLeft } from "../shared/logic";
import { Tile, tapHaptic, useSurface } from "../shared/parts";
import { useWaitingApprovals } from "../shared/queries";
import { useTabHeader } from "../shared/tabHeader";
import {
  type ActivityFilter,
  activitySections,
  type DayGroup,
  emojisOf,
  nextRoutine,
  placeOf,
  type SayWords,
  subtitleOf,
  upcomingDay,
  waitingCardOf,
  whoOf,
} from "./logic";

/**
 * Atividade: on the grouped gray, what waits on you on top as cards (who asks,
 * the kind, the exact request, the deadline and one button: Revisar or Responder), or, with nothing
 * waiting, "Nada esperando você" and the next real event (a routine's next run); then the rest by day in
 * white inset cards. Swipe a row right to mark read or unread, left for "Feito". Tapping opens where it
 * happened.
 */
export function ActivityScreen() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  // `?filter=waiting`: opened from Conversas' "Esperando você" (selects Esperando; each visit with it does).
  const params = useLocalSearchParams<{ filter?: string; at?: string }>();
  const [filter, setFilter] = useState<ActivityFilter>(params.filter === "waiting" ? "waiting" : "all");
  const asked = params.filter === "waiting" ? (params.at ?? "link") : null;
  useEffect(() => {
    if (asked) setFilter("waiting");
  }, [asked]);
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
      {waiting.length > 0 ? (
        <>
          <SectionHeader title={t("mobile.home.waiting")} count={counts?.waiting ?? waiting.length} />
          <View style={styles.cards}>
            {waiting.map((n) => (
              <WaitingCardView key={n.id} item={n} />
            ))}
          </View>
        </>
      ) : !list.isLoading ? (
        <AllClear />
      ) : null}
      {days.map(([group, groupItems]) => (
        <View key={group}>
          <SectionHeader title={t(`mobile.activity.day.${group satisfies DayGroup}`)} />
          <Card style={styles.inset}>
            {groupItems.map((n, i) => (
              <ActivityRow key={n.id} item={n} divider={i > 0} />
            ))}
          </Card>
        </View>
      ))}
      {list.hasNextPage ? (
        <Pressable onPress={() => void list.fetchNextPage()} accessibilityRole="button" style={styles.more}>
          <Text variant="small" tone="muted">
            {t("mobile.activity.more")}
          </Text>
        </Pressable>
      ) : null}
    </LargeTitleScreen>
  );
}

/**
 * One thing waiting on you (`.wyA`): who asks and the kind (amber, the waiting color), the exact request in
 * words, the fuse and "expira em" (requests) or where and when, and one button: Revisar or Responder. The
 * whole card opens it too.
 */
function WaitingCardView({ item: n }: { item: AppNotification }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const dir = useDirectory();
  const when = useWhen();
  const now = useNow();
  const surface = useSurface();
  const act = useNotificationAction(orgId);
  const card = waitingCardOf(n);
  // A request's title in words, from the request itself (the notification keeps the tool's raw title).
  const request = useWaitingApprovals().find((a) => a.id === n.source.approvalId);
  const title =
    card.kind === "approval" && request
      ? approvalTitle(t, request)
      : card.kind === "join"
        ? t("notifications.wait.joinRequest", { count: n.count, name: card.title })
        : card.title;
  // A routine's trouble opens the agent's DM (the phone has no Rotinas screen yet).
  const dms = useDms(orgId);
  const href = notificationHref(n, agentDmOf(dms.data));
  const actor = n.actors[0];
  const who = actor ? { type: actor.type === "agent" ? "agent" : "person", id: actor.id } : null;
  const name = dir.nameOf(who);
  const kind = t(`mobile.activityNow.kind.${card.kind}`);
  const minutes = card.expiresAt ? minutesLeft(card.expiresAt, now) : null;
  const place = placeOf(n);
  const where = [place ? t("mobile.chats.waitIn", { where: place }) : null, when.short(n.updatedAt)]
    .filter(Boolean)
    .join(" · ");
  const button = t(`mobile.activityNow.${card.action}`);
  const open = () => {
    if (n.readAt === null) act.mutate({ type: "read", item: n, read: true });
    if (href) router.push(href);
  };
  return (
    <Pressable
      onPress={href ? open : undefined}
      disabled={!href}
      style={({ pressed }) => [styles.wcard, surface, pressed && styles.wpressed]}
      accessibilityRole={href ? "button" : undefined}
      accessibilityLabel={[name, kind, title].filter(Boolean).join(", ")}
    >
      <View style={styles.hd}>
        {who ? <Face who={who} size={22} live={false} /> : null}
        {card.kind === "join" ? <PersonAvatar name={card.title} size={22} /> : null}
        {name ? (
          <Text variant="footnote" tone="ink" numberOfLines={1} style={[styles.semibold, styles.shrink]}>
            {name}
          </Text>
        ) : null}
        <View style={styles.grow} />
        <View style={styles.kind}>
          <LineIcon name={KIND_ICON[card.kind]} size={13} color={c.amber} variant="footnote" />
          <Text variant="footnote" style={[styles.semibold, { color: c.amber }]}>
            {kind}
          </Text>
        </View>
      </View>
      {title ? (
        <Text variant="callout" tone="ink" numberOfLines={3} style={styles.semibold}>
          {title}
        </Text>
      ) : null}
      {/* Who asked while nobody watched, then why (ADR 0053 §8), as on the request itself. */}
      {card.kind === "approval" ? (
        <ApprovalWhy approval={{ origin: n.latest.origin ?? null, why: n.latest.text ?? null }} name={name} />
      ) : null}
      <View style={styles.ft}>
        {minutes !== null && card.expiresAt ? (
          <>
            <Fuse color="amber" remaining={fuseRemaining(n.createdAt, card.expiresAt, now)} style={styles.fuse} />
            <Text variant="caption" numberOfLines={1} style={[styles.when, { color: c.amber }]}>
              {t("mobile.approval.expiresIn", { count: minutes })}
            </Text>
          </>
        ) : (
          <Text variant="caption" tone="faint" numberOfLines={1} style={[styles.when, styles.shrink]}>
            {where}
          </Text>
        )}
        <View style={styles.grow} />
        {href ? <Button variant="primary" size="sm" label={button} onPress={open} /> : null}
      </View>
    </Pressable>
  );
}

const KIND_ICON = { approval: "wait", question: "help", forum: "chat", browser: "globe", join: "members" } as const;

/** Faces of the crew drawn over "Nada esperando você". */
const CREW = 3;

/**
 * Nothing waits on you (`.allok`): a bit of sky with the crew, "Nada esperando você", one calm line, and the
 * next real event when there is one (a routine's next run: who, what, when).
 */
function AllClear() {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const dir = useDirectory();
  const surface = useSurface();
  const routines = useRoutines(orgId);
  const crew = dir.agents.slice(0, CREW);
  const next = useMemo(() => nextRoutine<Routine>(routines.data ?? []), [routines.data]);
  const nextAgent = next ? dir.agentById.get(next.agentId) : undefined;
  return (
    <View style={[styles.clear, surface]}>
      <View style={styles.clearSky}>
        <Sky color={agentLook(crew[0]).color} depth={0.8} surface="raised" style={StyleSheet.absoluteFill} />
        <View style={styles.crew}>
          {crew.map((a, i) => (
            <AgentFace key={a.id} agentId={a.id} size={i === 0 ? 46 : 40} live={false} />
          ))}
        </View>
      </View>
      <Text variant="display2" accessibilityRole="header" style={styles.clearTitle}>
        {t("mobile.activityNow.clear.title")}
      </Text>
      <Text variant="small" tone="muted" style={styles.clearText}>
        {t("mobile.activityNow.clear.text")}
      </Text>
      {next ? (
        <View style={[styles.next, { backgroundColor: c.sunken }]}>
          {nextAgent ? <AgentFace agentId={nextAgent.id} size={26} live={false} /> : <Tile icon="clock" size={26} />}
          <View style={styles.grow}>
            <Text variant="small" tone="ink2" numberOfLines={1}>
              {t("mobile.activityNow.next.title", { name: next.name })}
            </Text>
            <NextWhen routine={next} agent={nextAgent?.name ?? ""} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/** "Rotina da Iris · hoje às 18:00". */
function NextWhen({ routine, agent }: { routine: Pick<Routine, "nextRunAt">; agent: string }) {
  const { t } = useTranslation();
  const when = useWhen();
  const c = useColors();
  if (!routine.nextRunAt) return null;
  const iso = routine.nextRunAt;
  const day = upcomingDay(iso);
  const time = when.time(iso);
  const date =
    day === "today"
      ? t("mobile.activityNow.next.today", { time })
      : day === "tomorrow"
        ? t("mobile.activityNow.next.tomorrow", { time })
        : t("mobile.activityNow.next.later", {
            day: new Intl.DateTimeFormat(when.locale, { weekday: "short", day: "numeric", month: "short" })
              .format(new Date(iso))
              .replace(/\./g, ""),
            time,
          });
  return (
    <View style={styles.nextWhen}>
      <Icon name="clock" size={12} color={c.faint} />
      <Text variant="caption" tone="faint" numberOfLines={1} style={styles.shrink}>
        {agent
          ? t("mobile.activityNow.next.routineOf", { agent, when: date })
          : t("mobile.activityNow.next.routine", { when: date })}
      </Text>
    </View>
  );
}

const SWIPE = 72;
/** Stands in for the names in the translated title, so they can be drawn bold. */
const NAMES = "\u2063names\u2063";

/**
 * One item, in Conversas' row: the faces, who did what (the names bold)
 * and when, the snippet and where; a red dot on the right while unread. Swipe right to mark read or unread,
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
  // A routine's trouble opens the agent's DM (the phone has no Rotinas screen yet).
  const dms = useDms(orgId);
  const href = notificationHref(n, agentDmOf(dms.data));
  const unread = n.readAt === null;

  const who = whoOf(n.actors, (a) => dir.nameOf({ type: a.type === "agent" ? "agent" : "person", id: a.id }));
  const names = who.second
    ? who.more > 0
      ? t("mobile.names.more", { first: who.first, second: who.second, count: who.more })
      : t("mobile.names.two", { first: who.first, second: who.second })
    : who.first;
  const kind = n.kind === "browser_handoff" && n.source.screen === "desktop" ? "desktop_handoff" : n.kind;
  const template = t(`mobile.activity.kind.${kind}`, { names: NAMES, count: who.total, defaultValue: NAMES });
  const parts = template.split(NAMES);
  const title = parts.join(names);
  // Coded words in the person's language: why a routine paused or failed, who asked for an approval.
  const say: SayWords = (w, otherwise = "") => {
    const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
    return tt(w.key, { ...w.values, defaultValue: w.fallback ? tt(w.fallback) : otherwise });
  };
  const sub = [emojisOf(n).join(" "), [subtitleOf(n, say), placeOf(n)].filter(Boolean).join(" · ")]
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
        <View style={[styles.front, { backgroundColor: c.raised, borderRadius: STACKED / 2 + 2 }]}>
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
      <Animated.View style={{ transform: [{ translateX: x }], backgroundColor: c.raised }} {...responder.panHandlers}>
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
  inset: { marginHorizontal: 16 },
  cards: { gap: 10, paddingHorizontal: 16 },
  wcard: { borderRadius: 22, paddingHorizontal: 14, paddingVertical: 12, gap: 9 },
  wpressed: { opacity: 0.85 },
  hd: { flexDirection: "row", alignItems: "center", gap: 8 },
  kind: { flexDirection: "row", alignItems: "center", gap: 4 },
  ft: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 36 },
  fuse: { flex: 0, width: 90 },
  when: { fontWeight: weights.medium, fontVariant: ["tabular-nums"] },
  semibold: { fontWeight: weights.semibold },
  grow: { flex: 1, minWidth: 0 },
  shrink: { flexShrink: 1 },
  clear: { marginHorizontal: 16, marginTop: 4, borderRadius: 26, overflow: "hidden", padding: 20, paddingTop: 0 },
  clearSky: { height: 108, marginHorizontal: -20, alignItems: "center", justifyContent: "flex-end", paddingBottom: 10 },
  crew: { flexDirection: "row", alignItems: "flex-end", gap: 16 },
  clearTitle: { textAlign: "center" },
  clearText: { textAlign: "center", marginTop: 6 },
  next: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginTop: 14,
    padding: 10,
    paddingHorizontal: 12,
    borderRadius: 16,
  },
  nextWhen: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 1 },
  stack: { width: LIST_AVATAR, height: LIST_AVATAR },
  back: { position: "absolute", top: 0, left: 0 },
  front: { position: "absolute", right: -2, bottom: -2, padding: 2 },
  bold: { fontWeight: "600" },
  divider: { position: "absolute", top: 0, left: LIST_INSET, right: 0, height: StyleSheet.hairlineWidth },
  under: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18 },
  side: { flexDirection: "row", alignItems: "center", gap: 6 },
  more: { alignItems: "center", paddingVertical: 16 },
});
