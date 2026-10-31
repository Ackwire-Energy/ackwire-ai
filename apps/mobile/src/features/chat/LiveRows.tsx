import { elapsedClock, type LiveConsult, type LiveRun, usesBrowser } from "@agenteschat/client";
import {
  activitySentence,
  barAsking,
  barFaces,
  barWords,
  isWriting,
  PHRASE_TURN_MS,
} from "@agenteschat/client/lib/activity";
import { initialReveal, rebaseReveal, revealStep } from "@agenteschat/client/lib/reveal";
import { formatDuration } from "@agenteschat/client/lib/work";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Pressable,
  Text as RNText,
  type StyleProp,
  StyleSheet,
  type TextStyle,
  View,
} from "react-native";
import Animated, { FadeIn, FadeInDown, ZoomIn } from "react-native-reanimated";
import { useFrameTime } from "@/agent/live";
import { Dither } from "@/sky/Dither";
import { softTones } from "@/sky/math";
import { CHROME_MAX_SCALE, haptics, Icon, PixelOrbit, PixelStop, Text, useReducedMotion, useTheme } from "@/ui";
import { AgentFace, Face } from "../shared/Face";
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
 * (its pixel orbit and a breathing word, and for how long); then the words, revealed at a steady pace and fading
 * in, with the thin caret; under them, last, its tools in one line that opens into every call (`TurnTools`) and,
 * under it, the wells of the messages it read. When it is done, its saved reply takes the same row and keeps the
 * same block in the same place, closed on "Usou N ferramentas" (`recentTurn`).
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
        {run.text && !wordsOnTop ? <RevealText text={run.text} live={phase === "writing"} accent={color} /> : null}
        {/* Its tools last, where its saved reply keeps them. */}
        <TurnTools items={lines} agentName={agent?.name ?? ""} color={color} quoteOf={bodyOf} />
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

/**
 * The working line, as the web's activity bar above the composer (ChannelPage `ActivityBar`,
 * WorkingLine.tsx, `.ac-typing[data-active]`), one for everyone at work here: a low glass pill as wide
 * as the box whatever it says, with a dithered band sweeping in the first agent's color behind it while
 * agents work; the pixel orbit (three dots while only people type); a few small faces, each on a plate
 * and popping in (an agent on its own asking another shows both, with an arrow); one line with names in
 * ink, fading in whenever it changes ("Theo e mais 2 estão trabalhando · Marina está digitando…"); the
 * clock of a question that is out; and, for one agent on its own, after a thin rule, "Parar" when I may
 * stop it (one tap, no question: what it did stays and can continue). One agent on its own gets a turning
 * phrase (a light line while it thinks, what it does, an aside on a long step, what it said last).
 * Nothing moves with Reduce Motion or off screen.
 */
