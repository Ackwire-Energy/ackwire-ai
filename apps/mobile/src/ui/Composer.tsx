import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Platform, Text as RNText, ScrollView, StyleSheet, TextInput, type TextStyle, View } from "react-native";
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  ZoomIn,
  ZoomOut,
} from "react-native-reanimated";
import { PixelStop } from "@/agent/PixelMarks";
import { Glass } from "./Glass";
import { haptics } from "./haptics";
import { Icon, type IconName } from "./Icon";
import { PressScale } from "./PressScale";
import { Segmented } from "./Segmented";
import { systemText } from "./Text";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE, weights } from "./type-scale";

/** The "@" being typed and how to finish it (the screen draws the picker). */
export interface ComposerMentionState {
  /** What follows "@" ("th"). */
  query: string;
  /** Replaces "@th" with "@handle " and puts the caret after it. */
  pick: (handle: string) => void;
}

/**
 * How a message goes while an agent works: "join" reaches it at its next pause, "now"
 * makes it stop what it is doing and read the message at once. Without an agent at work it is "join".
 */
export type SendHow = "join" | "now";

/**
 * An agent at work in the conversation: with text, the choice shows (to anyone who writes there); the empty
 * field's button stops it, only for who may stop it (`stop` is left out otherwise).
 */
export interface ComposerWorking {
  stop?: {
    /** The stop button's label ("Parar o Theo"). */
    label: string;
    onStop: () => void;
  };
}

export interface ComposerProps {
  placeholder: string;
  onSend: (text: string, how: SendHow) => void;
  /** Someone is working here (null otherwise). */
  working?: ComposerWorking | null;
  onPlus: () => void;
  /**
   * Pills above the field while it is empty; tapping one puts its `text` (default: the `label`) in the field
   * ("Pedir revisão do Caio" fills "Pede para o Caio revisar antes").
   */
  suggestions?: { icon: IconName; label: string; text?: string }[];
  /** The field's `nativeID` (the chat links it to the keyboard's drag-to-dismiss area). */
  inputNativeID?: string;
  /** A small face inside the empty field, before the placeholder (a DM with an agent: who you write to). */
  face?: ReactNode;
  /** While "@…" is typed right before the caret (and the field is focused): the card above the field. */
  mention?: (state: ComposerMentionState) => ReactNode;
  /** The "@" token at the caret (`mentionQuery`); the composer doesn't know the rules itself. */
  mentionAt?: (text: string, caret: number) => { start: number; query: string } | null;
  /** The text after a pick (`insertMention`). */
  insertMention?: (
    text: string,
    token: { start: number; query: string },
    handle: string,
  ) => { text: string; caret: number };
}

/** The pill's height, the "+" and the send button's. */
const FIELD = 48;
const SEND = 36;
/** Space around the send button inside the pill: it sits centered on the first line. */
const INSET = (FIELD - SEND) / 2;

/**
 * The center of the app: a round glass "+" for attachments and actions,
 * then the field, a raised pill. Empty, it can show who you write to (a small face) before the
 * placeholder; with text, the round ink send button pops in. One line keeps "+", text and send on the
 * same center line; longer text grows the pill upward and everything stays at the bottom.
 *
 * While an agent works: the empty field's button is "Parar" (a rounded square), one
 * tap and it stops, no question asked (what it did stays and can continue); with text, two buttons above
 * the field choose "Juntar ao que está fazendo" (the default) or "Parar e mandar". A light tap on send, a
 * firm one on stop.
 */
