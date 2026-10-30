import { elapsedClock, type LiveConsult, type LiveRun, usesBrowser } from "@agenteschat/client";
import { activitySentence, barPhrase, isWriting, PHRASE_TURN_MS } from "@agenteschat/client/lib/activity";
import { initialReveal, rebaseReveal, revealStep } from "@agenteschat/client/lib/reveal";
import { formatDuration } from "@agenteschat/client/lib/work";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityIndicator, Pressable, Text as RNText, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeInDown, ZoomIn } from "react-native-reanimated";
import { useFrameTime } from "@/agent/live";
import { Dither } from "@/sky/Dither";
import { softTones } from "@/sky/math";
import { CHROME_MAX_SCALE, haptics, Icon, PixelOrbit, PixelStop, Text, useReducedMotion, useTheme } from "@/ui";
import { AgentFace } from "../shared/Face";
import { useDirectory, useNow } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { markedParts, markName, stoppableInLine, workingEntries } from "./logic";
import { MessageText } from "./MessageText";
import { TurnTools } from "./ToolCalls";
import {
  fadeTail,
  openerDelayMs,
  pruneMarks,
  type RevealMark,
  rememberTurn,
  turnItems,
  turnOpener,
  turnPhase,
  WORD_FADE_MS,
  withOpacity,
} from "./turn";

/**
 * An agent's turn, live: one block from "pensando" to the last word, in
 * the same place, the last thing in the conversation while it works. The header says what it is doing
 * (its pixel orbit and a breathing word, and for how long); above the words, its tools in one line that
 * opens into every call (`TurnTools`) and, under it, the wells of the messages it read;
 * then the words, revealed at a steady pace and fading in, with the thin caret. When it is done, its saved
 * reply takes the same row and keeps the same block, closed on "Usou N ferramentas" (`recentTurn`).
 */
