import { elapsedClock, type LiveConsult, type LiveRun, narrationOf } from "@agenteschat/client";
import { activitySentence, isWriting } from "@agenteschat/client/lib/activity";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, Pressable, Text as RNText, StyleSheet, View } from "react-native";
import Animated, { FadeIn, ZoomIn } from "react-native-reanimated";
import { Dither } from "@/sky/Dither";
import { softTones } from "@/sky/math";
import { CHROME_MAX_SCALE, fonts, Icon, PixelOrbit, Text, useReducedMotion, useTheme } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useDirectory, useNow } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { markedParts, markName, stoppableInLine, workingEntries } from "./logic";
import { MessageText } from "./MessageText";

/** An agent's reply while it is being written: the words so far and the blue caret. */
export function StreamingRow({ run }: { run: LiveRun }) {
  const dir = useDirectory();
  const agent = dir.agentById.get(run.agentId);
  return (
    <View style={styles.msg}>
      <View style={styles.avslot}>
        <AgentFace agentId={run.agentId} size={32} mode="run" />
      </View>
      <View style={styles.body}>
        <View style={styles.who}>
          <Text variant="footnote" tone="ink" style={styles.name}>
            {agent?.name ?? ""}
          </Text>
          {agent?.role ? (
            <Text variant="caption" tone="faint" numberOfLines={1} style={styles.shrink}>
              {agent.role}
            </Text>
          ) : null}
        </View>
        <MessageText body={run.text} streaming={run.status !== "canceled"} />
      </View>
    </View>
  );
}

/** The runs that stream as rows (words arrived). */
export const writingRuns = (runs: LiveRun[]) =>
  runs.filter((r) => r.text.length > 0 && (r.status === "running" || r.status === "canceled"));

/** How many faces the stack shows (the sentence says "e mais N"), as on the web. */
const STACK_MAX = 4;

/**
 * The working line, as the web's activity bar above the composer (ChannelPage `ActivityBar`,
 * WorkingLine.tsx, `.ac-typing[data-active]`; telas/ConversaAgentes.html): a compact glass pill
 * that fits its content, with a dithered band sweeping in the first agent's color behind it; the
 * pixel orbit; the stacked live mini bodies, each on a plate and popping in (an agent asking
 * another shows both, with an arrow); the sentence with names in ink, fading in whenever what they
 * do changes ("Atlas está consultando o Sentry…"); the clock of a question that is out; and, after
 * a thin rule, "Parar" for the runs not writing yet that I may stop. Above it, what each one said
 * last between tool calls. Nothing moves with Reduce Motion or off screen.
 */
