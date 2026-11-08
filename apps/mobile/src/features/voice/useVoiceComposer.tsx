import { keys, useApi } from "@agenteschat/client";
import { voiceClock } from "@agenteschat/client/lib/voice";
import { gradientOf, mixHex } from "@agenteschat/ui/agent/engine";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { StyleSheet, View } from "react-native";
import { GestureDetector, useExclusiveGestures, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type WithSpringConfig,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Button, Glass, haptics, Icon, PressScale, Text, useTheme, useToast } from "@/ui";
import { withOpacity } from "../chat/turn";
import { Face } from "../shared/Face";
import { useColors, useDirectory } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { CANCEL_X, HOLD_MS, LOCK_Y, secondsLeft, slideIntent } from "./logic";
import { LIVE_WAVE, useVoiceTake, type VoiceTarget } from "./useVoiceTake";
import { PixelWave } from "./VoiceBars";

const MIC = 36;
/** The microphone under the finger grows to 44 (the ruler's next size up), in ink. */
const HELD = 44 / MIC;
/** The "+" the trash takes the place of. */
const LEAD = 48;
/** How far past the cancel and lock lines the finger still moves the button, less and less. */
const OVERSHOOT = 80;
/** A flick toward a line, from past half way, counts as crossing it (points per second). */
const FLICK = 900;

