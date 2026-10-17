import { useIsFocused } from "expo-router";
import type { ReactElement, ReactNode } from "react";
import { type RefreshControlProps, Text as RNText, StyleSheet, View } from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LivePause } from "@/agent/live";
import { Glass } from "./Glass";
import { useTheme } from "./theme";

export interface LargeTitleScreenProps {
  title: string;
  subtitle?: string;
  headerRight?: ReactNode;
  headerLeft?: ReactNode;
  children?: ReactNode;
  refreshControl?: ReactElement<RefreshControlProps>;
  /** Room under the content (default 110: the tab bar). */
  bottomInset?: number;
}

/** Where the large title has scrolled away and the bar turns to glass (points). */
const COLLAPSE_FROM = 28;
const COLLAPSE_TO = 52;

/**
 * An iOS-style screen: a large title in Funnel Display Light that scrolls away, and a nav bar that turns
 * to glass with the small title once it has. Agents inside stop moving while the screen is not showing.
 */
export function LargeTitleScreen({
  title,
  subtitle,
  headerRight,
  headerLeft,
  children,
  refreshControl,
  bottomInset = 110,
}: LargeTitleScreenProps) {
  const { colors, fonts } = useTheme();
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const y = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    y.value = e.contentOffset.y;
  });
  const barStyle = useAnimatedStyle(() => ({
    opacity: interpolate(y.value, [COLLAPSE_FROM, COLLAPSE_TO], [0, 1], Extrapolation.CLAMP),
  }));
  const smallTitle = useAnimatedStyle(() => {
    const k = interpolate(y.value, [COLLAPSE_FROM, COLLAPSE_TO], [0, 1], Extrapolation.CLAMP);
    return { opacity: k, transform: [{ translateY: 4 * (1 - k) }] };
  });
  const barHeight = insets.top + 44;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <LivePause paused={!focused}>
        <Animated.ScrollView
          onScroll={onScroll}
          scrollEventThrottle={16}
          refreshControl={refreshControl}
          contentContainerStyle={{ paddingTop: barHeight, paddingBottom: insets.bottom + bottomInset }}
          contentInsetAdjustmentBehavior="never"
        >
          <View style={styles.big}>
            <RNText
              accessibilityRole="header"
              style={{
                fontFamily: fonts.display,
                fontSize: 34,
                lineHeight: 37,
                letterSpacing: -0.68,
                color: colors.ink,
              }}
            >
              {title}
            </RNText>
            {subtitle ? (
              <RNText
                style={{ fontFamily: fonts.sans, fontSize: 14, lineHeight: 19, color: colors.muted, marginTop: 4 }}
              >
                {subtitle}
              </RNText>
            ) : null}
          </View>
          {children}
        </Animated.ScrollView>
      </LivePause>
      <View style={[styles.bar, { height: barHeight, paddingTop: insets.top }]} pointerEvents="box-none">
        <Animated.View style={[StyleSheet.absoluteFill, barStyle]} pointerEvents="none">
          <Glass intensity={60} style={StyleSheet.absoluteFill} />
          <View style={[styles.hairline, { backgroundColor: colors.line }]} />
        </Animated.View>
        <View style={styles.side}>{headerLeft}</View>
        <Animated.Text
          numberOfLines={1}
          style={[styles.small, { fontFamily: fonts.semibold, color: colors.ink, top: insets.top + 12 }, smallTitle]}
          pointerEvents="none"
        >
          {title}
        </Animated.Text>
        <View style={[styles.side, { justifyContent: "flex-end" }]}>{headerRight}</View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  big: { paddingHorizontal: 20, paddingTop: 2, paddingBottom: 14 },
  bar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 10,
  },
  side: { flexDirection: "row", alignItems: "center", gap: 4, minWidth: 40 },
  small: { position: "absolute", left: 70, right: 70, textAlign: "center", fontSize: 16 },
  hairline: { position: "absolute", left: 0, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
});
