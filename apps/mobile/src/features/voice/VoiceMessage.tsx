import type { Message } from "@agenteschat/client";
import { voiceAudioGone, voiceAudioUrl, voiceClock, voiceExpired, voiceOf } from "@agenteschat/client/lib/voice";
import { Skia } from "@shopify/react-native-skia";
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, StyleSheet, View } from "react-native";
import { GestureDetector, useExclusiveGestures, usePanGesture, useTapGesture } from "react-native-gesture-handler";
import { useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { appHeaders, authedFetch, lastCookie } from "@/lib/auth";
import { serverUrl } from "@/lib/server";
import { Icon, PressScale, Text } from "@/ui";
import { useColors, useOrgId } from "../shared/hooks";
import { hasWords, nextSpeed } from "./logic";
import { playingId, seekPlayback, setPlaybackSpeed, startPlayback, stopPlayback, subscribePlayback } from "./playback";
import { barsPath, VoiceBars } from "./VoiceBars";

const WAVE = 28;
/** The list recycles rows: what a message had open or where it stopped lives outside them. */
const opened = new Set<string>();
const positions = new Map<string, number>();
const expired = new Set<string>();
let speed = 1;

/**
 * A voice message: the audio is the message, with one line of its words under the wave, in the same card, and nowhere
 * else; a tap opens the rest there. A recording the server no longer keeps stays as a dimmed wave with its words.
 */
export const VoiceMessage = memo(function VoiceMessage({ message }: { message: Message }) {
  const { t } = useTranslation();
  const c = useColors();
  const orgId = useOrgId();
  const voice = voiceOf(message.meta);
  const clipId = voice?.clipId ?? "";
  const durationMs = voice?.durationMs ?? 0;
  const sending = Boolean(message.local);
  const playing = useSyncExternalStore(subscribePlayback, playingId) === clipId;
  const progress = useSharedValue(positions.get(clipId) ?? 0);
  const path = useSharedValue(Skia.Path.Make());
  const [width, setWidth] = useState(0);
  const [time, setTime] = useState(durationMs);
  const [rate, setRate] = useState(speed);
  const [gone, setGone] = useState(() => expired.has(clipId) || Boolean(voice && voiceExpired(voice)));
  const [open, setOpen] = useState(() => opened.has(message.id));
  const lastSecond = useRef(-1);

  // A recycled row takes on another message.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the row shows another recording
  useEffect(() => {
    progress.value = positions.get(clipId) ?? 0;
    setTime(durationMs);
    setGone(expired.has(clipId) || Boolean(voice && voiceExpired(voice)));
    setOpen(opened.has(message.id));
  }, [clipId, message.id]);
  useEffect(() => {
    if (width > 0 && voice) path.value = barsPath(voice.peaks, width, WAVE);
  }, [width, voice, path]);

  const report = (at: number) => {
    progress.value = at;
    positions.set(clipId, at);
    const second = Math.floor((at * durationMs) / 1000);
    if (second === lastSecond.current) return;
    lastSecond.current = second;
    setTime(at * durationMs);
  };
  const ended = () => {
    positions.delete(clipId);
    progress.value = 0;
    setTime(durationMs);
  };
  const lose = () => {
    expired.add(clipId);
    setGone(true);
    ended();
  };
  const toggle = async () => {
    if (playing) {
      stopPlayback();
      return;
    }
    // A player says nothing of why a file failed: the server is asked first.
    const url = voiceAudioUrl(orgId, clipId, serverUrl());
    if (await voiceAudioGone(url, authedFetch as typeof fetch)) {
      lose();
      return;
    }
    await startPlayback({
      id: clipId,
      source: { uri: url, headers: appHeaders(lastCookie()) },
      durationMs,
      from: positions.get(clipId) ?? 0,
      speed,
      onProgress: report,
      onEnd: ended,
    });
  };
  const seek = (at: number) => {
    report(at);
    seekPlayback(clipId, at);
  };
  const cycle = () => {
    speed = nextSpeed(speed);
    setRate(speed);
    setPlaybackSpeed(clipId, speed);
  };
  const flip = () => {
    if (open) opened.delete(message.id);
    else opened.add(message.id);
    setOpen(!open);
  };

  const canPlay = !sending && !gone;
  const pan = usePanGesture({
    enabled: canPlay,
    activeOffsetX: [-4, 4],
    failOffsetY: [-12, 12],
    onUpdate: (e) => {
      "worklet";
      if (width > 0) progress.value = Math.max(0, Math.min(0.999, e.x / width));
    },
    onDeactivate: () => {
      "worklet";
      scheduleOnRN(seek, progress.value);
    },
  });
  const tap = useTapGesture({
    enabled: canPlay,
    onDeactivate: (e) => {
      "worklet";
      if (width > 0) scheduleOnRN(seek, Math.max(0, Math.min(0.999, e.x / width)));
    },
  });
  const scrub = useExclusiveGestures(pan, tap);

  const words = useMemo(() => hasWords(message), [message]);
  if (!voice) return null;
  return (
    <View style={styles.box}>
      <View style={[styles.card, { backgroundColor: c.raised, borderColor: c.line }]}>
        <View style={styles.player}>
          {gone ? null : (
            <PressScale
              to={0.92}
              disabled={!canPlay}
              onPress={() => void toggle()}
              accessibilityRole="button"
              accessibilityLabel={playing ? t("voice.stop") : t("voice.play")}
              hitSlop={8}
              style={[styles.play, { backgroundColor: canPlay ? c.ink : c.sunken }]}
            >
              <View style={styles.center}>
                <Icon name={playing ? "pause" : "play"} size={15} color={canPlay ? c.bg : c.muted} />
              </View>
            </PressScale>
          )}
          <GestureDetector gesture={scrub}>
            <View style={[styles.wave, gone && styles.dim]} accessible={false}>
              <VoiceBars
                path={path}
                progress={progress}
                on={c.ink}
                off={gone ? c.line2 : c.faint}
                onWidth={setWidth}
                height={WAVE}
                handle={!gone}
              />
            </View>
          </GestureDetector>
          {gone ? (
            <Text variant="caption" tone="faint" numberOfLines={1}>
              {t("voice.expired")}
            </Text>
          ) : (
            <Text variant="caption" tone="muted" style={styles.time}>
              {voiceClock(time)}
            </Text>
          )}
          {canPlay ? (
            <Pressable
              onPress={cycle}
              accessibilityRole="button"
              accessibilityLabel={t("voice.speed")}
              hitSlop={8}
              style={[styles.speed, { backgroundColor: c.sunken }]}
            >
              <Text variant="caption" tone="muted" style={styles.speedText}>
                {`${rate}×`}
              </Text>
            </Pressable>
          ) : null}
        </View>
        {words ? (
          <Pressable
            onPress={flip}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={open ? t("voice.hideText") : t("voice.showText")}
            hitSlop={8}
            style={styles.words}
          >
            <Text variant="small" tone="muted" numberOfLines={open ? undefined : 1} selectable={open}>
              {message.body}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  box: { marginTop: 4, gap: 6, maxWidth: 320 },
  card: {
    gap: 4,
    paddingVertical: 7,
    paddingLeft: 7,
    paddingRight: 8,
    borderRadius: 16,
    borderBottomLeftRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  player: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 34 },
  play: { width: 34, height: 34, borderRadius: 17 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  wave: { flex: 1, minWidth: 0, height: WAVE, flexDirection: "row" },
  dim: { opacity: 0.5, marginLeft: 6 },
  time: { minWidth: 30, textAlign: "right", fontVariant: ["tabular-nums"] },
  speed: { height: 22, minWidth: 28, paddingHorizontal: 5, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  speedText: { fontVariant: ["tabular-nums"] },
  // Under the wave, past the play button.
  words: { paddingLeft: 42, paddingBottom: 2 },
});
