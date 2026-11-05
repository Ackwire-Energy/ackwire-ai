import { keys, useApi } from "@agenteschat/client";
import { voiceClock } from "@agenteschat/client/lib/voice";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { GestureDetector, useExclusiveGestures, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Glass, Icon, PressScale, Text, useToast } from "@/ui";
import { withOpacity } from "../chat/turn";
import { useColors } from "../shared/hooks";
import { CANCEL_X, HOLD_MS, LOCK_Y, secondsLeft, slideIntent } from "./logic";
import { LIVE_WAVE, useVoiceTake, type VoiceTarget } from "./useVoiceTake";
import { VoiceBars } from "./VoiceBars";

const MIC = 36;

/** What the composer draws for voice; see `Composer`'s `voice`. */
export interface ComposerVoice {
  mic: React.ReactNode;
  /** Over the field while recording: the composer keeps its size under it. */
  overlay: React.ReactNode | null;
  /** In the "+" button's place. */
  leading: React.ReactNode | null;
  active: boolean;
}

/** Whether this person may record now, known before the press so holding the button never waits on the network. */
function useVoiceAllowed(orgId: string, enabled: boolean) {
  const api = useApi();
  const { data } = useQuery({
    queryKey: [...keys.org(orgId), "voice", "allowed"],
    enabled,
    staleTime: 60_000,
    queryFn: async () => (await api.voice.allowed(orgId)).allowed,
  });
  return data ?? null;
}

/**
 * Voice in the composer, as frame 2 of the design: hold the microphone to record, slide left to delete, up to lock.
 * Locked, the field holds the clock, the wave and pause, and the button sends. Paused, the play button stands where
 * the dot was and the whole recording fits the wave. Nothing changes the composer's height. Null where voice is off.
 */