export function Composer({
  placeholder,
  onSend,
  working = null,
  onPlus,
  suggestions,
  inputNativeID,
  face,
  mention,
  mentionAt,
  insertMention,
}: ComposerProps) {
  const theme = useTheme();
  const { colors, shadows, reducedMotion } = theme;
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>(undefined);
  const [focused, setFocused] = useState(false);
  const [how, setHow] = useState<SendHow>("join");
  const has = text.trim().length > 0;
  const token = focused && mention && mentionAt ? mentionAt(text, caret) : null;
  const stopMode = Boolean(working?.stop) && !has;
  const button = has || stopMode;
  // The send arrow and the stop square swap in place (one turns away as the other turns in).
  const mode = useSharedValue(stopMode ? 1 : 0);
  useEffect(() => {
    mode.value = reducedMotion ? (stopMode ? 1 : 0) : withSpring(stopMode ? 1 : 0, { damping: 16, stiffness: 320 });
  }, [stopMode, reducedMotion, mode]);
  const sendGlyph = useAnimatedStyle(() => ({
    opacity: 1 - mode.value,
    transform: [{ scale: 1 - 0.6 * mode.value }, { rotate: `${45 * mode.value}deg` }],
  }));
  const stopGlyph = useAnimatedStyle(() => ({
    opacity: mode.value,
    transform: [{ scale: 0.4 + 0.6 * mode.value }, { rotate: `${-45 * (1 - mode.value)}deg` }],
  }));
  // The choice is per message: back to "join" when the agent is done.
  const isWorking = Boolean(working);
  useEffect(() => {
    if (!isWorking) setHow("join");
  }, [isWorking]);

  const put = (next: string, at = next.length) => {
    setText(next);
    setCaret(at);
    setSelection({ start: at, end: at });
  };

  const send = () => {
    const value = text.trim();
    if (!value) return;
    haptics.light();
    onSend(value, working ? how : "join");
    put("", 0);
    setHow("join");
  };

  const press = () => {
    if (has) {
      send();
      return;
    }
    if (!working?.stop) return;
    haptics.firm();
    working.stop.onStop();
  };

  const pick = (handle: string) => {
    if (!token || !insertMention) return;
    haptics.selection();
    const next = insertMention(text, token, handle);
    put(next.text, next.caret);
  };

  return (
    <View>
      {token && mention ? mention({ query: token.query, pick }) : null}
      {suggestions && suggestions.length > 0 && !token && !has ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          style={styles.pillsBleed}
          contentContainerStyle={styles.pills}
        >
          {suggestions.map((s) => (
            <PressScale
              key={s.label}
              onPress={() => put(s.text ?? s.label)}
              accessibilityRole="button"
              style={[styles.pill, { backgroundColor: colors.raised, boxShadow: `${shadows.e1}, ${shadows.top}` }]}
            >
              <View style={styles.pillIn}>
                <Icon name={s.icon} size={14} color={colors.muted} />
                <RNText
                  maxFontSizeMultiplier={CHROME_MAX_SCALE}
                  style={[systemText("subhead", weights.medium), styles.pillText, { color: colors.ink2 }]}
                >
                  {s.label}
                </RNText>
              </View>
            </PressScale>
          ))}
        </ScrollView>
      ) : null}
      {working && has && !token ? (
        <Animated.View
          entering={reducedMotion ? undefined : FadeInDown.duration(200)}
          exiting={reducedMotion ? undefined : FadeOut.duration(120)}
          style={styles.choice}
          accessibilityLabel={t("mobile.composer.choice")}
        >
          <Segmented
            items={[
              { key: "join", label: t("mobile.composer.join"), icon: "join" },
              { key: "now", label: t("mobile.composer.now"), icon: "bolt" },
            ]}
            value={how}
            onChange={(k) => setHow(k === "now" ? "now" : "join")}
          />
        </Animated.View>
      ) : null}
      <View style={styles.row}>
        <PressScale
          to={0.9}
          onPress={onPlus}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.a11y.attach")}
          style={[styles.plus, { boxShadow: `0px 0px 0px 0.5px ${colors.line2}, ${shadows.top}` }]}
        >
          <Glass style={styles.plusGlass} intensity={50}>
            <View style={styles.center}>
              <Icon name="plus" size={22} color={colors.ink2} />
            </View>
          </Glass>
        </PressScale>
        <View
          style={[
            styles.field,
            {
              backgroundColor: colors.raised,
              boxShadow: `0px 0px 0px 0.5px ${colors.line2}, 0px 6px 18px -10px rgba(0, 0, 0, 0.25)`,
              paddingRight: button ? INSET : 14,
            },
          ]}
        >
          {face && !text ? (
            <Animated.View
              entering={reducedMotion ? undefined : FadeIn.duration(140)}
              exiting={reducedMotion ? undefined : FadeOut.duration(100)}
              style={styles.face}
              pointerEvents="none"
            >
              {face}
            </Animated.View>
          ) : null}
          <TextInput
            {...(inputNativeID ? { nativeID: inputNativeID } : {})}
            value={text}
            onChangeText={setText}
            {...(selection ? { selection } : {})}
            onSelectionChange={(e) => {
              setCaret(e.nativeEvent.selection.end);
              if (selection) setSelection(undefined);
            }}
            placeholder={placeholder}
            placeholderTextColor={colors.faint}
            multiline
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            accessibilityLabel={placeholder}
            style={[inputText, { color: colors.ink }]}
          />
          {button ? (
            <Animated.View
              entering={reducedMotion ? undefined : ZoomIn.springify().damping(14).stiffness(320)}
              exiting={reducedMotion ? undefined : ZoomOut.duration(120)}
              style={styles.sendBox}
            >
              <PressScale
                to={0.9}
                haptic={false}
                onPress={press}
                accessibilityRole="button"
                accessibilityLabel={stopMode && working?.stop ? working.stop.label : t("mobile.a11y.send")}
                hitSlop={6}
                style={[styles.send, { backgroundColor: colors.ink }]}
              >
                <Animated.View style={[styles.glyph, sendGlyph]}>
                  <Icon name="send" size={18} color={colors.bg} />
                </Animated.View>
                <Animated.View style={[styles.glyph, stopGlyph]}>
                  <PixelStop size={13} color={colors.bg} moving={stopMode} />
                </Animated.View>
              </PressScale>
            </Animated.View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/**
 * The field's text: one line is exactly the send button's height, so text, "+" and send share a center
 * line. iOS draws a multiline field's `lineHeight` from the top (the text sits low), so there the line
 * keeps the font's own height and the padding centers it; Android centers it itself.
 */
const body = systemText("body");
const inputText: TextStyle = {
  flex: 1,
  minWidth: 0,
  minHeight: SEND,
  maxHeight: 140,
  fontSize: body.fontSize,
  fontWeight: body.fontWeight,
  letterSpacing: body.letterSpacing,
  paddingHorizontal: 0,
  ...Platform.select<TextStyle>({
    ios: { paddingTop: 8, paddingBottom: 8 },
    default: {
      lineHeight: body.lineHeight,
      paddingTop: 7,
      paddingBottom: 7,
      textAlignVertical: "center",
      includeFontPadding: false,
    },
  }),
};

const styles = StyleSheet.create({
  // The row runs to the screen edges (past the composer's own inset) so a long last chip scrolls instead of
  // being cut at the padding.
  pillsBleed: { marginHorizontal: -10 },
  pills: { gap: 6, paddingHorizontal: 14, paddingBottom: 8 },
  pill: { height: 32, borderRadius: 999 },
  pillIn: { flexGrow: 1, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12 },
  pillText: { fontSize: 14, lineHeight: 18 },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  plus: { width: FIELD, height: FIELD, borderRadius: FIELD / 2 },
  plusGlass: { flex: 1, borderRadius: FIELD / 2 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  field: {
    flex: 1,
    minWidth: 0,
    minHeight: FIELD,
    borderRadius: FIELD / 2,
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingVertical: INSET,
    paddingLeft: 14,
  },
  face: { height: SEND, justifyContent: "center" },
  choice: { paddingHorizontal: 4, paddingBottom: 8 },
  sendBox: { width: SEND, height: SEND },
  send: { width: SEND, height: SEND, borderRadius: SEND / 2 },
  glyph: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
});
