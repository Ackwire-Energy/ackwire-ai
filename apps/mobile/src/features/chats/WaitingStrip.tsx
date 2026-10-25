import { useMissionList, useNotifications } from "@agenteschat/client";
import { approvalTitle } from "@agenteschat/client/lib/approval-words";
import { mixHex } from "@agenteschat/ui/agent/engine";
import { router } from "expo-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text as RNText, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import {
  Button,
  CHROME_MAX_SCALE,
  Chip,
  Count,
  Fuse,
  Icon,
  PressScale,
  systemText,
  Text,
  useTheme,
  weights,
} from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useNow, useOrgId } from "../shared/hooks";
import { fuseRemaining } from "../shared/logic";
import { useSurface } from "../shared/parts";
import { useWaitingApprovals } from "../shared/queries";
import { missionsWaiting, openQuestions } from "./logic";
import {
  stackLayers,
  WAITING_ICON,
  type WaitingItem,
  waitingChipKey,
  waitingItems,
  waitingMinutes,
  waitingStack,
  waitingVerbKey,
} from "./waiting";

/**
 * Everything waiting on you, in the strip's order (requests, missions, questions). A request's title is in
 * words ("Salvar um rascunho de resposta para…", "Ver stack trace do evento"), never the tool's raw name.
 */
export function useWaitingItems(): { items: WaitingItem[]; refetch: () => Promise<unknown> } {
  const { t } = useTranslation();
  const orgId = useOrgId();
  const approvals = useWaitingApprovals();
  const missions = useMissionList(orgId, { status: "waiting_you" });
  const inbox = useNotifications(orgId, "waiting");
  const items = useMemo(
    () =>
      waitingItems({
        approvals: approvals.map((a) => ({ ...a, title: approvalTitle(t, a) })),
        missions: missionsWaiting(missions.data?.missions ?? []),
        questions: openQuestions(inbox.data?.pages.flatMap((p) => p.items) ?? []),
      }),
    [approvals, missions.data, inbox.data, t],
  );
  return { items, refetch: () => Promise.allSettled([missions.refetch(), inbox.refetch()]) };
}

/** Opens Atividade on Esperando (each visit with it selects the filter again). */
const openWaitingActivity = () =>
  router.navigate({ pathname: "/activity", params: { filter: "waiting", at: String(Date.now()) } });

/**
 * "Esperando você" on top of Conversas and Threads. Closed: a dark ink strip, full
 * width, like a live activity: the first item's agent (moving), "Theo precisa do seu ok · expira em 46 min" and
 * the count, with two copies of the strip peeking out under it while more wait. Tapped, it springs
 * open into the card: who asks and the kind, the title, the fuse, Revisar, and "e mais N esperando você"
 * (Atividade on Esperando). Tapping the card opens the request, like Revisar; scrolling the list (`open` is the
 * screen's) closes it.
 * Nothing waiting: nothing.
 */
export function WaitingStrip({
  items,
  open,
  onOpenChange,
}: {
  items: WaitingItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { motion, reducedMotion } = useTheme();
  const stack = waitingStack(items);
  // The box follows its content's height with a spring, so the list under it moves with it.
  const height = useSharedValue(-1);
  const box = useAnimatedStyle(() => (height.value < 0 ? {} : { height: height.value }));
  if (!stack.first) return null;
  const first = stack.first;
  const fade = reducedMotion ? undefined : { entering: FadeIn.duration(180), exiting: FadeOut.duration(120) };
  return (
    <Animated.View style={[styles.box, box]}>
      <View
        style={styles.measure}
        onLayout={(e) => {
          const h = e.nativeEvent.layout.height;
          height.value = height.value < 0 || reducedMotion ? h : withSpring(h, motion.sheet);
        }}
      >
        {open ? (
          <Animated.View key="card" {...fade}>
            <WaitingCard item={first} rest={stack.rest} faces={stack.faces} stacked={stack.stacked} />
          </Animated.View>
        ) : (
          <Animated.View key="pill" {...fade}>
            <WaitingPill item={first} count={stack.count} stacked={stack.stacked} onPress={() => onOpenChange(true)} />
          </Animated.View>
        )}
      </View>
    </Animated.View>
  );
}

/** "Theo precisa do seu ok" (or the item's title when the agent is unknown). */
function useLine(item: WaitingItem) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const name = item.agentId ? (dir.agentById.get(item.agentId)?.name ?? "") : "";
  const verb = t(waitingVerbKey(item.kind));
  return { name, verb, line: name ? t("mobile.chats.wait.line", { name, verb }) : t("mobile.home.waiting") };
}