export function useVoiceComposer(input: Omit<VoiceTarget, "allowed"> & { enabled: boolean }): ComposerVoice | null {
  const { enabled, ...rest } = input;
  const { t } = useTranslation();
  const c = useColors();
  const toast = useToast();
  const allowed = useVoiceAllowed(rest.orgId, enabled);
  const take = useVoiceTake({ ...rest, allowed });
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const scale = useSharedValue(1);
  const spent = useSharedValue(false);

  const hint = () => toast({ title: t("voice.holdToRecord"), icon: "mic" });
  const back = () => {
    "worklet";
    x.value = withSpring(0, { damping: 18, stiffness: 320, mass: 1 });
    y.value = withSpring(0, { damping: 18, stiffness: 320, mass: 1 });
    scale.value = withTiming(1, { duration: 120 });
  };
  const pan = usePanGesture({
    activateAfterLongPress: HOLD_MS,
    onActivate: () => {
      "worklet";
      spent.value = false;
      scale.value = withSpring(1.45, { damping: 14, stiffness: 320, mass: 1 });
      scheduleOnRN(take.start);
    },
    onUpdate: (e) => {
      "worklet";
      if (spent.value) return;
      x.value = Math.max(CANCEL_X, Math.min(0, e.translationX));
      y.value = Math.max(LOCK_Y, Math.min(0, e.translationY));
      const intent = slideIntent(e.translationX, e.translationY);
      if (!intent) return;
      spent.value = true;
      back();
      if (intent === "cancel") scheduleOnRN(take.cancel, true);
      else scheduleOnRN(take.lock);
    },
    onDeactivate: () => {
      "worklet";
      back();
      if (!spent.value) scheduleOnRN(take.release);
      spent.value = true;
    },
  });
  const tap = useTapGesture({
    maxDuration: HOLD_MS - 20,
    onDeactivate: () => {
      "worklet";
      scheduleOnRN(hint);
    },
  });
  const press = useExclusiveGestures(pan, tap);

  const micStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }],
  }));
  const slideStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value * 0.6 }],
    opacity: 1 + x.value / 140,
  }));
  const lockStyle = useAnimatedStyle(() => ({ transform: [{ translateY: Math.max(-30, y.value * 0.4) }] }));

  const scrubStart = useSharedValue(0);
  const scrubWidth = useSharedValue(0);
  const scrub = usePanGesture({
    enabled: take.phase === "paused",
    activeOffsetX: [-2, 2],
    onBegin: (e) => {
      "worklet";
      if (scrubWidth.value > 0) scrubStart.value = Math.max(0, Math.min(0.999, e.x / scrubWidth.value));
      take.progress.value = scrubStart.value;
    },
    onUpdate: (e) => {
      "worklet";
      if (scrubWidth.value > 0) take.progress.value = Math.max(0, Math.min(0.999, e.x / scrubWidth.value));
    },
    onFinalize: () => {
      "worklet";
      scheduleOnRN(take.scrub, take.progress.value);
    },
  });

  if (!enabled) return null;
  const { phase } = take;
  const holding = phase === "hold";
  const handsFree = phase === "locked" || phase === "paused";
  const left = secondsLeft(take.seconds * 1000);

  const mic = handsFree ? (
    <PressScale
      to={0.9}
      haptic={false}
      onPress={() => void take.send()}
      accessibilityRole="button"
      accessibilityLabel={t("voice.send")}
      hitSlop={6}
      style={[styles.button, { backgroundColor: c.ink }]}
    >
      <View style={styles.center}>
        <Icon name="send" size={18} color={c.bg} />
      </View>
    </PressScale>
  ) : (
    <GestureDetector gesture={press}>
      <Animated.View
        accessible
        accessibilityRole="button"
        accessibilityLabel={t("voice.holdToRecord")}
        style={[styles.button, holding && { backgroundColor: c.danger }, micStyle]}
      >
        <View style={styles.center}>
          <Icon name="mic" size={21} color={holding ? c.bg : c.muted} />
        </View>
      </Animated.View>
    </GestureDetector>
  );

  const overlay =
    phase === "idle" ? null : (
      <View style={[styles.overlay, { backgroundColor: c.raised }]}>
        {holding ? (
          <Animated.View style={[styles.lock, lockStyle]} pointerEvents="none">
            <Glass style={styles.lockGlass} intensity={50}>
              <Icon name="lock" size={16} color={c.muted} />
            </Glass>
          </Animated.View>
        ) : null}
        {phase === "paused" ? (
          <PressScale
            to={0.92}
            onPress={() => void take.listen()}
            accessibilityRole="button"
            accessibilityLabel={take.listening ? t("voice.stop") : t("voice.listen")}
            hitSlop={8}
            style={[styles.play, { backgroundColor: c.ink }]}
          >
            <View style={styles.center}>
              <Icon name={take.listening ? "pause" : "play"} size={14} color={c.bg} />
            </View>
          </PressScale>
        ) : (
          <View style={[styles.dot, { backgroundColor: c.danger }]} />
        )}
        <Text variant="body" style={[styles.time, left !== null && { color: c.danger }]}>
          {left !== null && phase !== "paused" ? t("voice.left", { seconds: left }) : voiceClock(take.seconds * 1000)}
        </Text>
        {holding ? (
          <Animated.View style={[styles.slide, slideStyle]}>
            <View style={styles.chev}>
              <Icon name="chev" size={14} color={c.faint} />
            </View>
            <Text variant="small" tone="faint" numberOfLines={1}>
              {t("voice.slideToDelete")}
            </Text>
          </Animated.View>
        ) : (
          <>
            <GestureDetector gesture={scrub}>
              <View
                style={styles.wave}
                onLayout={(e) => {
                  scrubWidth.value = e.nativeEvent.layout.width;
                }}
              >
                <VoiceBars
                  path={take.path}
                  progress={take.progress}
                  on={c.ink}
                  off={c.faint}
                  onWidth={take.setWidth}
                  height={LIVE_WAVE}
                  handle={phase === "paused"}
                />
              </View>
            </GestureDetector>
            <PressScale
              to={0.9}
              onPress={() => void (phase === "paused" ? take.resume() : take.pause())}
              accessibilityRole="button"
              accessibilityLabel={phase === "paused" ? t("voice.resume") : t("voice.pause")}
              hitSlop={8}
              style={[styles.pause, { backgroundColor: c.sunken }]}
            >
              <View style={styles.center}>
                <Icon name={phase === "paused" ? "mic" : "pause"} size={16} color={c.ink2} />
              </View>
            </PressScale>
          </>
        )}
      </View>
    );

  const leading = handsFree ? (
    <PressScale
      to={0.9}
      onPress={() => void take.cancel(true)}
      accessibilityRole="button"
      accessibilityLabel={t("voice.delete")}
      style={[styles.trash, { backgroundColor: withOpacity(c.danger, 0.12) }]}
    >
      <View style={styles.center}>
        <Icon name="trash" size={20} color={c.danger} />
      </View>
    </PressScale>
  ) : null;

  return { mic, overlay, leading, active: phase !== "idle" };
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  button: { width: MIC, height: MIC, borderRadius: MIC / 2 },
  overlay: {
    ...StyleSheet.absoluteFill,
    borderRadius: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 12,
    // Leaves the send button its place.
    paddingRight: 6 + MIC + 8,
  },
  dot: { width: 9, height: 9, borderRadius: 5 },
  play: { width: 28, height: 28, borderRadius: 14, marginLeft: -5 },
  time: { minWidth: 36, fontVariant: ["tabular-nums"] },
  slide: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 2 },
  chev: { transform: [{ rotate: "90deg" }] },
  wave: { flex: 1, minWidth: 0, height: LIVE_WAVE, flexDirection: "row" },
  pause: { width: 30, height: 30, borderRadius: 15 },
  lock: { position: "absolute", right: 2, bottom: 56 },
  lockGlass: { width: 40, height: 56, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  trash: { width: 48, height: 48, borderRadius: 24 },
});
