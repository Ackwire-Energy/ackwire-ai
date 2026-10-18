import { type NativeStackNavigationOptions, Stack, useIsFocused } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { type ReactElement, type ReactNode, useMemo } from "react";
import { Platform, type RefreshControlProps, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { LivePause } from "@/agent/live";
import { progress } from "@/lib/parallax";
import { CoverBarBackdrop, FadingHeaderTitle, useCoverScroll, useScrollFade } from "./cover";
import { type HeaderAction, useHeaderActionOptions } from "./headerActions";
import { Text } from "./Text";
import { useTheme } from "./theme";

export interface LargeTitleScreenProps {
  title: string;
  /** A line under the large title (it scrolls with the content). */
  subtitle?: string;
  /** Buttons in the bar (native bar buttons on iOS). */
  actions?: HeaderAction[];
  /** The bar's leading item (the person's avatar, which opens Você). */
  left?: ReactNode;
  /** Native buttons on the bar's leading side (iOS). */
  leftActions?: HeaderAction[];
  /**
   * Revealed above the content when the list is pulled down (it sits above the first row, outside the
   * content, so only the bounce shows it; iOS only, where scroll views bounce). `pullDownHeight` is its
   * height.
   */
  pullDown?: ReactNode;
  pullDownHeight?: number;
  children?: ReactNode;
  refreshControl?: ReactElement<RefreshControlProps>;
  /** Room under the content (default 24; the system already keeps content clear of the tab bar). */
  bottomInset?: number;
}

/**
 * A tab's root screen (Conversas, Agentes, Atividade): the large title in Funnel Display is part of the
 * content and scrolls away with it; the bar's own title fades in as it goes (like Mail's, and like the
 * prototype). We draw it rather than using the native large title: on iOS 26 inside the system tabs the
 * native one stayed expanded while the list scrolled under it. The bar is clear over the large title and
 * turns into the system glass (iOS 26 scroll edge; a blur before; opaque on Android) once content passes
 * under it. Agents inside stop moving while the screen is not showing.
 */
export function LargeTitleScreen({
  title,
  subtitle,
  actions,
  left,
  leftActions,
  pullDown,
  pullDownHeight = 0,
  children,
  refreshControl,
  bottomInset = 24,
}: LargeTitleScreenProps) {
  const { colors } = useTheme();
  const focused = useIsFocused();
  const headerHeight = useHeaderHeight();
  // iOS insets the scroll view by the clear bar (it rests at minus the header height); Android lays it out
  // from the top of the screen, under the bar.
  const { y, onScroll } = useCoverScroll(IOS ? headerHeight : 0);
  const titleFade = useScrollFade(y, 0, TITLE_GONE);
  // The pull-down header sits above the first row, and on iOS the clear bar lies over that strip: at rest
  // it must not show behind the bar. It appears only as the list is pulled past rest (y < 0).
  const pullReveal = useAnimatedStyle(() => ({ opacity: progress(-y.value, PULL_FROM, PULL_TO) }));
  const actionOptions = useHeaderActionOptions({ right: actions, left, leftActions });
  // Stable options: `setOptions` runs when the title or the actions change, not on every render.
  const options = useMemo<NativeStackNavigationOptions>(
    () => ({
      ...actionOptions,
      title,
      headerTitle: () => <FadingHeaderTitle y={y} from={BAR_TITLE_FROM} to={BAR_TITLE_TO} text={title} />,
    }),
    [actionOptions, title, y],
  );
  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={options} />
      <LivePause paused={!focused}>
        <Animated.ScrollView
          onScroll={onScroll}
          scrollEventThrottle={16}
          refreshControl={refreshControl}
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingTop: IOS ? 0 : headerHeight, paddingBottom: bottomInset }}
        >
          {pullDown && IOS ? (
            <Animated.View
              style={[styles.pullDown, { top: -pullDownHeight, height: pullDownHeight }, pullReveal]}
              pointerEvents="box-none"
            >
              {pullDown}
            </Animated.View>
          ) : null}
          <Animated.View style={[styles.head, titleFade]}>
            <Text variant="display" accessibilityRole="header" numberOfLines={1}>
              {title}
            </Text>
            {subtitle ? (
              <Text variant="small" tone="muted" style={styles.subtitle}>
                {subtitle}
              </Text>
            ) : null}
          </Animated.View>
          {children}
        </Animated.ScrollView>
      </LivePause>
      <CoverBarBackdrop y={y} from={0} to={12} height={headerHeight} />
    </View>
  );
}

const IOS = Platform.OS === "ios";

/** Scroll (from rest) by which the large title has faded out under the bar. */
const TITLE_GONE = 40;
/** The bar's title fades in over this stretch, as the large title leaves. */
const BAR_TITLE_FROM = 28;
const BAR_TITLE_TO = 48;
/** The pull-down header fades in over this much pull past rest (hidden at rest). */
const PULL_FROM = 4;
const PULL_TO = 72;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  head: { paddingHorizontal: 20, paddingTop: 2, paddingBottom: 10 },
  subtitle: { marginTop: 2 },
  pullDown: { position: "absolute", left: 0, right: 0, overflow: "hidden" },
});
