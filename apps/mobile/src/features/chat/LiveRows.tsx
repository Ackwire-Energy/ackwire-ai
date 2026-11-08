import { elapsedClock, type LiveConsult, type LiveRun, usesBrowser } from "@agenteschat/client";
import {
  type ActivityEntry,
  activitySentence,
  activityVerb,
  barAsking,
  barElapsed,
  barFaces,
  barWords,
  entriesOffScreen,
  isWriting,
  listNames,
  runElapsed,
  waitsForWords,
} from "@agenteschat/client/lib/activity";
import { initialReveal, rebaseReveal, revealStep } from "@agenteschat/client/lib/reveal";
import { barStep, formatDuration } from "@agenteschat/client/lib/work";
import type { AgentColorName } from "@agenteschat/ui/agent/engine";
import {
  type ComponentRef,
  createContext,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  ZoomIn,
} from "react-native-reanimated";
import { useFrameTime } from "@/agent/live";
import { Dither } from "@/sky/Dither";
import { softTones } from "@/sky/math";
import { CHROME_MAX_SCALE, haptics, Icon, PixelStop, Text, useReducedMotion, useTheme } from "@/ui";
import { AgentFace, AgentWho, Face } from "../shared/Face";
import { useColors, useDirectory, useNow, useWhen } from "../shared/hooks";
import { agentLook } from "../shared/logic";
import type { Measurable } from "./ask-store";
import { ConsultPairRow, useRunConsults } from "./ConsultGroup";
import {
  awayRun,
  CHAT_TEXT_MAX_SCALE,
  chatNameOf,
  chatTimeOf,
  type LineDrawn,
  type LineWords,
  leavingWords,
  lineFit,
  MSG_AVATAR,
  MSG_GAP,
  MSG_INSET,
  markedParts,
  markName,
  nameInk,
  narrowDrawn,
  PHRASE_FADE_MS,
  type PhraseTurn,
  rowFrame,
  turnPhrase,
  workingEntries,
} from "./logic";
import { lookRows, useRhythm, useRowLook } from "./look";
import { MessageText } from "./MessageText";
import { type RowSight, rowsShown } from "./row-sight";
import { TurnTools } from "./ToolCalls";
import {
  fadeTail,
  pruneMarks,
  type RevealMark,
  rememberTurn,
  turnItems,
  turnOpener,
  turnPhase,
  turnShows,
  turnSignature,
  WORD_FADE_MS,
  withOpacity,
} from "./turn";

/**
 * What the conversation's live rows read from their screen: where they say they are drawn (the line above the
 * composer speaks only for those out of view), which of them offers its stop (the web's rule: the latest one here I
 * may stop) and how to stop it.
 */
export interface LiveRowsView {
  sight: RowSight;
  stopRunId: string | undefined;
  onStop: (run: LiveRun) => void;
}

const LiveRowsContext = createContext<LiveRowsView | null>(null);

export const LiveRowsProvider = LiveRowsContext.Provider;

/** The runs whose live rows are on screen, redrawn only when that set changes. */
export const useRowsInView = (sight: RowSight) =>
  useSyncExternalStore(sight.subscribe, sight.getInView, sight.getInView);

/** What the conversation tells the live rows' watch about its list: the requests' band (`AskView`). */
export interface RowView {
  /** The view the list fills: the band is measured from its frame in the window. */
  frame: () => Measurable | null;
  /** The band inside that frame, from its top and from its bottom (the header, the composer); null until placed. */
  insets: () => { top: number; bottom: number } | null;
}

/**
 * Which live rows are on screen, for the line above the composer (the requests' watch, `useAskWatch`): a look is
 * asked for on a scroll (one a frame), on layout, when the list's size changes and when a row is drawn or goes; it
 * measures only the drawn live rows, and the sight publishes only when the set changes. Nothing runs while no row is
 * drawn. Returns the call that asks for a look.
 */
export function useRowWatch(sight: RowSight, view: RowView): () => void {
  const viewRef = useRef(view);
  viewRef.current = view;
  const frame = useRef<number | null>(null);
  const look = useRef(0);
  const watch = useCallback(() => {
    if (frame.current !== null || !sight.hasRows()) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      look.current += 1;
      lookAtRows(sight, viewRef.current, look.current, () => look.current);
    });
  }, [sight]);
  // A row was drawn or went.
  useEffect(() => sight.watch(watch), [sight, watch]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `view.insets` changes when the band's edges move
  useEffect(() => {
    watch();
  }, [watch, view.insets]);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  return watch;
}