function WaitingPill({
  item,
  count,
  stacked,
  onPress,
}: {
  item: WaitingItem;
  count: number;
  stacked: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const now = useNow();
  const { line } = useLine(item);
  const minutes = waitingMinutes(item, now);
  const expires = minutes !== null ? t("mobile.approval.expiresIn", { count: minutes }) : null;
  const layers = stackLayers(c.ink, c.bg);
  return (
    <View style={stacked ? styles.stackRoom : undefined}>
      {stacked
        ? [...layers]
            .reverse()
            .map((l) => (
              <View
                key={l.translateY}
                style={[
                  styles.layer,
                  { backgroundColor: l.color, transform: [{ translateY: l.translateY }, { scaleX: l.scaleX }] },
                ]}
              />
            ))
        : null}
      <PressScale
        onPress={onPress}
        to={0.98}
        accessibilityRole="button"
        accessibilityLabel={[line, expires, t("mobile.tabs.withCount", { label: t("mobile.home.waiting"), count })]
          .filter(Boolean)
          .join(", ")}
        accessibilityHint={t("mobile.chats.wait.open")}
        accessibilityState={{ expanded: false }}
        style={[styles.pill, { backgroundColor: c.ink }]}
      >
        <View style={styles.pillRow}>
          <AgentFace agentId={item.agentId} size={26} />
          <RNText numberOfLines={1} maxFontSizeMultiplier={CHROME_MAX_SCALE} style={[styles.pillText, { color: c.bg }]}>
            <RNText style={styles.semibold}>{line}</RNText>
            {expires ? <RNText style={styles.dim}>{` · ${expires}`}</RNText> : null}
          </RNText>
          <View style={[styles.n, { backgroundColor: mixOnInk(c.ink, c.bg) }]}>
            <Count value={count} size={14} max={99} color={c.bg} />
          </View>
        </View>
      </PressScale>
    </View>
  );
}

/** The count's chip on the strip: the background at 18% over ink. */
const mixOnInk = (ink: string, bg: string) => mixHex(ink, bg, 0.18);

function WaitingCard({
  item,
  rest,
  faces,
  stacked,
}: {
  item: WaitingItem;
  rest: number;
  faces: string[];
  stacked: boolean;
}) {
  const { t } = useTranslation();
  const c = useColors();
  const surface = useSurface();
  const now = useNow();
  const { name, verb, line } = useLine(item);
  const minutes = waitingMinutes(item, now);
  const review = () => {
    if (item.href) router.push(item.href);
    else openWaitingActivity();
  };
  return (
    <View style={stacked ? styles.stackRoom : undefined}>
      {stacked ? (
        <>
          <View style={[styles.back, styles.back2, surface, { opacity: 0.7 }]} />
          <View style={[styles.back, styles.back1, surface, { opacity: 0.9 }]} />
        </>
      ) : null}
      <View style={[styles.card, surface]}>
        <Pressable
          onPress={review}
          accessibilityRole="button"
          accessibilityLabel={line}
          style={({ pressed }) => [styles.cardTap, pressed && styles.pressed]}
        >
          <View style={styles.hd}>
            <AgentFace agentId={item.agentId} size={22} />
            {name ? (
              <Text variant="small" tone="ink" style={[styles.semibold, styles.shrink]} numberOfLines={1}>
                {name}
              </Text>
            ) : null}
            <Text variant="small" tone="muted" numberOfLines={1} style={styles.shrink}>
              {name ? verb : t("mobile.home.waiting")}
            </Text>
            <View style={styles.grow} />
            <Chip icon={WAITING_ICON[item.kind]} label={t(waitingChipKey(item.kind))} />
          </View>
          {item.title ? (
            <Text variant="callout" tone="ink" numberOfLines={2} style={styles.title}>
              {item.title}
            </Text>
          ) : null}
        </Pressable>
        <View style={styles.ft}>
          {minutes !== null && item.expiresAt && item.createdAt ? (
            <>
              <Fuse color="amber" remaining={fuseRemaining(item.createdAt, item.expiresAt, now)} />
              <Text variant="caption" numberOfLines={1} style={[styles.expiry, { color: c.amber }]}>
                {t("mobile.approval.expiresIn", { count: minutes })}
              </Text>
            </>
          ) : (
            <View style={styles.grow} />
          )}
          <Button variant="primary" size="sm" label={t("mobile.chats.wait.review")} onPress={review} />
        </View>
        {rest > 0 ? (
          <Pressable
            onPress={openWaitingActivity}
            accessibilityRole="button"
            style={({ pressed }) => [styles.more, { borderTopColor: c.line2 }, pressed && styles.pressed]}
          >
            {faces.length > 0 ? (
              <View style={styles.faces}>
                {faces.map((id, i) => (
                  <View key={id} style={i > 0 ? styles.overlap : undefined}>
                    <AgentFace agentId={id} size={18} live={false} />
                  </View>
                ))}
              </View>
            ) : null}
            <Text variant="small" tone="muted" numberOfLines={1} style={styles.shrink}>
              {t("mobile.chats.wait.more", { count: rest })}
            </Text>
            <View style={styles.grow} />
            <Icon name="right" size={15} color={c.faint} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/** Room under the strip or the card for the copies stacked behind. */
const STACK_ROOM = 14;

const styles = StyleSheet.create({
  // Full width with the list's 16pt sides inside, so the clip leaves room for the shadows.
  box: { overflow: "hidden" },
  measure: { position: "absolute", top: 0, left: 0, right: 0, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 8 },
  stackRoom: { paddingBottom: STACK_ROOM },
  layer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: STACK_ROOM,
    borderRadius: 999,
    boxShadow: "0px 1px 2px 0px rgba(0, 0, 0, 0.08)",
  },
  pill: {
    borderRadius: 999,
    boxShadow: "inset 0px 1px 0px 0px rgba(255, 255, 255, 0.08), 0px 4px 12px -6px rgba(0, 0, 0, 0.35)",
  },
  pillRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 10 },
  pillText: { flex: 1, minWidth: 0, ...systemText("subhead") },
  semibold: { fontWeight: weights.semibold },
  dim: { opacity: 0.7 },
  n: {
    minWidth: 26,
    height: 26,
    paddingHorizontal: 8,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  back: { position: "absolute", height: 30, borderRadius: 18 },
  back1: { bottom: 6, left: 8, right: 8 },
  back2: { bottom: 0, left: 18, right: 18 },
  card: { borderRadius: 22, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 12, gap: 9 },
  cardTap: { gap: 9 },
  hd: { flexDirection: "row", alignItems: "center", gap: 8 },
  title: { fontWeight: weights.semibold },
  expiry: { fontWeight: weights.medium, fontVariant: ["tabular-nums"] },
  ft: { flexDirection: "row", alignItems: "center", gap: 10 },
  more: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  faces: { flexDirection: "row" },
  overlap: { marginLeft: -6 },
  pressed: { opacity: 0.6 },
  grow: { flex: 1 },
  shrink: { flexShrink: 1 },
});
