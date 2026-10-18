import { elapsedClock, type LiveConsult, type LiveRun } from "@agenteschat/client";
import { activitySentence } from "@agenteschat/client/lib/activity";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Alert, Pressable, Text as RNText, StyleSheet, View } from "react-native";
import { CHROME_MAX_SCALE, fonts, Icon, PixelOrbit, Text } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useColors, useDirectory, useNow } from "../shared/hooks";
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
 * The working line, as the web's bar above the composer (WorkingLine.tsx +
 * ActivityBar): the orbit in the first agent's color, one live face per agent
 * (an agent asking another shows both, with an arrow), the sentence with names
 * in ink ("Atlas está consultando o Sentry…", "Theo, Iris e mais 2 estão
 * trabalhando…", "Dev está perguntando ao Infra…"), the clock of a question
 * that is out, and "Parar" for the runs I may stop.
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
  const c = useColors();
  const agentName = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  const entries = workingEntries(runs, consults, agentName);
  const asking = entries.find((e) => e.consult?.status === "asking")?.consult;
  const now = useNow(asking ? 1000 : 60_000);
  const first = entries[0];
  if (!first) return null;
  const stoppable = stoppableInLine(runs).filter(canStop);
  const words = markedParts(activitySentence(t, entries, markName)).map((p, i) =>
    p.bold ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence, in order
      <RNText key={i} style={[styles.ink, { color: c.ink }]}>
        {p.text}
      </RNText>
    ) : (
      p.text
    ),
  );
  const clock = asking ? elapsedClock(now - asking.since) : null;
  const confirm = (run: LiveRun) => {
    const name = agentName(run.agentId);
    Alert.alert(t("run.confirmTitle", agentGrammar(t, name)), t("run.kept"), [
      { text: t("run.continue"), style: "cancel" },
      { text: t("run.stop"), style: "destructive", onPress: () => onStop(run) },
    ]);
  };
  return (
    <View style={styles.workWrap}>
      <View style={[styles.work, { backgroundColor: c.sunken }]} accessibilityLiveRegion="polite">
        <PixelOrbit color={agentLook(dir.agentById.get(first.id)).color} size={13} />
        <View style={styles.faces} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {entries.slice(0, STACK_MAX).map((e, i) => {
            const plate = [styles.plate, { borderColor: c.sunken, backgroundColor: c.sunken }, i > 0 && styles.overlap];
            if (e.consult?.status === "asking")
              return (
                <View key={e.id} style={[styles.pair, i > 0 && styles.overlap]}>
                  <View style={[styles.plate, { borderColor: c.sunken, backgroundColor: c.sunken }]}>
                    <AgentFace agentId={e.id} size={18} mode="idle" />
                  </View>
                  <Icon name="right" size={12} color={c.faint} />
                  <View style={[styles.plate, { borderColor: c.sunken, backgroundColor: c.sunken }]}>
                    <AgentFace agentId={e.consult.to} size={18} mode="think" />
                  </View>
                </View>
              );
            return (
              <View key={e.id} style={plate}>
                <AgentFace agentId={e.id} size={18} mode="run" />
              </View>
            );
          })}
        </View>
        <Text variant="small" tone="muted" style={styles.grow} numberOfLines={2}>
          {words}
        </Text>
        {clock ? (
          <RNText
            accessibilityRole="timer"
            accessibilityLabel={t("chat.consult.clock", { time: clock })}
            maxFontSizeMultiplier={CHROME_MAX_SCALE}
            style={[styles.clock, { color: c.muted, fontFamily: fonts.dot }]}
          >
            {clock}
          </RNText>
        ) : null}
        {stoppable.map((r) => (
          <Pressable
            key={r.runId}
            onPress={() => confirm(r)}
            disabled={r.stopping}
            accessibilityRole="button"
            accessibilityLabel={r.stopping ? t("run.stopping") : `${t("run.stop")} · ${agentName(r.agentId)}`}
            accessibilityState={{ disabled: Boolean(r.stopping), busy: Boolean(r.stopping) }}
            hitSlop={10}
            style={({ pressed }) => [styles.stop, { borderColor: c.line }, pressed && { backgroundColor: c.bg }]}
          >
            {r.stopping ? <ActivityIndicator size="small" color={c.muted} /> : <StopGlyph color={c.ink2} />}
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** A rounded square in a circle: "stop" (the web's StopGlyph). */
function StopGlyph({ color }: { color: string }) {
  return <View style={[styles.stopSquare, { backgroundColor: color }]} />;
}

const styles = StyleSheet.create({
  msg: { flexDirection: "row", gap: 10, paddingHorizontal: 14, paddingVertical: 8 },
  avslot: { width: 34, alignItems: "center", paddingTop: 2 },
  body: { flex: 1, minWidth: 0 },
  who: { flexDirection: "row", alignItems: "baseline", gap: 7 },
  name: { fontWeight: "600" },
  shrink: { flexShrink: 1 },
  workWrap: { paddingHorizontal: 12, paddingVertical: 6 },
  work: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    minHeight: 40,
    paddingVertical: 7,
    paddingLeft: 12,
    paddingRight: 8,
    borderRadius: 14,
  },
  faces: { flexDirection: "row", alignItems: "center" },
  plate: { borderRadius: 999, borderWidth: 2 },
  pair: { flexDirection: "row", alignItems: "center", gap: 2 },
  overlap: { marginLeft: -6 },
  grow: { flex: 1 },
  ink: { fontWeight: "600" },
  clock: { fontSize: 13 },
  stop: {
    width: 28,
    height: 28,
    borderRadius: 999,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  stopSquare: { width: 9, height: 9, borderRadius: 2 },
});
