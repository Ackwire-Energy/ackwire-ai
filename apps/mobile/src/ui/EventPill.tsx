import { Children, Fragment, isValidElement, type ReactNode, useState } from "react";
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Pressable,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import { haptics } from "./haptics";
import { Icon, type IconName } from "./Icon";
import { LineIcon } from "./LineIcon";
import { Text } from "./Text";
import { useTheme } from "./theme";
import { CHROME_MAX_SCALE } from "./type-scale";

/** The sentence's size: a hair under the messages' words, so the event reads as the conversation's, not a voice. */
const WORDS = { fontSize: 14, lineHeight: 19 } as const;
const MARK = 14;
/** The small controls' corner, cut at the bottom left (the app's "cut corner"). */
const RADIUS = 10;
const CUT = 3;
/** Narrower than this beside its actions, the sentence would be a sliver: the actions go under it, in the frame. */
const MIN_WORDS = 170;

export interface EventPillProps {
  /** The event's mark, quiet: an icon's name (drawn faint), or a node of its own (a pixel mark). */
  mark: IconName | ReactNode;
  /** The mark's color when it is an icon (faint by default; a decided request's check in green). */
  markColor?: string;
  /** One sentence: what happened ("You stopped Ada", "Routine «Sentry» delivered a report"). It wraps. */
  children: ReactNode;
  /** When it happened, after the sentence ("14:16", "4 nov"). */
  time?: string;
  /** Its `EventPillAction`s (a list or a fragment; empty ones left out), inside the frame, each after a hairline. */
  actions?: ReactNode;
  /** Under the frame, never inside it: the opened text (`EventPillText`), a reason's field. */
  below?: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/**
 * An automatic event of a conversation (an agent stopped, a follow-up set, a routine's report, a decided request) as
 * one object: a thin frame holding the sentence, its time and what can be done about it. Never a voice, never a
 * card: no fill, one hairline, the small controls' corner cut at the bottom left; left aligned where the caller puts
 * it (the messages' text column). What opens text is an action like the others, with a chevron that turns.
 */
export function EventPill({ mark, markColor, children, time, actions, below, style }: EventPillProps) {
  const { colors: c } = useTheme();
  // On a phone two actions beside a sentence leave it no room: then they go on a row of their own, in the frame.
  const [room, setRoom] = useState(0);
  const [actionsWidth, setActionsWidth] = useState(0);
  const list = actionsOf(actions);
  const stacked = list.length > 0 && room > 0 && actionsWidth > 0 && room - actionsWidth < MIN_WORDS;
  const markNode =
    typeof mark === "string" ? (
      <LineIcon name={mark as IconName} size={MARK} color={markColor ?? c.faint} variant="small" text={WORDS} />
    ) : (
      <LineIcon size={MARK} variant="small" text={WORDS}>
        {mark}
      </LineIcon>
    );
  return (
    <View style={[styles.pill, style]} onLayout={(e: LayoutChangeEvent) => setRoom(e.nativeEvent.layout.width)}>
      <View style={[styles.frame, stacked ? styles.frameStacked : null, { borderColor: c.line2 }]}>
        <View style={[styles.main, stacked ? null : styles.mainBeside]}>
          {markNode}
          <Text variant="small" tone="ink2" style={[WORDS, styles.words]}>
            {children}
          </Text>
          {time ? (
            <Text variant="caption" tone="faint" maxFontSizeMultiplier={CHROME_MAX_SCALE} style={styles.time}>
              {time}
            </Text>
          ) : null}
        </View>
        {list.length > 0 ? (
          <View style={stacked ? [styles.under, { borderTopColor: c.line }] : styles.beside}>
            <View
              style={styles.actions}
              // Its own width, beside the sentence or under it: the measure that decides where it goes.
              onLayout={(e: LayoutChangeEvent) => setActionsWidth(e.nativeEvent.layout.width)}
            >
              {list.map((action, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the actions in order, each after its hairline
                <Fragment key={i}>
                  {/* A hairline before each; under the sentence, the first starts at the frame's edge. */}
                  {stacked && i === 0 ? null : <View style={[styles.rule, { backgroundColor: c.line }]} />}
                  {action}
                </Fragment>
              ))}
            </View>
          </View>
        ) : null}
      </View>
      {below}
    </View>
  );
}

/** The actions one by one: a fragment's own children, never the fragment as one. */
function actionsOf(actions: ReactNode): ReactNode[] {
  return Children.toArray(actions).flatMap((a) =>
    isValidElement<{ children?: ReactNode }>(a) && a.type === Fragment ? actionsOf(a.props.children) : [a],
  );
}

export interface EventPillActionProps {
  label: string;
  onPress: () => void;
  /** Before the label ("play" on Continue). */
  lead?: IconName;
  disabled?: boolean;
  /** Working on it: a spinner in the lead's place, and it can't be pressed again meanwhile. */
  loading?: boolean;
  /** It opens text under the pill ("Show", "See details"): a chevron after the label, turned while open. */
  expanded?: boolean;
  accessibilityHint?: string;
}

/** One action inside an `EventPill` ("Continue", "Add a reason", "Cancel", "Show"), after a hairline. */
export function EventPillAction({
  label,
  onPress,
  lead,
  disabled = false,
  loading = false,
  expanded,
  accessibilityHint,
}: EventPillActionProps) {
  const { colors: c } = useTheme();
  const opens = expanded !== undefined;
  return (
    <Pressable
      onPress={() => {
        haptics.light();
        onPress();
      }}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || loading, busy: loading, expanded: opens ? expanded : undefined }}
      // The frame is 32 points tall: the slop gives a finger its 44.
      hitSlop={{ top: 6, bottom: 6 }}
      style={({ pressed }) => [
        styles.action,
        pressed ? { backgroundColor: c.plate } : null,
        disabled || loading ? styles.dim : null,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={c.ink2} style={styles.spinner} />
      ) : lead ? (
        <Icon name={lead} size={12} color={c.ink2} />
      ) : null}
      <Text
        variant="footnote"
        tone="ink2"
        numberOfLines={1}
        maxFontSizeMultiplier={CHROME_MAX_SCALE}
        style={styles.label}
      >
        {label}
      </Text>
      {opens ? (
        <View style={expanded ? styles.turned : undefined}>
          <Icon name="right" size={12} color={c.faint} />
        </View>
      ) : null}
    </Pressable>
  );
}

