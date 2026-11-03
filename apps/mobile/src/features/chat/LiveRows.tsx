import { elapsedClock, type LiveConsult, type LiveRun, usesBrowser } from "@agenteschat/client";
import {
  type ActivityEntry,
  activitySentence,
  barAsking,
  barElapsed,
  barFaces,
  barWords,
  isWriting,
  waitsForWords,
} from "@agenteschat/client/lib/activity";
import { initialReveal, rebaseReveal, revealStep } from "@agenteschat/client/lib/reveal";
import { formatDuration, waitStep } from "@agenteschat/client/lib/work";
import { type AgentColorName, gradientOf } from "@agenteschat/ui/agent/engine";
import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  Pressable,
  Text as RNText,
  type StyleProp,
  StyleSheet,
  type TextLayoutEvent,
  type TextStyle,
  View,
} from "react-native";
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  ZoomIn,
} from "react-native-reanimated";
import { useFrameTime } from "@/agent/live";
import { Dither } from "@/sky/Dither";
import { softTones } from "@/sky/math";
import { CHROME_MAX_SCALE, haptics, Icon, PixelOrbit, PixelStop, Text, useReducedMotion, useTheme } from "@/ui";
import { AgentFace, AgentWho, Face } from "../shared/Face";
import { useDirectory, useNow, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import { ConsultPairRow, useRunConsults } from "./ConsultGroup";
import {
  type LineDrawn,
  type LineWords,
  leavingWords,
  lineFit,
  lineStops,
  markedParts,
  markName,
  narrowDrawn,
  PHRASE_FADE_MS,
  type PhraseTurn,
  turnPhrase,
  workingEntries,
} from "./logic";
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
  turnShows,
  WORD_FADE_MS,
  waitDot,
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
  const when = useWhen();
  const agent = dir.agentById.get(run.agentId);
  const color = agentLook(agent).color;
  const phase = turnPhase(run);
  const live = phase !== "stopped";
  const items = turnItems(run);
  // The first thing it said opens the block, above its tools.
  const { said, lines } = turnOpener(items);
  // At work with no words yet: the waiting row (its face, the pixels and what it does now), no name.
  const waiting = waitsForWords(run);
  const wordsOnTop = !said && lines.length === 0;
  const now = useNow(1000);
  // Asking other agents before it posted anything: the pair row stands right before this row (its reply takes it).
  const consults = useRunConsults(run.runId, run, null);
  const pair =
    consults.length > 0 ? <ConsultPairRow askerId={run.agentId} channelId={run.channelId} items={consults} /> : null;
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

  if (waiting)
    return (
      <>
        {pair}
        <View style={styles.msg}>
          <View style={styles.avslot}>
            <AgentFace agentId={run.agentId} size={32} mode="think" />
          </View>
          <WaitLine work={run.work} color={color} />
        </View>
      </>
    );
  return (
    <>
      {pair}
      <View style={styles.msg}>
        <View style={styles.avslot}>
          <AgentFace agentId={run.agentId} size={32} mode={live ? (phase === "writing" ? "run" : "think") : "idle"} />
        </View>
        <View style={styles.body}>
          <View style={styles.who}>
            <Text variant="footnote" tone="ink2" style={styles.name} numberOfLines={1}>
              {agent?.name ?? ""}
            </Text>
            {/* While it works, the line above the box says so: the block has its start time, as a message (the web's
              `RunClock`); "parado" once stopped. */}
            <View style={styles.state} accessible accessibilityLiveRegion="polite" accessibilityLabel={word}>
              {live ? (
                <Text variant="footnote" tone="faint">
                  {when.time(new Date(since ?? mountedAt).toISOString())}
                </Text>
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
          ) : said ? (
            <View style={styles.say}>
              <MessageText body={said} selectable={false} />
            </View>
          ) : null}
          {run.text && !wordsOnTop ? <RevealText text={run.text} live={phase === "writing"} accent={color} /> : null}
          {/* Its tools last, where its saved reply keeps them. */}
          <TurnTools items={lines} agentName={agent?.name ?? ""} color={color} quoteOf={bodyOf} />
        </View>
      </View>
    </>
  );
});

/**
 * The waiting row's body beside the face, centered on it (as the web's `.ac-wait`): three 4px pixels in the agent's
 * color lighting up in turn with a 2px hop (its light tone in the dark theme), then a muted line saying what it does
 * now (`waitStep`), each new one fading in. Reduce Motion: the pixels stand still at 60%, the line just swaps.
 */