/** One look at the drawn live rows against the list's band; a newer look drops an older one's answers. */
function lookAtRows(sight: RowSight, view: RowView, look: number, latest: () => number) {
  const drawn = sight.drawn();
  const insets = view.insets();
  const box = view.frame();
  if (drawn.length === 0 || !insets || !box) return;
  box.measureInWindow((_x, y, _width, height) => {
    if (look !== latest() || !(height > 0)) return;
    const band = { top: y + insets.top, bottom: y + height - insets.bottom };
    const placed: { runId: string; y: number; height: number }[] = [];
    for (const [runId, row] of drawn) {
      row.measureInWindow((_rx, ry, _rw, rh) => {
        placed.push({ runId, y: ry, height: rh });
        if (placed.length === drawn.length && look === latest()) sight.setShown(rowsShown(placed, band));
      });
    }
  });
}

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
  const look = useRowLook();
  const c = useColors();
  const { scheme } = useTheme();
  const bubbled = look.style === "bubbles";
  const compact = look.style === "compact";
  const rhythm = useRhythm();
  const agent = dir.agentById.get(run.agentId);
  const color = agentLook(agent).color;
  const phase = turnPhase(run);
  const live = phase !== "stopped";
  const items = turnItems(run);
  // The first thing it said opens the block, above its tools.
  const { said, lines } = turnOpener(items);
  // At work with no words yet: no row of its own, the line above the composer says who, what, how long, and stops it.
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
  const signature = turnSignature(items);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` stands for the items and their quotes
  useEffect(() => {
    rememberTurn(run.runId, { items: turnItems(run, true), quotes, at: Date.now() });
  }, [run.runId, signature]);
  const [mountedAt] = useState(() => Date.now());
  // Drawn, the row tells the screen, which measures whether it shows: the line above the composer leaves this agent
  // out while it does (the row says its step, its time and its stop) and speaks for it once it doesn't.
  const sight = useContext(LiveRowsContext)?.sight;
  const seen = useCallback(
    (view: ComponentRef<typeof View> | null) => (view && sight ? sight.register(run.runId, view) : undefined),
    [sight, run.runId],
  );
  if (waiting) return pair;
  return (
    <>
      {pair}
      <View
        ref={seen}
        collapsable={false}
        style={[
          styles.msg,
          bubbled && lookRows.bubblesRow,
          compact && lookRows.compactRow,
          rowFrame(rhythm.block, rhythm.turn),
        ]}
      >
        {compact ? <View style={lookRows.compactClock} /> : null}
        {look.faces ? (
          <View style={[styles.avslot, bubbled && lookRows.bubblesSlot, compact && lookRows.compactSlot]}>
            <AgentFace
              agentId={run.agentId}
              size={compact ? 18 : bubbled ? 30 : 34}
              mode={live ? (phase === "writing" ? "run" : "think") : "idle"}
            />
          </View>
        ) : null}
        <View style={[styles.body, { gap: rhythm.part }]}>
          <View>
            <View style={styles.who}>
              {/* A DM drops the name only where a bubble stands under it, as on a saved row. */}
              {!bubbled || look.names || !(said || run.text) ? (
                <Text
                  variant="footnote"
                  tone="ink2"
                  style={[
                    styles.name,
                    look.text ? chatNameOf(look.text) : undefined,
                    bubbled ? { color: nameInk(color, scheme === "dark") } : undefined,
                  ]}
                  numberOfLines={1}
                  maxFontSizeMultiplier={look.text ? CHAT_TEXT_MAX_SCALE : undefined}
                >
                  {agent?.name ?? ""}
                </Text>
              ) : null}
              {/* While it works, the line above the box says so: the block has its start time, as a message (the web's
              `RunClock`); "parado" once stopped. */}
              <View style={styles.state} accessible accessibilityLiveRegion="polite" accessibilityLabel={word}>
                {live ? (
                  <Text
                    variant="footnote"
                    tone="faint"
                    style={look.text ? chatTimeOf(look.text) : undefined}
                    maxFontSizeMultiplier={look.text ? CHAT_TEXT_MAX_SCALE : undefined}
                  >
                    {when.time(new Date(since ?? mountedAt).toISOString())}
                  </Text>
                ) : (
                  <Text variant="footnote" tone="faint" maxFontSizeMultiplier={CHROME_MAX_SCALE}>
                    {word}
                    {took}
                  </Text>
                )}
              </View>
              {/* Its words arriving: its time and its stop after the time it started (the line above the composer no
              longer says them while the row shows). */}
              {live ? <RunTail run={run} now={now} /> : null}
            </View>
            {/* Nothing said and no steps yet: the words stream where the opener stands, so the line it opens
            with stays put when a tool call turns it into narration. */}
            {bubbled && (said || run.text) ? (
              <View style={[lookRows.bubble, { backgroundColor: c.bubble }]}>
                {said && !wordsOnTop ? <MessageText body={said} selectable={false} /> : null}
                {run.text ? <RevealText text={run.text} live={phase === "writing"} accent={color} /> : null}
              </View>
            ) : (
              <>
                {wordsOnTop && run.text ? (
                  <RevealText text={run.text} live={phase === "writing"} accent={color} />
                ) : said ? (
                  <View style={run.text ? { marginBottom: rhythm.part } : undefined}>
                    <MessageText body={said} selectable={false} />
                  </View>
                ) : null}
                {run.text && !wordsOnTop ? (
                  <RevealText text={run.text} live={phase === "writing"} accent={color} />
                ) : null}
              </>
            )}
          </View>
          {/* Its tools last, where its saved reply keeps them. */}
          <TurnTools items={lines} agentName={agent?.name ?? ""} color={color} quoteOf={bodyOf} />
        </View>
      </View>
    </>
  );
});

/**
 * The end of an agent's live row (the web's `RunTail`): "· 12 s" while it works and its stop when it is the run here
 * I'd stop. The line above the composer says neither while the row shows, so they sit where the eye already is. The
 * clock keeps its room from the start, so the stop never shifts when the seconds appear.
 */
function RunTail({ run, now }: { run: LiveRun; now: number }) {
  const { t } = useTranslation();
  const rows = useContext(LiveRowsContext);
  const atWork = run.status === "thinking" || run.status === "queued" || run.status === "running";
  const stops = rows?.stopRunId === run.runId ? [run] : [];
  if (!atWork && stops.length === 0) return null;
  const took = atWork ? runElapsed(t, run, now) : null;
  return (
    <View style={styles.tail}>
      {atWork ? (
        <Text
          variant="footnote"
          tone="faint"
          numberOfLines={1}
          maxFontSizeMultiplier={CHROME_MAX_SCALE}
          style={styles.tailClock}
        >
          {took ? `· ${took}` : ""}
        </Text>
      ) : null}
      {rows ? <LineStop runs={stops} onStop={rows.onStop} rule={false} place="row" /> : null}
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
 * agents work; a few small faces, each on a plate and popping in (an agent on its own asking another shows
 * both, with an arrow; three dots first while only people type); one line with names in ink, crossfading
 * whenever it changes ("Theo e mais 2 estão trabalhando · Marina está digitando…"); the clock of a question
 * that is out. An agent whose live row is on screen is left out: the row says its step, its time and its stop,
 * once. Its row out of view, the line speaks for it: its face, the row's step after its name with its time right
 * after it ("16 s"), whoever types beside it, then "Ver" (back to the row). It has no stop of its own: the box's,
 * right under it, is the one.
 * Nothing moves with Reduce Motion or off screen.
 */
export function WorkingLine({
  runs,
  consults,
  typing,
  onOpenBrowser,
  sight,
  onSee,
  stop,
}: {
  runs: LiveRun[];
  consults: LiveConsult[];
  /** The people typing here (never me). */
  typing: string[];
  /** An agent in its browser: tapping the line opens its card in the conversation. */
  onOpenBrowser?: (agentId: string) => void;
  /** Which agents' live rows are on screen: the line leaves those out. */
  sight: RowSight;
  /** "Ver": back to the live row of the agent the line speaks for. */
  onSee: (run: LiveRun) => void;
  /**
   * "Parar", the word, last in the line: the runs here the person may stop. The line is the one place that stops
   * (the composer keeps only its send), so the state and its action read together.
   */
  stop?: { runs: LiveRun[]; onStop: (run: LiveRun) => void } | undefined;
}) {
  const { t, i18n } = useTranslation();
  const dir = useDirectory();
  const { colors: c, shadows } = useTheme();
  const reduced = useReducedMotion();
  const inView = useRowsInView(sight);
  const rowInView = (r: LiveRun) => inView.has(r.runId);
  const agentName = (id: string) => dir.agentById.get(id)?.name ?? t("channel.unknownAgent");
  // Its row on screen says what it does, for how long and how to stop it: the line leaves that agent out (a row not
  // drawn yet is out of view).
  const entries = entriesOffScreen(
    workingEntries(runs, consults, agentName, typing, (id) => dir.memberById.get(id)?.name),
    runs,
    rowInView,
  );
  const asking = barAsking(entries);
  const agents = entries.filter((e) => e.type === "agent");
  const lead = agents[0];
  // The time is one agent's: with several at work the line can't say whose.
  const solo = agents.length === 1 ? lead : undefined;
  // One clock for the time and a question's clock, moving each second while one counts: a redraw in between (the
  // phrase turning, an event) reads the same second, so both step evenly; narrowing to one agent changes the pace, and a
  // new pace reads the clock afresh (`useNow`).
  const now = useNow(asking || solo ? 1000 : 60_000);
  if (entries.length === 0) return null;
  // The one agent it speaks for with its row out of view; a question it asks keeps its own phrase.
  const away = awayRun(entries, runs, rowInView);
  const step = away && lead && !lead.consult ? barStep(t, away, i18n.language, now) : null;
  const color = lead ? agentLook(dir.agentById.get(lead.id)).color : null;
  const took = away ? barElapsed(t, entries, runs, now) : null;
  // Who types beside that agent, after its time ("· Marina digitando…"): the names give way first, never what they do.
  const people = entries.flatMap((e) => (e.type === "person" ? [e.name] : []));
  const typers = step !== null && people.length > 0 ? listNames(t, people, markName) : null;
  const typingWord = `${activityVerb(t, { kind: "typing" })}…`;
  const awayWords = [`${markName(lead?.name ?? "")} ${step}`, took, typers && `${typers} ${typingWord}`];
  const sentence = step !== null ? awayWords.filter(Boolean).join(" · ") : activitySentence(t, entries, markName);
  const label = markedParts(sentence)
    .map((p) => p.text)
    .join("");
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
            <AgentWho agentId={p.agentId} name={p.text} size={13} lead={i === 0} />
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
  // The agents here are the ones whose rows are out of view: their faces open the pill.
  const faces = barFaces(entries);
  // An agent working in its browser: the line says so, and a tap opens its browser card in the conversation.
  const browsing = browsingRuns(runs)[0];
  const openBrowser = browsing && onOpenBrowser ? () => onOpenBrowser(browsing.agentId) : undefined;
  // "Ver" once its row is in the conversation (before that, there is nothing to go back to).
  const seeable = away && turnShows(away) ? away : undefined;
  // The line stops only the agents it speaks for: a row on screen has its own stop at its end.
  const stopHere = stop ? stop.runs.filter((r) => !rowInView(r)) : [];
  // Back to the row is a scroll, so no haptic.
  const see = () => {
    if (seeable) onSee(seeable);
  };
  return (
    <View style={styles.dock}>
      <Animated.View
        // In and out on an ease-out, under 200 ms: the line is chrome that comes and goes many times a day.
        entering={reduced ? undefined : LINE_IN}
        exiting={reduced ? undefined : LINE_OUT}
        style={[styles.pill, { backgroundColor: c.glassSolid, boxShadow: `${shadows.e1}, ${shadows.top}` }]}
        accessibilityLiveRegion="polite"
      >
        {color ? (
          <Dither kind="sweep" tones={softTones(color, c.raised)} pixel={3} style={StyleSheet.absoluteFill} />
        ) : null}
        {color ? null : <TypingDots color={c.muted} />}
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
                  <Icon name="right" size={12} color={c.faint} />
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
        {/* The words, read as one (its "Ver" is a button of its own). An agent in its browser:
            tapping opens it live. */}
        <Pressable
          disabled={!browsing}
          onPress={openBrowser}
          accessible
          accessibilityRole={browsing ? "button" : "text"}
          accessibilityLabel={browsing ? `${label}. ${t("browser.watch.open")}` : label}
          style={({ pressed }) => [styles.wordsTap, pressed && styles.pressed]}
        >
          {step !== null && lead ? (
            <AwayStep name={lead.name} step={step} reduced={reduced} />
          ) : (
            <TurningWords entries={entries} piece={piece} reduced={reduced} />
          )}
          {took ? (
            <Text variant="caption" tone="faint" maxFontSizeMultiplier={CHROME_MAX_SCALE} style={styles.took}>
              · {took}
            </Text>
          ) : null}
          {typers ? (
            <View style={styles.also}>
              {piece(`· ${typers}`, styles.shrink)}
              {piece(` ${typingWord}`)}
            </View>
          ) : null}
          {browsing ? (
            <View style={[styles.browser, { backgroundColor: c.raised }]}>
              <Icon name="globe" size={12} color={c.ink2} />
            </View>
          ) : null}
        </Pressable>
        {clock ? (
          <Text
            variant="caption"
            tone="muted"
            accessibilityLabel={t("chat.consult.clock", { time: clock })}
            style={styles.clock}
          >
            {clock}
          </Text>
        ) : null}
        {seeable ? (
          <>
            <View style={[styles.sep, { backgroundColor: c.line }]} />
            <Pressable
              onPress={see}
              accessibilityRole="button"
              accessibilityLabel={`${t("run.strip.see")} · ${lead?.name ?? ""}`}
              // A 16-point word in a 28-point pill: 14 above and below makes the 44 a finger needs.
              hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <Text variant="caption" tone="ink" maxFontSizeMultiplier={CHROME_MAX_SCALE} style={styles.ink}>
                {t("run.strip.see")}
              </Text>
            </Pressable>
          </>
        ) : null}
        {/* "Parar" as a word, last: the one stop on screen while the rows are out of view (the row's tail has its own
            while it shows; the composer keeps only its send). */}
        {stop && stopHere.length > 0 ? <LineStop runs={stopHere} onStop={stop.onStop} place="word" /> : null}
      </Animated.View>
    </View>
  );
}

const LINE_EASE = Easing.bezier(0.23, 1, 0.32, 1);
const LINE_IN = FadeIn.duration(160).easing(LINE_EASE);
const LINE_OUT = FadeOut.duration(120).easing(LINE_EASE);

/**
 * "Parar": last in the requests' line's pill after a thin rule (while it takes the working line's place), or at the
 * end of the agent's live row (`place="row"`, no rule). One tap stops the agent, nothing asked, and "Parando…" while
 * it stops (in the row only its spinner, so the line keeps its width). 24 points drawn, 44 to the finger.
 */
export function LineStop({
  runs,
  onStop,
  rule = true,
  place = "line",
}: {
  runs: LiveRun[];
  onStop: (run: LiveRun) => void;
  /** The thin rule before it (left out after "Ver", which has its own, and in the row). */
  rule?: boolean;
  /** `word`: "Parar" written out, at the end of the working line (one word for every run it stops). */
  place?: "line" | "row" | "word";
}) {
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
  if (place === "word") {
    const stopping = runs.some((r) => r.stopping);
    const live = runs.filter((r) => !r.stopping);
    return (
      <>
        {rule ? <View style={[styles.sep, { backgroundColor: c.line }]} /> : null}
        {stopping && live.length === 0 ? (
          <View style={styles.stopping} accessible accessibilityLabel={t("run.stopping")}>
            <ActivityIndicator size="small" color={c.muted} />
          </View>
        ) : (
          <Pressable
            onPress={() => {
              for (const r of live) stopNow(r);
            }}
            accessibilityRole="button"
            accessibilityLabel={live.map((r) => `${t("run.stop")} · ${nameOf(r)}`).join(", ")}
            // A 16-point word in a 28-point pill: 14 above and below makes the 44 a finger needs.
            hitSlop={{ top: 14, bottom: 14, left: 8, right: 8 }}
            style={({ pressed }) => pressed && styles.pressed}
          >
            {({ pressed }) => (
              <Text
                variant="caption"
                maxFontSizeMultiplier={CHROME_MAX_SCALE}
                style={[styles.ink, { color: pressed ? c.danger : c.ink }]}
              >
                {t("run.stop")}
              </Text>
            )}
          </Pressable>
        )}
      </>
    );
  }
  const inRow = place === "row";
  const shape = inRow ? styles.rowStop : styles.stop;
  return (
    <>
      {rule ? <View style={[styles.sep, { backgroundColor: c.line }]} /> : null}
      {runs.map((r) =>
        r.stopping ? (
          <View
            key={r.runId}
            style={inRow ? styles.rowStop : styles.stopping}
            accessible
            accessibilityLabel={t("run.stopping")}
          >
            <ActivityIndicator size="small" color={c.muted} />
            {inRow ? null : (
              <Text variant="caption" tone="muted">
                {t("run.stopping")}
              </Text>
            )}
          </View>
        ) : (
          <Pressable
            key={r.runId}
            onPress={() => stopNow(r)}
            accessibilityRole="button"
            accessibilityLabel={`${t("run.stop")} · ${nameOf(r)}`}
            hitSlop={10}
            style={({ pressed }) => [shape, pressed && { backgroundColor: `${c.danger}1F` }]}
          >
            {({ pressed }) => <PixelStop size={11} color={pressed ? c.danger : c.muted} />}
          </Pressable>
        ),
      )}
    </>
  );
}

type LinePiece = (text: string, style?: StyleProp<TextStyle>, onTextLayout?: (e: TextLayoutEvent) => void) => ReactNode;

/**
 * One agent whose row is out of view, as the web's `BarStep`: its name in ink and its row's step ("Nina consultando
 * o Email · …"), cut with "…" when the line is short of room, its time right after it; each new step fades in (a plain swap with Reduce Motion). The line's label says the whole step.
 */
function AwayStep({ name, step, reduced }: { name: string; step: string; reduced: boolean }) {
  return (
    <View style={styles.awayStep}>
      <Text
        variant="caption"
        tone="ink"
        numberOfLines={1}
        maxFontSizeMultiplier={CHROME_MAX_SCALE}
        style={[styles.ink, styles.awayName]}
      >
        {name}
      </Text>
      <Animated.View key={step} entering={reduced ? undefined : FadeIn.duration(160)} style={styles.barStep}>
        <Text variant="caption" tone="muted" numberOfLines={1} maxFontSizeMultiplier={CHROME_MAX_SCALE}>
          {step}
        </Text>
      </Animated.View>
    </View>
  );
}

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
  msg: {
    flexDirection: "row",
    gap: MSG_GAP,
    paddingLeft: MSG_INSET,
    paddingRight: 16,
  },
  avslot: { width: MSG_AVATAR, alignItems: "center", paddingTop: 2 },
  body: { flex: 1, minWidth: 0 },
  // The row's end: "· 12 s" and the stop. The clock keeps room for its seconds, and the stop never raises the line it
  // ends (24 points drawn in a 16-point line).
  tail: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 },
  tailClock: { minWidth: 44, fontVariant: ["tabular-nums"] },
  rowStop: {
    width: 24,
    height: 24,
    marginVertical: -4,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
  },
  who: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4, minHeight: 19 },
  name: { fontWeight: "600", fontSize: 14, lineHeight: 19, flexShrink: 1 },
  state: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 },
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
  overlap: { marginLeft: -6 },
  dots: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 },
  dot: { width: 4, height: 4, borderRadius: 2 },
  // The words take what the marks and the stop leave, so the globe after them stays put while they turn. Who is
  // typing keeps its width: the agents' words before it end in "…" first (the " · " after them goes with their
  // last bit, so it never opens the line), then the names, never what they do.
  words: { flex: 1, flexDirection: "row" },
  agents: { flexDirection: "row", flexShrink: 1, overflow: "hidden" },
  people: { flexDirection: "row", maxWidth: "100%" },
  shrink: { flexShrink: 1 },
  // One agent out of view: its name, then its row's step (cut with "…" on a narrow screen).
  awayStep: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1, minWidth: 0 },
  awayName: { flexShrink: 0, maxWidth: 120 },
  // Its own width, so the time follows the words instead of floating after a fixed gap.
  barStep: { flexShrink: 1, minWidth: 0 },
  // Who types beside it, after its time: it gives way before the step does, its names first.
  also: { flexDirection: "row", flexShrink: 4, minWidth: 0 },
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
  clock: { fontWeight: "600", fontVariant: ["tabular-nums"] },
  pressed: { opacity: 0.6 },
  sep: { width: StyleSheet.hairlineWidth * 2, height: 16, marginLeft: 4, marginRight: 2 },
  // Last in the pill, in its round end: 2px from the edge all around.
  stop: { width: 24, height: 24, marginRight: -6, borderRadius: 999, alignItems: "center", justifyContent: "center" },
  stopping: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 4 },
});
