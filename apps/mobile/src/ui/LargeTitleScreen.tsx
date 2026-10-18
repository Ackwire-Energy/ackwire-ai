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
   * Revealed above the content when the list is pulled down, bottom first, only in the strip the
   * overscroll opens under the bar (below the refresh spinner's room); iOS only, where scroll views
   * bounce. `pullDownHeight` is its height.
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
  // The pull-down header lives only in the strip the overscroll reveals: between the bar's bottom edge
  // (where the content rests, y = 0) and the content's top, less the room at the top where the refresh
  // spinner turns. Nothing of it is ever under the clear bar or the status bar, at rest, while pulling or
  // while bouncing back. The window is clipped and moved by transforms (no layout per frame): it is
  // `pullDownHeight` tall above the content, slid down by what is not revealed, and the header inside is
  // slid back up so it stays anchored to the content's top (bottom first: the crew, then the text).
  const pullWindow = useAnimatedStyle(() => {
    const shown = Math.min(Math.max(-y.value - PULL_ROOM, 0), pullDownHeight);
    return {
      opacity: shown > 0 ? progress(shown, 0, PULL_FADE) : 0,
      transform: [{ translateY: pullDownHeight - shown }],
    };
  });
  const pullAnchor = useAnimatedStyle(() => {
    const shown = Math.min(Math.max(-y.value - PULL_ROOM, 0), pullDownHeight);
    return { transform: [{ translateY: shown - pullDownHeight }] };
  });
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
              style={[styles.pullDown, { top: -pullDownHeight, height: pullDownHeight }, pullWindow]}
              pointerEvents="box-none"
            >
              <Animated.View style={[styles.pullDownContent, { height: pullDownHeight }, pullAnchor]}>
                {pullDown}
              </Animated.View>
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
/**
 * The top of the pulled strip stays clear for the refresh spinner (UIRefreshControl is 60pt tall and the
 * list rests pulled by that much while refreshing), so the header never covers it.
 */
const PULL_ROOM = 64;
/** The pull-down header fades in over its first stretch revealed. */
const PULL_FADE = 56;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  head: { paddingHorizontal: 20, paddingTop: 2, paddingBottom: 10 },
  subtitle: { marginTop: 2 },
  pullDown: { position: "absolute", left: 0, right: 0, overflow: "hidden" },
  pullDownContent: { position: "absolute", left: 0, right: 0, top: 0 },
});