export function WorkingLine({
  runs,
  consults,
  typing,
  canStop,
  onStop,
  onOpenBrowser,
}: {
  runs: LiveRun[];
  consults: LiveConsult[];
  /** The people typing here (never me). */
  typing: string[];
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
  const entries = workingEntries(runs, consults, agentName, typing, (id) => dir.memberById.get(id)?.name);
  const asking = barAsking(entries);
  const now = useNow(asking ? 1000 : 60_000);
  const turning = entries.length === 1 && entries[0]?.type === "agent";
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!turning) return;
    const timer = setInterval(() => setTick((n) => n + 1), PHRASE_TURN_MS);
    return () => clearInterval(timer);
  }, [turning]);
  if (entries.length === 0) return null;
  const agents = entries.filter((e) => e.type === "agent");
  const lead = agents[0];
  const color = lead ? agentLook(dir.agentById.get(lead.id)).color : null;
  // "Parar" is one agent's: with several at work the line can't say whose (the box's own stop stops them all).
  const solo = agents.length === 1 ? lead : undefined;
  const stoppable = solo ? stoppableInLine(runs).filter((r) => r.agentId === solo.id && canStop(r)) : [];
  const sentence = activitySentence(t, entries, markName);
  const [agentWords, sep, typers, typingWords] = barWords(t, entries, runs, tick, Date.now(), markName);
  // A piece of the line, on one line, names in ink.
  const piece = (text: string, style?: StyleProp<TextStyle>) => (
    <Text variant="caption" tone="muted" numberOfLines={1} maxFontSizeMultiplier={CHROME_MAX_SCALE} style={style}>
      {markedParts(text).map((p, i) =>
        p.bold ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence, in order
          <RNText key={i} style={[styles.ink, { color: c.ink }]}>
            {p.text}
          </RNText>
        ) : (
          p.text
        ),
      )}
    </Text>
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
        {color ? (
          <Dither kind="sweep" tones={softTones(color, c.raised)} pixel={3} style={StyleSheet.absoluteFill} />
        ) : null}
        {color ? <PixelOrbit color={color} size={14} /> : <TypingDots color={c.muted} />}
        <View style={styles.stack} importantForAccessibility="no-hide-descendants">
          {barFaces(entries).map((e, i) => {
            const gap = i > 0 ? styles.overlap : undefined;
            if (e.type === "person")
              return (
                <Animated.View key={`p:${e.id}`} entering={pop} style={[plate, gap]}>
                  <Face who={{ type: "person", id: e.id }} size={18} />
                </Animated.View>
              );
            if (asking && e.consult === asking)
              return (
                <Animated.View key={`c:${e.id}`} entering={pop} style={[styles.pair, gap]}>
                  <View style={plate}>
                    <AgentFace agentId={e.id} size={18} mode="idle" />
                  </View>
                  <Icon name="right" size={14} color={c.faint} />
                  <View style={plate}>
                    <AgentFace agentId={asking.to} size={18} mode="think" />
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
          <Animated.View
            key={agentWords + typers + typingWords}
            entering={reduced ? undefined : FadeInDown.duration(380)}
            style={styles.words}
          >
            {agentWords ? (
              <View style={styles.agents}>
                {piece(agentWords, styles.shrink)}
                {sep ? piece(sep) : null}
              </View>
            ) : null}
            {typingWords ? (
              <View style={styles.people}>
                {piece(typers, styles.shrink)}
                {piece(typingWords)}
              </View>
            ) : null}
          </Animated.View>
          {browsing ? (
            <View style={[styles.browser, { backgroundColor: c.raised }]}>
              <Icon name="globe" size={14} color={c.ink2} />
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

/** Three dots rising in turn while only people type (the web's `.ac-typing__dots`); still with Reduce Motion. */
function TypingDots({ color }: { color: string }) {
  const reduced = useReducedMotion();
  const t = useFrameTime(!reduced, 0);
  return (
    <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {[0, 1, 2].map((i) => {
        // A 1.2 s round, each dot 0.15 s after the one before: up and bright at 30% of its round.
        const at = (((t - i * 0.15) % 1.2) + 1.2) % 1.2;
        const up = reduced ? 0 : Math.max(0, 1 - Math.abs(at / 1.2 - 0.3) / 0.3);
        return (
          <View
            key={i}
            style={[
              styles.dot,
              { backgroundColor: color, opacity: 0.4 + 0.6 * up, transform: [{ translateY: -2 * up }] },
            ]}
          />
        );
      })}
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
  // As wide as the box, whatever it says: a turning phrase or a face coming and going never moves its edge.
  dock: { paddingHorizontal: 4, paddingBottom: 6 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 28,
    paddingHorizontal: 8,
    borderRadius: 999,
    overflow: "hidden",
  },
  stack: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
  tok: { padding: 1.5, borderRadius: 7 },
  pair: { flexDirection: "row", alignItems: "center", gap: 1 },
  overlap: { marginLeft: -5 },
  dots: { flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 0 },
  dot: { width: 4, height: 4, borderRadius: 2 },
  // The words take what the marks and the stop leave, so the globe after them stays put while they turn. Who is
  // typing keeps its width: the agents' words before it end in "…" first (the " · " after them goes with their
  // last bit, so it never opens the line), then the names, never what they do.
  words: { flex: 1, flexDirection: "row" },
  agents: { flexDirection: "row", flexShrink: 1, overflow: "hidden" },
  people: { flexDirection: "row", maxWidth: "100%" },
  shrink: { flexShrink: 1 },
  wordsTap: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1, minWidth: 0 },
  browser: {
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: 22,
    height: 22,
    borderRadius: 999,
  },
  ink: { fontWeight: "600" },
  clock: { fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] },
  sep: { width: StyleSheet.hairlineWidth * 2, height: 16, marginLeft: 4, marginRight: 2 },
  // Last in the pill, in its round end: 2px from the edge all around.
  stop: { width: 24, height: 24, marginRight: -6, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  stopping: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 },
});
