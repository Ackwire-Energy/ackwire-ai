import {
  type AppNotification,
  type Routine,
  useAiStatus,
  useNotificationAction,
  useNotifications,
  useRoutines,
} from "@agenteschat/client";
import { approvalTitle } from "@agenteschat/client/lib/approval-words";
import { restrictionLine } from "@agenteschat/client/lib/errors";
import { timeLeft } from "@agenteschat/client/lib/format";
import { mediaWord } from "@agenteschat/client/lib/media";
import { usageLimitLine } from "@agenteschat/client/lib/person-usage";
import { router, useLocalSearchParams } from "expo-router";
import { Fragment, memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { serverUrl } from "@/lib/server";
import {
  Button,
  Filters,
  Fuse,
  Icon,
  LargeTitleScreen,
  LIST_AVATAR,
  LIST_INSET,
  ListRow,
  PersonAvatar,
  SectionHeader,
  Sky,
  SwipeRow,
  Text,
  weights,
} from "@/ui";
import { openPage } from "../ai/parts";
import { ApprovalWhy } from "../approvals/parts";
import { dashboardWaitingCard } from "../dashboards/logic";
import { notificationHref, notificationWebPath, routineHref } from "../links/logic";
import { ChangeRequestCard } from "../right-hand/SettingsCard";
import { AgentFace, Face } from "../shared/Face";
import { useColors, useDirectory, useNow, useOrgId, usePullRefresh, useWhen } from "../shared/hooks";
import { agentLook, fuseRemaining } from "../shared/logic";
import { Tile, useSurface } from "../shared/parts";
import { useWaitingApprovals } from "../shared/queries";
import { useTabHeader } from "../shared/tabHeader";
import { UsageLimitActions } from "../usage/people";
import {
  type ActivityFilter,
  activitySections,
  type DayGroup,
  emojisOf,
  joinRequestLine,
  nextRoutine,
  placeOf,
  type SayWords,
  subtitleOf,
  upcomingDay,
  waitingCardOf,
} from "./logic";
import { useNoticeTitle } from "./noticeTitle";

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
  const list = useNotifications(orgId, filter);
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
          { key: "done", label: t("mobile.activity.filter.done") },
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
      ) : list.isLoading ? null : filter !== "done" ? (
        <AllClear />
      ) : days.length === 0 ? (
        <Text variant="body" tone="muted" style={styles.noneDone}>
          {t("mobile.activity.noneDone")}
        </Text>
      ) : null}
      {days.map(([group, groupItems]) => (
        <View key={group}>
          <SectionHeader title={t(`mobile.activity.day.${group satisfies DayGroup}`)} />
          {/* Loose rows on the page, as Conversas' (no card around them). */}
          {groupItems.map((n, i) => (
            <ActivityRow key={n.id} item={n} divider={i > 0} />
          ))}
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
  // A widget's alert, or an agent asking to publish a dashboard (ADR 0135): its own word, line and "Open".
  const dash = dashboardWaitingCard(n, t as unknown as (key: string, values?: Record<string, unknown>) => string);
  // A request's title in words, from the request itself (the notification keeps the tool's raw title).
  const waitingApprovals = useWaitingApprovals();
  const request = waitingApprovals.find((a) => a.id === n.source.approvalId);
  // One notification per approval card: how many on it still wait for you.
  const onCard = request?.messageId ? waitingApprovals.filter((a) => a.messageId === request.messageId).length : 0;
  // Someone asking to join: who asked (the first names, how many in all), with their faces.
  const join = card.kind === "join" ? joinRequestLine(t, n) : null;
  const notice = useNoticeTitle(n);
  const title =
    card.kind === "approval" && request
      ? [approvalTitle(t, request), onCard > 1 ? t("approval.all.waitingCount", { count: onCard }) : null]
          .filter(Boolean)
          .join(" · ")
      : join
        ? join.text
        : card.kind === "limit"
          ? notice.title
          : // The server's name in words, as the web says it; the tools themselves are in its review.
            card.kind === "tools"
            ? t("connectors.toolChanges.notice", { name: n.source.label ?? "" })
            : (dash?.title ?? card.title);
  // A routine's trouble opens the routine; the computer being ready, Connect an AI while no agent has one.
  const ai = useAiStatus(orgId, n.kind === "computer_ready").data;
  const href = notificationHref(n, ai);
  // No screen of its own in the app (a forum topic): its page on the web, so a tap is never a dead end.
  const web = href ? null : notificationWebPath(n, orgId);
  const actor = n.actors[0];
  const who = actor ? { type: actor.type === "agent" ? "agent" : "person", id: actor.id } : null;
  const name = dir.nameOf(who);
  const kind = dash ? dash.kind : t(`mobile.activityNow.kind.${card.kind}`);
  const left = card.expiresAt ? timeLeft(t, card.expiresAt, new Date(now)) : null;
  // The server is already named in the title.
  const place = card.kind === "tools" ? null : placeOf(n);
  const where = [place ? t("mobile.chats.waitIn", { where: place }) : null, when.short(n.updatedAt)]
    .filter(Boolean)
    .join(" · ");
  const button = dash ? t("mobile.activityNow.open") : t(`mobile.activityNow.${card.action}`);
  const open = () => {
    if (n.readAt === null) act.mutate({ type: "read", item: n, read: true });
    if (href) router.push(href);
    else if (web) openPage(`${serverUrl()}${web}`);
  };
  return (
    <Pressable
      onPress={href || web ? open : undefined}
      disabled={!href && !web}
      style={({ pressed }) => [styles.wcard, surface, pressed && styles.wpressed]}
      accessibilityRole={href || web ? "button" : undefined}
      accessibilityLabel={[name, kind, title].filter(Boolean).join(", ")}
    >
      <View style={styles.hd}>
        {who ? <Face who={who} size={22} live={false} /> : null}
        {join ? (
          <View style={styles.faces}>
            {join.faces.map((face, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: two names at most, and two people can share one
              <View key={`${i}-${face}`} style={i > 0 ? styles.overlap : undefined}>
                <PersonAvatar name={face} size={22} />
              </View>
            ))}
          </View>
        ) : null}
        {name ? (
          <Text variant="footnote" tone="ink" numberOfLines={1} style={[styles.semibold, styles.shrink]}>
            {name}
          </Text>
        ) : null}
        <View style={styles.grow} />
        <View style={styles.kind}>
          <Icon name={dash ? "chart" : KIND_ICON[card.kind]} size={13} color={c.amber} />
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
      {card.kind === "limit" ? (
        <>
          <Text variant="footnote" tone="muted">
            {usageLimitLine(t, n)}
          </Text>
          <UsageLimitActions n={n} />
        </>
      ) : null}
      <View style={styles.ft}>
        {left !== null && card.expiresAt ? (
          <>
            <Fuse color="amber" remaining={fuseRemaining(n.createdAt, card.expiresAt, now)} style={styles.fuse} />
            <Text variant="caption" numberOfLines={1} style={[styles.when, { color: c.amber }]}>
              {t("approval.expiresDetail", { time: left })}
            </Text>
          </>
        ) : (
          <Text variant="caption" tone="faint" numberOfLines={1} style={[styles.when, styles.shrink]}>
            {where}
          </Text>
        )}
        <View style={styles.grow} />
        {(href || web) && card.kind !== "limit" ? (
          <Button variant="primary" size="sm" label={button} onPress={open} />
        ) : null}
      </View>
    </Pressable>
  );
}

const KIND_ICON = {
  approval: "wait",
  question: "help",
  forum: "chat",
  browser: "globe",
  secret: "lock",
  join: "members",
  tools: "bolt",
  limit: "chart",
} as const;

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
        // The routine opens on a tap (Rotinas).
        <Pressable
          onPress={() => router.push(routineHref(next.id))}
          accessibilityRole="button"
          style={({ pressed }) => [styles.next, { backgroundColor: c.sunken }, pressed && styles.wpressed]}
        >
          {nextAgent ? <AgentFace agentId={nextAgent.id} size={26} live={false} /> : <Tile icon="clock" size={26} />}
          <View style={styles.grow}>
            <Text variant="small" tone="ink2" numberOfLines={1}>
              {t("mobile.activityNow.next.title", { name: next.name })}
            </Text>
            <NextWhen routine={next} agent={nextAgent?.name ?? ""} />
          </View>
        </Pressable>
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

/**
 * One item, in Conversas' row: the faces, who did what (the names bold)
 * and when, the snippet and where; a red dot on the right while unread. Swipe right to mark read or unread,
 * left for "Feito"; tapping opens where it happened.
 */
const ActivityRow = memo(function ActivityRow({ item: n, divider }: { item: AppNotification; divider: boolean }) {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const c = useColors();
  const when = useWhen();
  const act = useNotificationAction(orgId);
  // A routine's trouble opens the routine; the computer being ready, Connect an AI while no agent has one.
  const ai = useAiStatus(orgId, n.kind === "computer_ready").data;
  const href = notificationHref(n, ai);
  // No screen of its own in the app (a forum topic): its page on the web, so a tap is never a dead end.
  const web = href ? null : notificationWebPath(n, orgId);
  const unread = n.readAt === null;

  // Who did what, as the island says it too; a restriction or several agents' failures go under it.
  const { parts, names, title, restriction, failed } = useNoticeTitle(n);
  // Coded words in the person's language: why a routine paused or failed, who asked for an approval.
  const say: SayWords = (w, otherwise = "") => {
    const tt = t as unknown as (key: string, options?: Record<string, unknown>) => string;
    return tt(w.key, { ...w.values, defaultValue: w.fallback ? tt(w.fallback) : otherwise });
  };
  // A GIF or a sticker with no words says which (ADR 0091).
  const line = subtitleOf(n, say, (kind) => mediaWord(t, kind));
  const sub = restriction
    ? restrictionLine(t, restriction.code, restriction.facts)
    : n.kind === "usage_limit"
      ? usageLimitLine(t, n)
      : failed
        ? failed.sub
        : [emojisOf(n).join(" "), [line, placeOf(n)].filter(Boolean).join(" · ")].filter(Boolean).join(" ");
  const time = when.short(n.updatedAt);

  // The swipe taps on its own (SwipeRow); VoiceOver's actions call these too.
  const toggleRead = () => act.mutate({ type: "read", item: n, read: unread });
  // In "Concluídas" the same swipe moves it back to the inbox.
  const isDone = Boolean(n.doneAt);
  const done = () => act.mutate({ type: "done", item: n, done: !isDone });
  const doneLabel = isDone ? t("mobile.activity.restore") : t("mobile.activity.done");
  const open = () => {
    if (unread) act.mutate({ type: "read", item: n, read: true });
    if (href) router.push(href);
    else if (web) openPage(`${serverUrl()}${web}`);
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
        <View style={[styles.front, { backgroundColor: c.bg, borderRadius: STACKED * 0.3 + 2 }]}>
          <Face who={faceOf(faces[1])} size={STACKED} live={false} />
        </View>
      </View>
    );
  const a11y = [title, sub, time, unread ? t("mobile.activity.unread") : null].filter(Boolean).join(", ");
  return (
    <View>
      <SwipeRow
        left={{
          label: unread ? t("mobile.activity.markRead") : t("mobile.activity.markUnread"),
          icon: unread ? "check" : "bell",
          color: c.agent,
          ink: c.onAgent,
          onAction: toggleRead,
        }}
        // On the green, the page's color reads in both themes (white in light, near black on dark's light green).
        right={{ label: doneLabel, icon: isDone ? "undo" : "archive", color: c.ok, ink: c.bg, onAction: done }}
      >
        <View style={{ backgroundColor: c.bg }}>
          <ListRow
            onPress={open}
            accessibilityRole="button"
            accessibilityLabel={a11y}
            accessibilityActions={[
              { name: "read", label: unread ? t("mobile.activity.markRead") : t("mobile.activity.markUnread") },
              { name: "done", label: doneLabel },
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
            subLines={restriction ? 0 : undefined}
          />
        </View>
      </SwipeRow>
      {/* A change someone sent with "Pedir a um admin" (ADR 0137): decided on its card, here. */}
      {n.kind === "change_request" ? (
        <View style={styles.change}>
          <ChangeRequestCard n={n} />
        </View>
      ) : null}
      {/* A person asks for more (ADR 0141): raised or refused right here. */}
      {n.kind === "usage_limit" && n.latest.statusTo === "request" && !n.doneAt ? (
        <View style={styles.change}>
          <UsageLimitActions n={n} />
        </View>
      ) : null}
      {divider ? <View style={[styles.divider, { backgroundColor: c.line2 }]} /> : null}
    </View>
  );
});

/** Two faces share the avatar box (grouped items: reactions, replies). */
const STACKED = 36;
const faceOf = (a: AppNotification["actors"][number] | undefined) =>
  a ? { type: a.type === "agent" ? "agent" : "person", id: a.id } : null;

const styles = StyleSheet.create({
  cards: { gap: 10, paddingHorizontal: 16 },
  change: { paddingHorizontal: 16, paddingBottom: 12 },
  noneDone: { paddingHorizontal: 16, paddingVertical: 24, textAlign: "center" },
  wcard: { borderRadius: 22, paddingHorizontal: 14, paddingVertical: 12, gap: 9 },
  wpressed: { opacity: 0.85 },
  hd: { flexDirection: "row", alignItems: "center", gap: 8 },
  faces: { flexDirection: "row" },
  overlap: { marginLeft: -6 },
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
  more: { alignItems: "center", paddingVertical: 16 },
});