export function WorkingLine({
  runs,
  consults,
  canStop,
  onStop,
}: {
  runs: LiveRun[];
  consults: LiveConsult[];
  canStop: (run: LiveRun) => boolean;
  onStop: (run: LiveRun) => void;
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const { colors: c, shadows } = useTheme();
  const reduced = useReducedMotion();
  const agentName = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  const entries = workingEntries(runs, consults, agentName);
  const asking = entries.find((e) => e.consult?.status === "asking")?.consult;
  const now = useNow(asking ? 1000 : 60_000);
  const first = entries[0];
  if (!first) return null;
  const color = agentLook(dir.agentById.get(first.id)).color;
  const stoppable = stoppableInLine(runs).filter(canStop);
  const sentence = activitySentence(t, entries, markName);
  const words = markedParts(sentence).map((p, i) =>
    p.bold ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence, in order
      <RNText key={i} style={[styles.ink, { color: c.ink }]}>
        {p.text}
      </RNText>
    ) : (
      p.text
    ),
  );
  const said = runs
    .filter((r) => !isWriting(r))
    .flatMap((r) => {
      const last = narrationOf(r).at(-1);
      return last ? [{ id: r.runId, name: agentName(r.agentId), text: last }] : [];
    });
  const clock = asking ? elapsedClock(now - asking.since) : null;
  const pop = reduced ? undefined : ZoomIn.springify().damping(11).stiffness(320).mass(0.6);
  const confirm = (run: LiveRun) => {
    const name = agentName(run.agentId);
    Alert.alert(t("run.confirmTitle", agentGrammar(t, name)), t("run.kept"), [
      { text: t("run.continue"), style: "cancel" },
      { text: t("run.stop"), style: "destructive", onPress: () => onStop(run) },
    ]);
  };
  const plate = [styles.tok, { backgroundColor: c.glassSolid }];
  return (
    <View style={styles.dock}>
      {said.map((n) => (
        <Text key={n.id} variant="small" tone="muted" numberOfLines={1} style={styles.said}>
          <RNText style={[styles.saidName, { color: c.ink2 }]}>{n.name}:</RNText> {n.text}
        </Text>
      ))}
      <Animated.View
        entering={reduced ? undefined : FadeIn.duration(160)}
        style={[styles.pill, { backgroundColor: c.glassSolid, boxShadow: `${shadows.e1}, ${shadows.top}` }]}
        accessible
        accessibilityLiveRegion="polite"
        accessibilityLabel={markedParts(sentence)
          .map((p) => p.text)
          .join("")}
      >
        <Dither kind="sweep" tones={softTones(color, c.raised)} pixel={3} style={StyleSheet.absoluteFill} />
        <PixelOrbit color={color} size={14} />
        <View style={styles.stack} importantForAccessibility="no-hide-descendants">
          {entries.slice(0, STACK_MAX).map((e, i) => {
            const gap = i > 0 ? styles.overlap : undefined;
            if (e.consult?.status === "asking")
              return (
                <Animated.View key={`c:${e.id}`} entering={pop} style={[styles.pair, gap]}>
                  <View style={plate}>
                    <AgentFace agentId={e.id} size={18} mode="idle" />
                  </View>
                  <Icon name="right" size={14} color={c.faint} />
                  <View style={plate}>
                    <AgentFace agentId={e.consult.to} size={18} mode="think" />
                  </View>
                </Animated.View>
              );
            return (
              <Animated.View key={`a:${e.id}`} entering={pop} style={[plate, gap]}>
                <AgentFace agentId={e.id} size={18} mode="run" />
              </Animated.View>
            );
          })}
        </View>
        {/* Keyed by the words: a new activity fades in. */}
        <Animated.View key={sentence} entering={reduced ? undefined : FadeIn.duration(160)} style={styles.words}>
          <Text variant="caption" tone="muted" numberOfLines={1} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
            {words}
          </Text>
        </Animated.View>
        {clock ? (
          <RNText
            accessibilityLabel={t("chat.consult.clock", { time: clock })}
            maxFontSizeMultiplier={CHROME_MAX_SCALE}
            style={[styles.clock, { color: c.muted, fontFamily: fonts.dot }]}
          >
            {clock}
          </RNText>
        ) : null}
        {stoppable.length > 0 ? <View style={[styles.sep, { backgroundColor: c.line }]} /> : null}
        {stoppable.map((r) =>
          r.stopping ? (
            <View key={r.runId} style={styles.stopping} accessible accessibilityLabel={t("run.stopping")}>
              <ActivityIndicator size="small" color={c.muted} />
              <Text variant="caption" tone="muted">
                {t("run.stopping")}
              </Text>
            </View>
          ) : (
            <Pressable
              key={r.runId}
              onPress={() => confirm(r)}
              accessibilityRole="button"
              accessibilityLabel={`${t("run.stop")} · ${agentName(r.agentId)}`}
              hitSlop={8}
              style={({ pressed }) => [styles.stop, pressed && { backgroundColor: `${c.danger}1F` }]}
            >
              {({ pressed }) => <StopGlyph color={pressed ? c.danger : c.muted} />}
            </Pressable>
          ),
        )}
      </Animated.View>
    </View>
  );
}

/** A circle with a rounded square: "stop" (the web's StopGlyph, 16 pt). */
function StopGlyph({ color }: { color: string }) {
  return (
    <View style={[styles.stopRing, { borderColor: color }]}>
      <View style={[styles.stopSquare, { backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  msg: { flexDirection: "row", gap: 10, paddingHorizontal: 14, paddingVertical: 8 },
  avslot: { width: 34, alignItems: "center", paddingTop: 2 },
  body: { flex: 1, minWidth: 0 },
  who: { flexDirection: "row", alignItems: "baseline", gap: 7 },
  name: { fontWeight: "600" },
  shrink: { flexShrink: 1 },
  dock: { paddingHorizontal: 4, paddingBottom: 6, alignItems: "flex-start" },
  said: { marginBottom: 4, alignSelf: "stretch" },
  saidName: { fontWeight: "600" },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: "100%",
    minHeight: 32,
    paddingVertical: 2,
    paddingLeft: 8,
    paddingRight: 6,
    borderRadius: 999,
    overflow: "hidden",
  },
  stack: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
  tok: { padding: 1.5, borderRadius: 7 },
  pair: { flexDirection: "row", alignItems: "center", gap: 1 },
  overlap: { marginLeft: -5 },
  words: { flexShrink: 1 },
  ink: { fontWeight: "600" },
  clock: { fontSize: 12 },
  sep: { width: StyleSheet.hairlineWidth * 2, height: 16, marginLeft: 4, marginRight: 2 },
  stop: { width: 28, height: 28, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  stopRing: {
    width: 12,
    height: 12,
    borderRadius: 999,
    borderWidth: 1.25,
    alignItems: "center",
    justifyContent: "center",
  },
  stopSquare: { width: 4.5, height: 4.5, borderRadius: 1 },
  stopping: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 },
});
