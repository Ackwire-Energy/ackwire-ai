import { type ReactNode, useRef } from "react";
import { Pressable, StyleSheet } from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
  SwipeDirection,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import Animated, { interpolate, type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import { haptics } from "./haptics";
import { Icon, type IconName } from "./Icon";
import { Text } from "./Text";

/** What a swipe does: its word and icon on the pane, the pane's color and the word's color on it. */
export interface SwipeAction {
  label: string;
  icon: IconName;
  color: string;
  ink: string;
  onAction: () => void;
}

/** The pane's width: the row opens this far, and letting go past half of it does the action. */
const PANE = 92;

/**
 * A list row that swipes to an action, as the system's lists do: the row follows the finger (on the UI thread),
 * revealing the action's color under all of it and its pane with the icon and the word, always whole; letting go
 * past half the pane does it (a tap on the pane too), with a light tap, and the row slides back. `left` is revealed
 * by swiping right, `right` by swiping left. The row's content must be opaque (it covers the panes).
 */
export function SwipeRow({
  left,
  right,
  children,
}: {
  left?: SwipeAction | undefined;
  right?: SwipeAction | undefined;
  children: ReactNode;
}) {
  const ref = useRef<SwipeableMethods>(null);
  const run = (action: SwipeAction | undefined) => {
    ref.current?.close();
    if (!action) return;
    haptics.light();
    action.onAction();
  };
  const pane = (action: SwipeAction | undefined) =>
    action
      ? (progress: SharedValue<number>) => <Pane action={action} progress={progress} onPress={() => run(action)} />
      : undefined;
  const renderLeft = pane(left);
  const renderRight = pane(right);
  return (
    <ReanimatedSwipeable
      ref={ref}
      friction={1}
      overshootFriction={8}
      leftThreshold={PANE / 2}
      rightThreshold={PANE / 2}
      {...(renderLeft ? { renderLeftActions: renderLeft } : {})}
      {...(renderRight ? { renderRightActions: renderRight } : {})}
      // Opened past the threshold: the swipe was the action (the row moved right: the left pane's).
      onSwipeableOpen={(direction) => run(direction === SwipeDirection.RIGHT ? left : right)}
    >
      {children}
    </ReanimatedSwipeable>
  );
}

/** One side's pane: the action's color under the whole row (only while its side shows) and its word at the edge. */
function Pane({
  action,
  progress,
  onPress,
}: {
  action: SwipeAction;
  progress: SharedValue<number>;
  onPress: () => void;
}) {
  const shown = useAnimatedStyle(() => ({ opacity: progress.value > 0 ? 1 : 0 }));
  // The icon and the word grow in as the pane opens.
  const grow = useAnimatedStyle(() => {
    const k = Math.min(1, progress.value);
    return {
      opacity: interpolate(k, [0, 0.5, 1], [0, 0.6, 1]),
      transform: [{ scale: interpolate(k, [0, 1], [0.7, 1]) }],
    };
  });
  return (
    <>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: action.color }, shown]} />
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={action.label}
        style={({ pressed }) => [styles.pane, pressed ? { opacity: 0.6 } : null]}
      >
        <Animated.View style={[styles.in, grow]}>
          <Icon name={action.icon} size={20} color={action.ink} />
          <Text variant="caption" numberOfLines={1} style={[styles.word, { color: action.ink }]}>
            {action.label}
          </Text>
        </Animated.View>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  pane: { width: PANE, alignItems: "center", justifyContent: "center" },
  in: { alignItems: "center", gap: 4 },
  word: { fontWeight: "600" },
});