function WaitLine({ work, color }: { work: LiveRun["work"]; color: AgentColorName }) {
  const { t } = useTranslation();
  const { scheme } = useTheme();
  const reduced = useReducedMotion();
  const time = useFrameTime(!reduced, 0);
  const [light, deep] = gradientOf(color);
  const step = waitStep(t, work);
  return (
    <View style={styles.wait} accessible accessibilityLiveRegion="polite" accessibilityLabel={step}>
      <View style={styles.waitDots}>
        {[0, 1, 2].map((i) => {
          const d = waitDot(time, i, reduced);
          return (
            <View
              key={i}
              style={[
                styles.waitDot,
                {
                  backgroundColor: scheme === "dark" ? light : deep,
                  opacity: d.opacity,
                  transform: [{ translateY: d.lift }],
                },
              ]}
            />
          );
        })}
      </View>
      <Animated.View key={step} entering={reduced ? undefined : FadeIn.duration(160)} style={styles.shrink}>
        <Text variant="footnote" tone="muted" numberOfLines={1} ellipsizeMode="clip">
          {step}
        </Text>
      </Animated.View>
    </View>
  );
}

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
 * ink, crossfading whenever it changes ("Theo e mais 2 estão trabalhando · Marina está digitando…"); the
 * clock of a question that is out; and, for one agent on its own, its time ("16 s") and, after a thin rule,
 * "Parar" when I may stop it (one tap, no question: what it did stays and can continue). One agent on its
 * own gets a turning phrase (a light line while it thinks, what it does, an aside on a long step, what it
 * said last).
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
  const agents = entries.filter((e) => e.type === "agent");
  const lead = agents[0];
  // "Parar" and the time are one agent's: with several at work the line can't say whose (the box's own stop stops
  // them all).
  const solo = agents.length === 1 ? lead : undefined;
  // One clock for the time and a question's clock, moving each second while one counts: a redraw in between (the
  // phrase turning, an event) reads the same second, so both step evenly; narrowing to one agent changes the pace, and a
  // new pace reads the clock afresh (`useNow`).
  const now = useNow(asking || solo ? 1000 : 60_000);
  if (entries.length === 0) return null;
  const soloRun = solo ? runs.find((r) => r.agentId === solo.id) : undefined;
  const color = lead ? agentLook(dir.agentById.get(lead.id)).color : null;
  const stoppable = lineStops(entries, runs, canStop);
  const sentence = activitySentence(t, entries, markName);
  const took = barElapsed(t, entries, runs, now);
  // A piece of the line, on one line, names in ink.
  const piece: LinePiece = (text, style, onTextLayout) => (
    <Text
      variant="caption"
      tone="muted"
      numberOfLines={1}
      maxFontSizeMultiplier={CHROME_MAX_SCALE}
      style={style}
      onTextLayout={onTextLayout}
    >
      {markedParts(text).map((p, i) =>
        p.agentId ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one sentence, in order
          <RNText key={i} style={{ color: c.ink }}>
            <AgentWho agentId={p.agentId} name={p.text} size={13} />
          </RNText>
        ) : p.bold ? (
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
  const plate = [styles.tok, { backgroundColor: c.glassSolid }];
  // One agent on its own: its face is on its row in the conversation once the row shows, not here again.
  const faces = entries.length === 1 && soloRun && turnShows(soloRun, now) && !asking ? [] : barFaces(entries);
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
          {faces.map((e, i) => {
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
          <TurningWords entries={entries} piece={piece} reduced={reduced} />
          {took ? (
            <Text variant="caption" tone="faint" maxFontSizeMultiplier={CHROME_MAX_SCALE} style={styles.took}>
              · {took}
            </Text>
          ) : null}
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
        <LineStop runs={stoppable} onStop={onStop} />
      </Animated.View>
    </View>
  );
}

/**
 * The line's own "Parar", last in its pill after a thin rule (the working line's, and the requests' line's while it
 * takes its place): one tap stops the agent, nothing asked, and "Parando…" while it stops.
 */
export function LineStop({ runs, onStop }: { runs: LiveRun[]; onStop: (run: LiveRun) => void }) {
  const { t } = useTranslation();
  const dir = useDirectory();
  const c = useTheme().colors;
  if (runs.length === 0) return null;
  const nameOf = (run: LiveRun) => dir.agentById.get(run.agentId)?.name ?? t("channel.unknownAgent");
  // Right away, nothing asked: what it did stays and "Continuar" picks it up again.
  const stopNow = (run: LiveRun) => {
    haptics.firm();
    onStop(run);
  };
  return (
    <>
      <View style={[styles.sep, { backgroundColor: c.line }]} />
      {runs.map((r) =>
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
            accessibilityLabel={`${t("run.stop")} · ${nameOf(r)}`}
            hitSlop={8}
            style={({ pressed }) => [styles.stop, pressed && { backgroundColor: `${c.danger}1F` }]}
          >
            {({ pressed }) => <PixelStop size={11} color={pressed ? c.danger : c.muted} />}
          </Pressable>
        ),
      )}
    </>
  );
}

type LinePiece = (text: string, style?: StyleProp<TextStyle>, onTextLayout?: (e: TextLayoutEvent) => void) => ReactNode;

// The phrase turns as on the web (`.ac-turn`): the old one leaves upward while the new one comes up from below,
// crossfading, so some words always show; a short rise keeps both inside the pill.
const TURN = { duration: PHRASE_FADE_MS, easing: Easing.bezier(0.2, 0.7, 0.2, 1) };

/**
 * The phrase as it turns (`turnPhrase`): the one shown and, over it, the one leaving, the only two drawn. A phrase
 * keeps its key from coming in to leaving, so the words on screen are the ones that leave, at the widths they drew.
 * The first comes with the pill, and the words go with it at once; with Reduce Motion each phrase just takes the last
 * one's place.
 */
function TurningWords({ entries, piece, reduced }: { entries: ActivityEntry[]; piece: LinePiece; reduced: boolean }) {
  const { t } = useTranslation();
  const words = barWords(t, entries, markName);
  const [shown, setShown] = useState<PhraseTurn>(() => ({ now: words, was: null, n: 0, since: Date.now() }));
  const [, wake] = useState(0);
  const next = turnPhrase(shown, words, Date.now());
  if (next.shown !== shown) setShown(next.shown);
  const leaving = leavingWords(next.shown, reduced, Date.now());
  useEffect(() => {
    if (next.wait === 0) return;
    const timer = setTimeout(() => wake((k) => k + 1), next.wait);
    return () => clearTimeout(timer);
  }, [next.wait]);
  return (
    <View style={styles.words}>
      {leaving ? <BarWords key={shown.n - 1} words={leaving} piece={piece} leaving /> : null}
      <BarWords key={shown.n} words={shown.now} piece={piece} enter={shown.n > 0 && !reduced} />
    </View>
  );
}

/**
 * The line's words in the pieces that give way in turn (`barWords`): the agents' and the " · " after them, then
 * who is typing, whose names alone end in "…". Each piece that can end in "…" keeps to the width it drew
 * (`lineFit`), so what follows comes right after it; the agents' words cut to a sliver leave the line.
 */
function BarWords({
  words: [agents, sep, typers, typing],
  piece,
  enter = false,
  leaving = false,
}: {
  words: LineWords;
  piece: LinePiece;
  /** Comes up from below. */
  enter?: boolean;
  /** Rises and fades over the phrase taking its place. */
  leaving?: boolean;
}) {
  const [drawn, setDrawn] = useState<LineDrawn>({});
  // 0 below, 1 in place, 2 gone above.
  const at = useSharedValue(enter ? 0 : 1);
  useEffect(() => {
    at.value = withTiming(leaving ? 2 : 1, TURN);
  }, [leaving, at]);
  const turn = useAnimatedStyle(() => ({
    opacity: 1 - Math.abs(1 - at.value),
    transform: [{ translateY: 6 * (1 - at.value) }],
  }));
  const measure = (part: keyof LineDrawn) => (e: TextLayoutEvent) => {
    const width = e.nativeEvent.lines[0]?.width ?? 0;
    setDrawn((d) => narrowDrawn(d, part, width));
  };
  const fit = lineFit(drawn, Boolean(typing));
  return (
    <Animated.View style={[styles.words, leaving && StyleSheet.absoluteFill, turn]}>
      {agents && fit.agents !== null ? (
        <View style={styles.agents}>
          {piece(agents, [styles.shrink, { maxWidth: fit.agents }], measure("agents"))}
          {sep ? piece(sep) : null}
        </View>
      ) : null}
      {typing ? (
        <View style={styles.people}>
          {piece(typers, [styles.shrink, { maxWidth: fit.typers }], measure("typers"))}
          {piece(typing)}
        </View>
      ) : null}
    </Animated.View>
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
  // Centered on the 32px face (its slot starts 2px down); face, pixels and words one step apart.
  wait: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 11, height: 32, marginTop: 2 },
  waitDots: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 },
  waitDot: { width: 4, height: 4 },
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
  took: { fontVariant: ["tabular-nums"] },
  clock: { fontSize: 12, fontWeight: "600", fontVariant: ["tabular-nums"] },
  sep: { width: StyleSheet.hairlineWidth * 2, height: 16, marginLeft: 4, marginRight: 2 },
  // Last in the pill, in its round end: 2px from the edge all around.
  stop: { width: 24, height: 24, marginRight: -6, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  stopping: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 },
});