/** What the composer draws for voice; see `Composer`'s `voice`. */
export interface ComposerVoice {
  /** In the field's button slot: the microphone (hold to record), the send button (hands free), or nothing (paused). */
  mic: React.ReactNode | null;
  /** Over the field while recording: the composer keeps its size under it. */
  overlay: React.ReactNode | null;
  /** In the "+" button's place. */
  leading: React.ReactNode | null;
  /** Above the field: the slide-to-cancel hint, or the recording line once hands free. */
  above: React.ReactNode | null;
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

/** The finger past a line moves the button less the farther it goes (Apple's rubber band). */
function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  "worklet";
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** The microphone's offset for a finger at `t` along an axis whose line is at `limit` (negative: left or up). */
function follow(t: number, limit: number): number {
  "worklet";
  if (t > 0) return rubberband(t, OVERSHOOT);
  if (t >= limit) return t;
  return limit + rubberband(t - limit, OVERSHOOT);
}

/**
 * Voice in the composer: hold the microphone to record, slide left to cancel, up to record hands free; the field
 * itself is the recording (the clock, the wave growing from the right in the agent's tones, the face listening).
 * Hands free, the line above says "Gravando · 0:12", the trash takes the "+"'s place and the field holds the wave,
 * Pausar and send. Paused, the recording can be heard before it goes: play, the wave with its handle, "0:05 / 0:12"
 * and Enviar, with Apagar where the "+" was. Nothing changes the composer's height. Null where voice is off.
 *
 * The finger is followed 1:1 while held; past a line the button rubber-bands; on release it springs back at the
 * finger's own speed. Everything that moves per frame lives on the UI thread; React hears only of the phases.
 */
export function useVoiceComposer(
  input: Omit<VoiceTarget, "allowed"> & {
    enabled: boolean;
    /** The agent this conversation is with, if one: its face listens in the field and its tones color the wave. */
    agentId?: string | null;
  },
): ComposerVoice | null {
  const { enabled, agentId = null, ...rest } = input;
  const { t } = useTranslation();
  const c = useColors();
  const { scheme, reducedMotion } = useTheme();
  const toast = useToast();
  const dir = useDirectory();
  const allowed = useVoiceAllowed(rest.orgId, enabled);
  const take = useVoiceTake({ ...rest, allowed });
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const scale = useSharedValue(1);
  const spent = useSharedValue(false);

  const agent = agentId ? dir.agentById.get(agentId) : undefined;
  // The agent's sky, deep inside and light at the ends; in the dark the light tone and a paler one. Ink without one.
  const tones: readonly [string, string] = (() => {
    if (!agent) return [c.ink, c.ink];
    const [light, deep] = gradientOf(agentLook(agent).color);
    return scheme === "dark" ? [light, mixHex(light, "#ffffff", 0.4)] : [deep, light];
  })();

  const hint = () => toast({ title: t("voice.holdToRecord"), icon: "mic" });
  const lockNow = () => {
    haptics.medium();
    take.lock();
  };
  const settle = (vx: number, vy: number) => {
    "worklet";
    if (reducedMotion) {
      x.value = withTiming(0, { duration: 150 });
      y.value = withTiming(0, { duration: 150 });
      scale.value = withTiming(1, { duration: 150 });
      return;
    }
    const spring = (velocity: number): WithSpringConfig => ({ duration: 300, dampingRatio: 0.9, velocity });
    x.value = withSpring(0, spring(vx));
    y.value = withSpring(0, spring(vy));
    scale.value = withSpring(1, { duration: 250, dampingRatio: 1 });
  };
  const pan = usePanGesture({
    activateAfterLongPress: HOLD_MS,
    onActivate: () => {
      "worklet";
      spent.value = false;
      scale.value = reducedMotion ? HELD : withSpring(HELD, { duration: 250, dampingRatio: 0.7 });
      scheduleOnRN(take.start);
    },
    onUpdate: (e) => {
      "worklet";
      if (spent.value) return;
      x.value = follow(e.translationX, CANCEL_X);
      y.value = follow(e.translationY, LOCK_Y);
      const intent = slideIntent(e.translationX, e.translationY);
      if (!intent) return;
      // Once, on the frame the line is crossed: the haptic lands with the change it announces.
      spent.value = true;
      settle(e.velocityX, e.velocityY);
      if (intent === "cancel") scheduleOnRN(take.cancel, true);
      else scheduleOnRN(lockNow);
    },
    onDeactivate: (e) => {
      "worklet";
      settle(e.velocityX, e.velocityY);
      if (spent.value) return;
      spent.value = true;
      // A flick toward a line from past half way is the same intent as reaching it.
      if (e.velocityY < -FLICK && e.translationY < LOCK_Y / 2) scheduleOnRN(lockNow);
      else if (e.velocityX < -FLICK && e.translationX < CANCEL_X / 2) scheduleOnRN(take.cancel, true);
      else scheduleOnRN(take.release);
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
  // The hint goes with the finger and fades as it nears the line; the capsule rises a little toward it.
  const hintStyle = useAnimatedStyle(() => ({
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
  const locked = phase === "locked";
  const paused = phase === "paused";
  const left = secondsLeft(take.seconds * 1000);
  const clock = left !== null && !paused ? t("voice.left", { seconds: left }) : voiceClock(take.seconds * 1000);

  const mic = locked ? (
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
  ) : paused ? null : (
    <GestureDetector gesture={press}>
      <Animated.View
        accessible
        accessibilityRole="button"
        accessibilityLabel={t("voice.holdToRecord")}
        style={[styles.button, holding && { backgroundColor: c.ink }, micStyle]}
      >
        <View style={styles.center}>
          <Icon name="mic" size={20} color={holding ? c.bg : c.muted} />
        </View>
      </Animated.View>
    </GestureDetector>
  );

  const wave = (handle: boolean) => (
    <PixelWave
      inner={take.inner}
      edge={take.edge}
      progress={take.progress}
      tones={tones}
      off={c.line2}
      onWidth={take.setWidth}
      height={LIVE_WAVE}
      handle={handle}
      {...(handle ? {} : { fade: c.raised })}
    />
  );

  const overlay =
    phase === "idle" ? null : (
      <View style={[styles.overlay, paused ? styles.overlayPaused : styles.overlayLive, { backgroundColor: c.raised }]}>
        {holding ? (
          <Animated.View style={[styles.lock, lockStyle]} pointerEvents="none">
            <Glass style={styles.capsule} intensity={50}>
              <Icon name="lock" size={14} color={c.muted} />
              <Text variant="footnote" tone="muted" numberOfLines={1}>
                {t("mobile.voice.slideUpToLock")}
              </Text>
            </Glass>
          </Animated.View>
        ) : null}
        {holding && agent ? (
          <View style={styles.face} pointerEvents="none">
            <Face who={{ type: "agent", id: agent.id }} size={22} framed={false} mode="run" />
          </View>
        ) : null}
        {paused ? (
          <PressScale
            to={0.92}
            onPress={() => void take.listen()}
            accessibilityRole="button"
            accessibilityLabel={take.listening ? t("voice.stop") : t("voice.listen")}
            hitSlop={8}
            style={[styles.play, { backgroundColor: c.ink }]}
          >
            <View style={styles.center}>
              <Icon name={take.listening ? "pause" : "play"} size={16} color={c.bg} />
            </View>
          </PressScale>
        ) : (
          <Text variant="body" numberOfLines={1} style={[styles.time, left !== null && { color: c.danger }]}>
            {clock}
          </Text>
        )}
        <GestureDetector gesture={scrub}>
          <View
            style={styles.wave}
            onLayout={(e) => {
              scrubWidth.value = e.nativeEvent.layout.width;
            }}
          >
            {wave(paused)}
          </View>
        </GestureDetector>
        {paused ? (
          <>
            <Text variant="footnote" tone="muted" numberOfLines={1} style={styles.ofTotal}>
              {`${voiceClock(take.seconds * 1000)} / ${voiceClock(take.total * 1000)}`}
            </Text>
            <Button variant="primary" size="sm" label={t("mobile.voice.send")} onPress={() => void take.send()} />
          </>
        ) : locked ? (
          <Button variant="secondary" size="sm" label={t("voice.pause")} onPress={() => void take.pause()} />
        ) : null}
      </View>
    );

  const leading = locked ? (
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
  ) : paused ? (
    <PressScale
      to={0.96}
      onPress={() => void take.cancel(true)}
      accessibilityRole="button"
      accessibilityLabel={t("voice.delete")}
      hitSlop={{ top: 0, bottom: 0, left: 12, right: 4 }}
      style={styles.discard}
    >
      <View style={styles.center}>
        <Text variant="subhead" tone="danger" numberOfLines={1} style={styles.discardText}>
          {t("mobile.voice.discard")}
        </Text>
      </View>
    </PressScale>
  ) : null;

  const above = holding ? (
    <Animated.View style={[styles.hint, hintStyle]} pointerEvents="none">
      <View style={styles.chev}>
        <Icon name="chev" size={13} color={c.faint} />
      </View>
      <Text variant="footnote" tone="faint" numberOfLines={1}>
        {t("mobile.voice.slideToCancel")}
      </Text>
    </Animated.View>
  ) : locked ? (
    <View style={styles.line} pointerEvents="none" accessibilityLiveRegion="polite">
      <Glass style={styles.lineGlass} intensity={50}>
        <View style={[styles.dot, { backgroundColor: c.danger }]} />
        <Text variant="footnote" numberOfLines={1} style={styles.lineText}>
          <Text variant="footnote" style={styles.lineBold}>
            {t("mobile.voice.recording")}
          </Text>
          {` · ${clock}`}
        </Text>
      </Glass>
      <View style={[styles.capsule, styles.capsuleInk, { backgroundColor: c.ink }]}>
        <Icon name="lock" size={14} color={c.bg} />
        <Text variant="footnote" numberOfLines={1} style={{ color: c.bg }}>
          {t("mobile.voice.locked")}
        </Text>
      </View>
    </View>
  ) : null;

  return { mic, overlay, leading, above, active: phase !== "idle" };
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  button: { width: MIC, height: MIC, borderRadius: MIC / 2 },
  overlay: {
    ...StyleSheet.absoluteFill,
    borderRadius: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  // Leaves the button slot (the microphone or send) its place at the end.
  overlayLive: { paddingLeft: 12, paddingRight: 6 + MIC + 8 },
  overlayPaused: { paddingLeft: 6, paddingRight: 6 },
  face: { width: 22, height: 22 },
  play: { width: MIC, height: MIC, borderRadius: MIC / 2 },
  time: { minWidth: 40, fontVariant: ["tabular-nums"] },
  ofTotal: { fontVariant: ["tabular-nums"] },
  wave: { flex: 1, minWidth: 0, height: LIVE_WAVE, flexDirection: "row" },
  trash: { width: LEAD, height: LEAD, borderRadius: LEAD / 2 },
  discard: { height: LEAD, paddingHorizontal: 4, justifyContent: "center" },
  discardText: { fontWeight: "600" },
  // Above the field's right end, over the microphone.
  lock: { position: "absolute", right: 0, bottom: LEAD + 16 },
  capsule: {
    height: 32,
    borderRadius: 16,
    paddingLeft: 8,
    paddingRight: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  capsuleInk: { flexShrink: 0 },
  // Starts where the field's text starts: the "+" (48), the gap (8) and the field's own inset.
  hint: { flexDirection: "row", alignItems: "center", gap: 2, minHeight: 20, paddingLeft: LEAD + 8 + 10, paddingBottom: 8 },
  chev: { transform: [{ rotate: "90deg" }] },
  line: { flexDirection: "row", alignItems: "center", gap: 8, paddingBottom: 8 },
  lineGlass: {
    flex: 1,
    minWidth: 0,
    height: 32,
    borderRadius: 16,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  lineText: { flex: 1, minWidth: 0, fontVariant: ["tabular-nums"] },
  lineBold: { fontWeight: "600" },
});