/** The text an `EventPill` opens, under its frame: the conversation's quiet rule on its left. */
export function EventPillText({ children }: { children: ReactNode }) {
  const { colors: c } = useTheme();
  return <View style={[styles.text, { borderLeftColor: c.line }]}>{children}</View>;
}

const styles = StyleSheet.create({
  pill: { alignSelf: "stretch", alignItems: "flex-start", gap: 4 },
  frame: {
    flexDirection: "row",
    alignItems: "stretch",
    maxWidth: "100%",
    minHeight: 32,
    borderWidth: 1,
    borderTopLeftRadius: RADIUS,
    borderTopRightRadius: RADIUS,
    borderBottomRightRadius: RADIUS,
    borderBottomLeftRadius: CUT,
    // The pressed plate stays inside the corners.
    overflow: "hidden",
  },
  frameStacked: { flexDirection: "column" },
  // The mark and the time on the sentence's first line when it wraps.
  main: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingTop: 6,
    paddingBottom: 6,
    paddingLeft: 10,
    paddingRight: 12,
  },
  mainBeside: { flexShrink: 1, minWidth: 0 },
  words: { flexShrink: 1, minWidth: 0 },
  time: { lineHeight: WORDS.lineHeight, fontVariant: ["tabular-nums"] },
  beside: { flexShrink: 0, flexDirection: "row" },
  // Under the sentence: a hairline across the frame, the actions from its left.
  under: { borderTopWidth: 1, alignItems: "flex-start" },
  actions: { flexDirection: "row", alignItems: "stretch", minHeight: 30 },
  rule: { width: 1 },
  action: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12 },
  label: { fontSize: 13, fontWeight: "600" },
  spinner: { transform: [{ scale: 0.7 }] },
  dim: { opacity: 0.6 },
  turned: { transform: [{ rotate: "90deg" }] },
  text: { marginLeft: 10, paddingLeft: 12, borderLeftWidth: 2 },
});
