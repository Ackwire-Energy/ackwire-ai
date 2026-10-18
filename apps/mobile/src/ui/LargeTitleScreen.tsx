import { type NativeStackNavigationOptions, Stack, useIsFocused } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { type ReactElement, type ReactNode, useMemo, useState } from "react";
import { Platform, type RefreshControlProps, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LivePause } from "@/agent/live";
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
   * A header above the large title (Conversas: the greeting over the sky), part of the content: seen at rest,
   * it scrolls away with the list. It gets `reach`, how far its art should extend up behind the clear bar.
   */
  header?: (reach: number) => ReactNode;
  children?: ReactNode;
  refreshControl?: ReactElement<RefreshControlProps>;
  /** Room under the content (default 24; the system already keeps content clear of the tab bar). */
  bottomInset?: number;
  /** The person starts scrolling the list (Conversas closes its open "Esperando você" card). */
  onScrollBeginDrag?: () => void;
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
  header,
  children,
  refreshControl,
  bottomInset = 24,
  onScrollBeginDrag,
}: LargeTitleScreenProps) {
  const { colors } = useTheme();
  const focused = useIsFocused();
  const headerHeight = useHeaderHeight();
  const safe = useSafeAreaInsets();
  // On iOS the scroll view is inset by the clear bar ourselves (contentInset, resting at minus the header
  // height): the automatic adjustment didn't apply inside the system tabs, so the list rested under the bar
  // with the large title hidden, shown only while pulled. Android lays it out from the top, under the bar.
  const { y, onScroll } = useCoverScroll(IOS ? headerHeight : 0);
  // The header's height: the large title (and the bar's title) start below it.
  const [headerH, setHeaderH] = useState(0);
  const titleFade = useScrollFade(y, headerH, headerH + TITLE_GONE);
  const actionOptions = useHeaderActionOptions({ right: actions, left, leftActions });
  // Stable options: `setOptions` runs when the title or the actions change, not on every render.
  const options = useMemo<NativeStackNavigationOptions>(
    () => ({
      ...actionOptions,
      title,
      headerTitle: () => (
        <FadingHeaderTitle y={y} from={headerH + BAR_TITLE_FROM} to={headerH + BAR_TITLE_TO} text={title} />
      ),
    }),
    [actionOptions, title, y, headerH],
  );
  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      <Stack.Screen options={options} />
      <LivePause paused={!focused}>
        <Animated.ScrollView
          onScroll={onScroll}
          onScrollBeginDrag={onScrollBeginDrag}
          scrollEventThrottle={16}
          refreshControl={refreshControl}
          contentInsetAdjustmentBehavior="never"
          {...(IOS
            ? {
                contentInset: { top: headerHeight, bottom: safe.bottom + TAB_BAR },
                scrollIndicatorInsets: { top: headerHeight, bottom: safe.bottom + TAB_BAR },
                contentOffset: { x: 0, y: -headerHeight },
              }
            : {})}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingTop: IOS ? 0 : headerHeight, paddingBottom: bottomInset }}
        >
          {header ? (
            <View
              style={IOS ? { marginTop: -headerHeight, paddingTop: headerHeight } : undefined}
              onLayout={(e) => setHeaderH(e.nativeEvent.layout.height - (IOS ? headerHeight : 0))}
            >
              {header(IOS ? headerHeight : 0)}
            </View>
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
      <CoverBarBackdrop y={y} from={Math.max(0, headerH - 40)} to={headerH + 12} height={headerHeight} />
    </View>
  );
}

const IOS = Platform.OS === "ios";
/** Room for the system tab bar over the list's end (iOS; the bar floats over the content). */
const TAB_BAR = 56;

/** Scroll (from rest) by which the large title has faded out under the bar. */
const TITLE_GONE = 40;
/** The bar's title fades in over this stretch, as the large title leaves. */
const BAR_TITLE_FROM = 28;
const BAR_TITLE_TO = 48;

const styles = StyleSheet.create({
  screen: { flex: 1 },
  head: { paddingHorizontal: 20, paddingTop: 2, paddingBottom: 10 },
  subtitle: { marginTop: 2 },
});