export const TurnRow = memo(function TurnRow({
  run,
  bodyOf,
}: {
  run: LiveRun;
  /** A message's text (the "Leu seu recado" wells quote it). */
  bodyOf: (messageId: string) => string | undefined;
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const agent = dir.agentById.get(run.agentId);
  const color = agentLook(agent).color;
  const phase = turnPhase(run);
  const live = phase !== "stopped";
  const items = turnItems(run);
  // It opens as if it had answered: a generic phrase until the first thing it says takes its place.
  const { said, opener, lines } = turnOpener(run, items);
  const wordsOnTop = !said && lines.length === 0;
  const now = useNow(1000);
  const since = run.startedAt ?? run.since ?? null;
  const secs = since ? Math.max(0, now - since) : 0;
  const word = t(`mobile.chat.turn.${phase}`);
  const took = secs >= 2000 ? ` · ${formatDuration(t, secs)}` : "";

  // Its work, for the saved reply to keep in place.
  const quotes = Object.fromEntries(
    items.flatMap((x) => (x.kind === "steer" ? [[x.messageId, bodyOf(x.messageId) ?? ""]] : [])),
  );
  const signature = items.map((x) => `${x.key}:${x.kind === "call" ? `${x.line.state}${x.line.count}` : ""}`).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` stands for the items and their quotes
  useEffect(() => {
    rememberTurn(run.runId, { items, quotes, at: Date.now() });
  }, [run.runId, signature]);
  // Just started and nothing of its own yet: it waits a moment, as a person would before answering.
  const [mountedAt] = useState(() => Date.now());
  const [, wake] = useState(0);
  const dueAt = (since ?? mountedAt) + openerDelayMs(run.runId);
  const quiet = live && items.length === 0 && !run.text && Date.now() < dueAt;
  useEffect(() => {
    if (!quiet) return;
    const timer = setTimeout(() => wake((n) => n + 1), Math.max(0, dueAt - Date.now()));
    return () => clearTimeout(timer);
  }, [quiet, dueAt]);
  if (quiet) return null;

  return (
    <View style={styles.msg}>
      <View style={styles.avslot}>
        <AgentFace agentId={run.agentId} size={32} mode={live ? (phase === "writing" ? "run" : "think") : "idle"} />
      </View>
      <View style={styles.body}>
        <View style={styles.who}>
          <Text variant="footnote" tone="ink2" style={styles.name} numberOfLines={1}>
            {agent?.name ?? ""}
          </Text>
          {/* While it works, the line above the box says so; the block only says "parado". */}
          <View style={styles.state} accessible accessibilityLiveRegion="polite" accessibilityLabel={word}>
            {live ? (
              <PixelOrbit color={color} size={12} />
            ) : (
              <Text variant="footnote" tone="faint" maxFontSizeMultiplier={CHROME_MAX_SCALE}>
                {word}
                {took}
              </Text>
            )}
          </View>
        </View>
        {/* Nothing said and no steps yet: the words stream where the opener stands, so the line it opens
            with stays put when a tool call turns it into narration. */}
        {wordsOnTop && run.text ? (
          <RevealText text={run.text} live={phase === "writing"} accent={color} />
        ) : said || opener !== null ? (
          <View style={styles.say}>
            <MessageText body={said ?? t(`mobile.chat.turn.opener${opener}`)} selectable={false} />
          </View>
        ) : null}
        <TurnTools items={lines} agentName={agent?.name ?? ""} color={color} quoteOf={bodyOf} />
        {run.text && !wordsOnTop ? <RevealText text={run.text} live={phase === "writing"} accent={color} /> : null}
      </View>
    </View>
  );
});

/**
 * The words as they arrive: revealed word by word at a steady reading pace (a backlog drains faster, never
 * in one chunk), each new word fading in (~280 ms), the caret after them. Mounted with a long text already
 * (back to the conversation mid-reply), it shows it at once.
 */
function RevealText({ text, live, accent }: { text: string; live: boolean; accent: AgentColorName }) {
  const c = useTheme().colors;
  const reduced = useReducedMotion();
  const shown = useRef(initialReveal(text));
  const prev = useRef(text);
  const marks = useRef<RevealMark[]>([]);
  const last = useRef<number | null>(null);
  if (prev.current !== text) {
    const kept = rebaseReveal(shown.current, prev.current, text);
    if (kept < shown.current) marks.current = [];
    shown.current = kept;
    prev.current = text;
  }
  // The clock runs while words wait to be shown or are still fading in.
  const active = live && !reduced && (shown.current < text.length || marks.current.length > 0);
  const t = useFrameTime(active, 0);
  const ms = t * 1000;
  if (!active) {
    // Idle: the next words start a fresh pace (no jump for the time it waited).
    last.current = null;
    if (!live || reduced) shown.current = text.length;
    marks.current = [];
  } else if (last.current !== ms) {
    const elapsed = last.current === null ? 0 : ms - last.current;
    last.current = ms;
    if (shown.current < text.length) {
      const next = revealStep(shown.current, text, elapsed);
      if (next > shown.current) {
        shown.current = next;
        marks.current.push({ at: next, t: ms });
      }
    }
    marks.current = pruneMarks(marks.current, ms);
    // All shown and settled: nothing fades any more.
    const only = marks.current[0];
    if (shown.current >= text.length && marks.current.length === 1 && only && ms - only.t >= WORD_FADE_MS)
      marks.current = [];
  }
  const { solid, tail } = fadeTail(text, shown.current, marks.current, ms);
  const tailNode =
    tail.length > 0
      ? tail.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of the tail, in order
          <RNText key={i} style={{ color: withOpacity(c.ink, p.opacity) }}>
            {p.text}
          </RNText>
        ))
      : undefined;
  return (
    <MessageText body={text.slice(0, solid)} tail={tailNode} streaming={live} selectable={false} accent={accent} />
  );
}

/** The runs at work in their browser (not writing yet), one per agent: each gets its browser card. */
export function browsingRuns(runs: LiveRun[]): LiveRun[] {
  const seen = new Set<string>();
  return runs.filter((r) => {
    if (isWriting(r) || !usesBrowser(r) || seen.has(r.agentId)) return false;
    seen.add(r.agentId);
    return true;
  });
}

/** How many faces the stack shows (the sentence says "e mais N"), as on the web. */
const STACK_MAX = 4;

/**
 * The working line, as the web's activity bar above the composer (ChannelPage `ActivityBar`,
 * WorkingLine.tsx, `.ac-typing[data-active]`): a compact glass pill
 * that fits its content, with a dithered band sweeping in the first agent's color behind it; the
 * pixel orbit; the stacked live mini bodies, each on a plate and popping in (an agent asking
 * another shows both, with an arrow); the sentence with names in ink, fading in whenever what they
 * do changes ("Atlas está consultando o Sentry…"); the clock of a question that is out; and, after
 * a thin rule, "Parar" for the runs I may stop (one tap, no question: what it did stays and can
 * continue). On while they work: one agent on its own gets a turning phrase
 * (a light line while it thinks, what it does, an aside on a long step, what it said last). Nothing
 * moves with Reduce Motion or off screen.
 */
export function WorkingLine({
  runs,
  consults,
  canStop,
  onStop,
  onOpenBrowser,
}: {
  runs: LiveRun[];
  consults: LiveConsult[];
  canStop: (run: LiveRun) => boolean;
  onStop: (run: LiveRun) => void;
  /** An agent in its browser: tapping the line opens its card in the conversation. */
  onOpenBrowser?: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const { colors: c, shadows } = useTheme();
  const reduced = useReducedMotion();
  const agentName = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  const entries = workingEntries(runs, consults, agentName);
  const asking = entries.find((e) => e.consult?.status === "asking")?.consult;
  const now = useNow(asking ? 1000 : 60_000);
  const turning = entries.length === 1 && entries[0]?.type === "agent";
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!turning) return;
    const timer = setInterval(() => setTick((n) => n + 1), PHRASE_TURN_MS);
    return () => clearInterval(timer);
  }, [turning]);
  const first = entries[0];
  if (!first) return null;
  const color = agentLook(dir.agentById.get(first.id)).color;
  const stoppable = stoppableInLine(runs).filter(canStop);
  const sentence = activitySentence(t, entries, markName);
  const phrase = barPhrase(t, entries, runs, tick, Date.now(), markName);
  const words = markedParts(phrase).map((p, i) =>
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
  const pop = reduced ? undefined : ZoomIn.springify().damping(11).stiffness(320).mass(0.6);
  // Right away, nothing asked: what it did stays and "Continuar" picks it up again.
  const stopNow = (run: LiveRun) => {
    haptics.firm();
    onStop(run);
  };
  const plate = [styles.tok, { backgroundColor: c.glassSolid }];
  // An agent working in its browser: the line says so, and a tap opens its browser card in the conversation.
  const browsing = browsingRuns(runs)[0];
  const openBrowser = browsing && onOpenBrowser ? () => onOpenBrowser(browsing.agentId) : undefined;
  return (
    <View style={styles.dock}>
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
        {/* An agent in its browser: tapping opens it live. */}
        <Pressable
          disabled={!browsing}
          onPress={openBrowser}
          accessibilityRole={browsing ? "button" : undefined}
          accessibilityLabel={browsing ? t("browser.watch.open") : undefined}
          style={styles.wordsTap}
        >
          {/* The phrase turns: the new one comes up from below. */}
          <Animated.View key={phrase} entering={reduced ? undefined : FadeInDown.duration(380)} style={styles.words}>
            <Text variant="caption" tone="muted" numberOfLines={1} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
              {words}
            </Text>
          </Animated.View>
          {browsing ? (
            <View style={[styles.browser, { backgroundColor: c.raised }]}>
              <Icon name="globe" size={12} color={c.ink2} />
              <Text variant="caption" tone="ink2" numberOfLines={1} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
                {t("browser.watch.title")}
              </Text>
            </View>
          ) : null}
        </Pressable>
        {clock ? (
          <RNText
            accessibilityLabel={t("chat.consult.clock", { time: clock })}
            maxFontSizeMultiplier={CHROME_MAX_SCALE}
            style={[styles.clock, { color: c.muted }]}
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
              onPress={() => stopNow(r)}
              accessibilityRole="button"
              accessibilityLabel={`${t("run.stop")} · ${agentName(r.agentId)}`}
              hitSlop={8}
              style={({ pressed }) => [styles.stop, pressed && { backgroundColor: `${c.danger}1F` }]}
            >
              {({ pressed }) => <PixelStop size={11} color={pressed ? c.danger : c.muted} />}
            </Pressable>
          ),
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Same turn as a saved message (MessageRow): the reply replaces it in place.
  msg: { flexDirection: "row", gap: 11, paddingLeft: 14, paddingRight: 16, paddingVertical: 10, marginTop: 4 },
  avslot: { width: 34, alignItems: "center", paddingTop: 2 },
  body: { flex: 1, minWidth: 0 },
  who: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 3, minHeight: 19 },
  name: { fontWeight: "600", fontSize: 14, lineHeight: 19, flexShrink: 1 },
  state: { flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 0 },
  say: { marginVertical: 2 },
  dock: { paddingHorizontal: 4, paddingBottom: 6, alignItems: "flex-start" },
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
  wordsTap: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, minWidth: 0 },
  browser: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexShrink: 0,
    minHeight: 22,
    paddingHorizontal: 8,
    borderRadius: 999,
  },
  ink: { fontWeight: "600" },
  clock: { fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] },
  sep: { width: StyleSheet.hairlineWidth * 2, height: 16, marginLeft: 4, marginRight: 2 },
  stop: { width: 28, height: 28, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  stopping: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 },
});
